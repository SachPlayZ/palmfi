"use client";

import { useState } from "react";
import { isHex, zeroAddress, type Hex } from "viem";
import { useReadContract } from "wagmi";
import { sepolia } from "wagmi/chains";
import { vaultAbi, vaultFactoryAbi } from "@/abi";
import { deployments } from "@/lib/deployments";
import { network } from "@/lib/network";
import { TxStatus, useTx } from "@/lib/tx";
import type { VaultView } from "@/lib/vault";
import { Button, Card, Field, Input, Notice } from "../ui";
import { fmtAmount, safeParse, useRoles } from "./common";

/** ETH → USDC inside the Vault at a Chainlink-checked minimum, using no Instant budget. */
export function SafeHarborCard({ v }: { v: VaultView }) {
  const roles = useRoles(v);
  const tx = useTx();
  const [amount, setAmount] = useState("");
  const [route, setRoute] = useState("0x");
  const amt = safeParse(amount, 18);
  const swapper = useReadContract({ address: deployments.factory, abi: vaultFactoryAbi, functionName: "safeHarborSwapper", chainId: sepolia.id, query: { enabled: !!deployments.factory } });
  const minOut = useReadContract({
    address: v.vault,
    abi: vaultAbi,
    functionName: "safeHarborMinOut",
    args: [amt ?? 0n],
    chainId: sepolia.id,
    query: { enabled: !!amt && !!v.vault },
  });
  const eth = v.assets.find((a) => a.underlying.toLowerCase() === network.tokens.weth.toLowerCase());
  const usdc = v.assets.find((a) => a.underlying.toLowerCase() === network.tokens.usdc.toLowerCase());
  const mine = eth?.balances.find((b) => b.wallet.toLowerCase() === roles.address?.toLowerCase())?.balance ?? 0n;
  const noSwapper = swapper.isSuccess && swapper.data === zeroAddress;
  return (
    <Card title="Safe-harbor swap: ETH → USDC">
      <p className="mb-2 text-xs text-[var(--subtle)]">
        Stays inside your Vault, priced against Chainlink (2% max slippage in Normal mode, 5% in Volatile), and uses no Instant budget.
      </p>
      {noSwapper && <Notice tone="amber">The Safe-harbor swapper isn&apos;t wired on this deployment yet.</Notice>}
      <div className="mt-2 flex flex-col gap-2">
        <Field label={`Amount of ${eth?.symbol ?? "ETH Protected token"}`} hint={eth ? `This Hot wallet holds ${fmtAmount(mine, 18)}` : undefined}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
        </Field>
        {minOut.data !== undefined && usdc && (
          <p className="tabular text-sm">
            Minimum out: {fmtAmount(minOut.data, usdc.decimals, 2)} {usdc.symbol}
          </p>
        )}
        <details>
          <summary className="cursor-pointer text-xs text-[var(--subtle)]">Route (advanced)</summary>
          <Input value={route} onChange={(e) => setRoute(e.target.value)} className="mt-1 w-full" />
        </details>
        <Button
          disabled={!roles.isHot || !amt || noSwapper || !isHex(route) || tx.busy}
          onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "safeHarborSwap", args: [amt!, route as Hex] }, "Safe-harbor swap")}
        >
          Swap to USDC
        </Button>
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}
