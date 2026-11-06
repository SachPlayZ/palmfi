/**
 * Passkey Second factor (WebAuthn, platform authenticator) for Individuals.
 *
 * The Vault verifies with OpenZeppelin WebAuthn.verify(abi.encodePacked(requestHash), auth, x, y) with UV required.
 * The challenge is the raw 32-byte request hash; the browser base64url-encodes it into clientDataJSON.
 * `auth` is abi-encoded OZ `WebAuthn.WebAuthnAuth` in its declared field order:
 *   (bytes32 r, bytes32 s, uint256 challengeIndex, uint256 typeIndex, bytes authenticatorData, string clientDataJSON)
 */
import { bytesToHex, encodeAbiParameters, hexToBytes, type Hex } from "viem";

/** secp256r1 group order. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_N = P256_N / 2n;

export const WEBAUTHN_AUTH_ABI = [
  {
    type: "tuple",
    components: [
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
      { name: "challengeIndex", type: "uint256" },
      { name: "typeIndex", type: "uint256" },
      { name: "authenticatorData", type: "bytes" },
      { name: "clientDataJSON", type: "string" },
    ],
  },
] as const;

export type WebAuthnAuth = {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
};

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBigInt(bytes: Uint8Array): bigint {
  return bytes.length ? BigInt(bytesToHex(bytes)) : 0n;
}

function toBytes32(v: bigint): Hex {
  return `0x${v.toString(16).padStart(64, "0")}`;
}

/** Parses a DER ECDSA signature (WebAuthn assertion format) into r, s with s normalized to the low half. */
export function parseDerSignature(der: Uint8Array): { r: Hex; s: Hex } {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error("bad DER: no sequence");
  let len = der[i++];
  if (len & 0x80) i += len & 0x7f; // long-form length (never for P-256, but be lenient)
  if (der[i++] !== 0x02) throw new Error("bad DER: no r");
  len = der[i++];
  const r = toBigInt(der.slice(i, i + len));
  i += len;
  if (der[i++] !== 0x02) throw new Error("bad DER: no s");
  len = der[i++];
  const s = toBigInt(der.slice(i, i + len));
  return { r: toBytes32(r), s: toBytes32(normalizeS(s)) };
}

export function normalizeS(s: bigint): bigint {
  return s > HALF_N ? P256_N - s : s;
}

/** Extracts the uncompressed P-256 point from SPKI DER (AuthenticatorAttestationResponse.getPublicKey()). */
export function p256FromSpki(spki: Uint8Array): { x: Hex; y: Hex } {
  // P-256 SPKI ends with the 65-byte uncompressed point 0x04 || x || y.
  const pt = spki.slice(spki.length - 65);
  if (pt[0] !== 0x04) throw new Error("not an uncompressed P-256 key");
  return { x: bytesToHex(pt.slice(1, 33)), y: bytesToHex(pt.slice(33, 65)) };
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Builds the OZ WebAuthnAuth struct from raw assertion response pieces. */
export function buildWebAuthnAuth(parts: {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}): WebAuthnAuth {
  const enc = new TextEncoder();
  const challengeIndex = indexOfBytes(parts.clientDataJSON, enc.encode('"challenge":"'));
  const typeIndex = indexOfBytes(parts.clientDataJSON, enc.encode('"type":"'));
  if (challengeIndex < 0 || typeIndex < 0) throw new Error("clientDataJSON missing challenge/type");
  const { r, s } = parseDerSignature(parts.signature);
  return {
    r,
    s,
    challengeIndex: BigInt(challengeIndex),
    typeIndex: BigInt(typeIndex),
    authenticatorData: bytesToHex(parts.authenticatorData),
    clientDataJSON: new TextDecoder().decode(parts.clientDataJSON),
  };
}

export function encodeWebAuthnAuth(auth: WebAuthnAuth): Hex {
  return encodeAbiParameters(WEBAUTHN_AUTH_ABI, [auth]);
}

// ---------------------------------------------------------------------------
// Browser calls
// ---------------------------------------------------------------------------

const CRED_KEY = "palmfi.passkeys";

type StoredPasskey = { credentialId: string; x: Hex; y: Hex; createdAt: number; label: string };

export function storedPasskeys(): StoredPasskey[] {
  try {
    return JSON.parse(localStorage.getItem(CRED_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function rememberPasskey(p: StoredPasskey) {
  try {
    localStorage.setItem(CRED_KEY, JSON.stringify([...storedPasskeys().filter((q) => q.x !== p.x), p]));
  } catch {
    /* storage unavailable: discoverable credentials still work */
  }
}

export function webAuthnSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;
}

/** Creates a platform passkey (Face ID / Touch ID) and returns its P-256 public key. */
export async function createPasskey(label: string): Promise<{ x: Hex; y: Hex; credentialId: string }> {
  if (!webAuthnSupported()) throw new Error("This browser doesn't support passkeys");
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "palmfi", id: window.location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: `${label}`,
        displayName: `palmfi ${label}`,
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 = P-256
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "preferred",
      },
      attestation: "none",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey creation was cancelled");
  const resp = cred.response as AuthenticatorAttestationResponse;
  const spki = resp.getPublicKey?.();
  if (!spki) throw new Error("Authenticator did not return a public key");
  if (resp.getPublicKeyAlgorithm?.() !== undefined && resp.getPublicKeyAlgorithm() !== -7) {
    throw new Error("Authenticator returned a non-P-256 key");
  }
  const { x, y } = p256FromSpki(new Uint8Array(spki));
  const credentialId = base64UrlEncode(new Uint8Array(cred.rawId));
  rememberPasskey({ credentialId, x, y, createdAt: Date.now(), label });
  return { x, y, credentialId };
}

/** Signs a 32-byte challenge (request hash / unfreeze challenge) and returns the abi-encoded WebAuthnAuth. */
export async function signWithPasskey(challenge: Hex, passkey?: { x: Hex; y: Hex }): Promise<Hex> {
  if (!webAuthnSupported()) throw new Error("This browser doesn't support passkeys");
  const known = storedPasskeys().filter(
    (p) => !passkey || (p.x.toLowerCase() === passkey.x.toLowerCase() && p.y.toLowerCase() === passkey.y.toLowerCase()),
  );
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: new Uint8Array(hexToBytes(challenge)),
      rpId: window.location.hostname,
      userVerification: "required",
      allowCredentials: known.map((p) => ({ type: "public-key" as const, id: base64UrlDecode(p.credentialId) })),
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error("Passkey confirmation was cancelled");
  const r = assertion.response as AuthenticatorAssertionResponse;
  const auth = buildWebAuthnAuth({
    authenticatorData: new Uint8Array(r.authenticatorData),
    clientDataJSON: new Uint8Array(r.clientDataJSON),
    signature: new Uint8Array(r.signature),
  });
  return encodeWebAuthnAuth(auth);
}
