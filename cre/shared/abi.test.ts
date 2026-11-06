import { describe, expect, test } from "bun:test";
import { toEventSignature, type AbiEvent, type AbiFunction } from "viem";
import { approvalBookAbi, hubAbi, hubEventsAbi, vaultAbi } from "./abi";

const src = async (p: string) => Bun.file(`${import.meta.dir}/../../contracts/src/${p}`).text();
const HUB = await src("Hub.sol");
// The Vault address serves Vault.sol, its VaultBase storage and (via delegatecall) VaultModule.sol.
const VAULT = (await Promise.all(["Vault.sol", "VaultBase.sol", "VaultModule.sol"].map(src))).join("\n");
const BOOK = await src("ApprovalBook.sol");

/** Canonical parameter types of a Solidity parameter list: drop names, `indexed`, data locations. */
const types = (params: string) =>
  params
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split(/\s+/)[0]);

const solEvent = (source: string, name: string) => {
  const m = source.match(new RegExp(`event\\s+${name}\\s*\\(([^)]*)\\)`, "s"));
  return m ? `${name}(${types(m[1]).join(",")})` : undefined;
};

const solFunctionInputs = (source: string, name: string) => {
  const m = source.match(new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)`, "s"));
  return m ? types(m[1]) : undefined;
};

const solStruct = (source: string, name: string) => {
  const m = source.match(new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`, "s"));
  return m
    ? [...m[1].replace(/\/\/[^\n]*/g, "").matchAll(/(\w+)\s+(\w+)\s*;/g)].map((x) => `${x[1]} ${x[2]}`)
    : undefined;
};

describe("Hub events match Hub.sol", () => {
  for (const e of hubEventsAbi as readonly AbiEvent[]) {
    test(e.name, () => {
      expect(toEventSignature(e)).toBe(solEvent(HUB, e.name)!);
    });
  }
});

describe("view function inputs match the Solidity sources", () => {
  const cases: [string, readonly AbiFunction[], string][] = [
    ["Hub.sol", hubAbi.filter((x) => x.type === "function") as AbiFunction[], HUB],
    ["Vault.sol", vaultAbi.filter((x) => x.type === "function") as AbiFunction[], VAULT],
    ["ApprovalBook.sol", approvalBookAbi.filter((x) => x.type === "function") as AbiFunction[], BOOK],
  ];
  for (const [file, fns, source] of cases) {
    for (const f of fns) {
      test(`${file} ${f.name}`, () => {
        const sol = solFunctionInputs(source, f.name);
        // public state variables / mappings have no `function` declaration: check they exist
        if (sol === undefined) expect(source).toMatch(new RegExp(`public\\s+${f.name}\\b|public ${f.name};`));
        else expect(f.inputs.map((i) => i.type)).toEqual(sol);
      });
    }
  }
});

describe("structs match", () => {
  const fields = (abi: readonly unknown[], fn: string) => {
    const f = (abi as AbiFunction[]).find((x) => x.type === "function" && x.name === fn)!;
    const out = f.outputs[0] as { components?: { type: string; name?: string }[]; type: string };
    const comps = out.type === "tuple[]" || out.type === "tuple" ? out.components! : [];
    return comps.map((c) => `${c.type} ${c.name}`);
  };
  test("Vault.Request", () => expect(fields(vaultAbi, "getRequest")).toEqual(solStruct(VAULT, "Request")!));
  test("Hub.OpenRequest", () => expect(fields(hubAbi, "openRequests")).toEqual(solStruct(HUB, "OpenRequest")!));
  test("ApprovalBook.Approval", () => expect(fields(approvalBookAbi, "get")).toEqual(solStruct(BOOK, "Approval")!));
});
