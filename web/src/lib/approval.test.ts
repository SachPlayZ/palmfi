import { describe, expect, it } from "vitest";
import { concat, decodeAbiParameters, encodeAbiParameters, hashTypedData, keccak256, recoverTypedDataAddress, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodePayoutSecondFactor, payoutTypedData } from "./approval";

const book = "0x00000000000000000000000000000000000000ab" as const;
const msg = {
  vault: "0x1111111111111111111111111111111111111111",
  requestHash: keccak256("0x01"),
  amount: 12_000_000n,
  asset: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  destination: "0x2222222222222222222222222222222222222222",
  expiry: 1_900_000_000n,
} as const;

describe("Payout approval", () => {
  it("matches ApprovalBook.payoutDigest (manual EIP-712 per the contract)", () => {
    const typeHash = keccak256(toHex("PayoutApproval(address vault,bytes32 requestHash,uint256 amount,address asset,address destination,uint64 expiry)"));
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint64" }],
        [typeHash, msg.vault, msg.requestHash, msg.amount, msg.asset, msg.destination, msg.expiry],
      ),
    );
    const domainHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
          keccak256(toHex("palmfi ApprovalBook")),
          keccak256(toHex("1")),
          11155111n,
          book,
        ],
      ),
    );
    const manual = keccak256(concat(["0x1901", domainHash, structHash]));
    expect(hashTypedData(payoutTypedData(book, 11155111, msg))).toBe(manual);
  });

  it("signs, recovers and encodes the Second factor", async () => {
    const approver = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const td = payoutTypedData(book, 11155111, msg);
    const sig = await approver.signTypedData(td);
    expect(await recoverTypedDataAddress({ ...td, signature: sig })).toBe(approver.address);
    const [expiry, raw] = decodeAbiParameters([{ type: "uint64" }, { type: "bytes" }], encodePayoutSecondFactor(msg.expiry, sig));
    expect(expiry).toBe(msg.expiry);
    expect(raw).toBe(sig);
  });
});
