import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeAbiParameters, hexToBytes, keccak256, type Hex } from "viem";
import {
  P256_N,
  WEBAUTHN_AUTH_ABI,
  base64UrlEncode,
  buildWebAuthnAuth,
  encodeWebAuthnAuth,
  normalizeS,
  p256FromSpki,
  parseDerSignature,
} from "./webauthn";

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

function fakeAssertion(challenge: Hex) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: base64UrlEncode(hexToBytes(challenge)),
      origin: "http://localhost:3000",
      crossOrigin: false,
    }),
  );
  // rpIdHash(32) | flags (UP|UV = 0x05) | signCount(4)
  const authenticatorData = new Uint8Array(37);
  authenticatorData.set(sha256(new TextEncoder().encode("localhost")), 0);
  authenticatorData[32] = 0x05;
  const message = new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]);
  const signature = new Uint8Array(sign("sha256", message, { key: privateKey, dsaEncoding: "der" }));
  return { spki, publicKey, clientDataJSON, authenticatorData, signature, message };
}

describe("webauthn encoding", () => {
  it("extracts x/y from SPKI", () => {
    const { spki } = fakeAssertion(keccak256("0x01"));
    const { x, y } = p256FromSpki(spki);
    expect(x).toMatch(/^0x[0-9a-f]{64}$/);
    expect(y).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("normalizes s to the low half", () => {
    expect(normalizeS(P256_N - 1n)).toBe(1n);
    expect(normalizeS(5n)).toBe(5n);
  });

  it("builds a verifiable OZ WebAuthnAuth with indices and low-s", () => {
    const challenge = keccak256("0xdeadbeef");
    for (let k = 0; k < 8; k++) {
      const a = fakeAssertion(challenge);
      const auth = buildWebAuthnAuth(a);
      expect(BigInt(auth.s) <= P256_N / 2n).toBe(true);
      const json = auth.clientDataJSON;
      expect(json.slice(Number(auth.typeIndex)).startsWith('"type":"webauthn.get"')).toBe(true);
      expect(
        json.slice(Number(auth.challengeIndex)).startsWith(`"challenge":"${base64UrlEncode(hexToBytes(challenge))}"`),
      ).toBe(true);
      // the normalized signature still verifies against the same key
      const rs = new Uint8Array([...hexToBytes(auth.r), ...hexToBytes(auth.s)]);
      expect(verify("sha256", a.message, { key: a.publicKey, dsaEncoding: "ieee-p1363" }, rs)).toBe(true);
    }
  });

  it("abi-encodes in OZ field order (r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON)", () => {
    const a = fakeAssertion(keccak256("0x02"));
    const auth = buildWebAuthnAuth(a);
    const [decoded] = decodeAbiParameters(WEBAUTHN_AUTH_ABI, encodeWebAuthnAuth(auth));
    expect(decoded).toEqual(auth);
    expect(WEBAUTHN_AUTH_ABI[0].components.map((c) => c.name)).toEqual([
      "r",
      "s",
      "challengeIndex",
      "typeIndex",
      "authenticatorData",
      "clientDataJSON",
    ]);
  });

  it("parses DER with leading zero padding", () => {
    const der = new Uint8Array([0x30, 0x08, 0x02, 0x02, 0x00, 0x81, 0x02, 0x02, 0x00, 0x82]);
    const { r, s } = parseDerSignature(der);
    expect(BigInt(r)).toBe(0x81n);
    expect(BigInt(s)).toBe(0x82n);
  });
});
