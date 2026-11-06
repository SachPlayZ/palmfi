"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { sepolia } from "wagmi/chains";
import { vaultFactoryAbi } from "@/abi";
import { OnboardForm } from "@/components/onboard-form";
import { Button, Card, Input, Notice } from "@/components/ui";
import { deployments } from "@/lib/deployments";
import { network } from "@/lib/network";

export default function InstitutionPage() {
  const router = useRouter();
  const { address } = useAccount();
  const [q, setQ] = useState("");
  const admin = useReadContract({ address: deployments.factory, abi: vaultFactoryAbi, functionName: "admin", chainId: sepolia.id, query: { enabled: !!deployments.factory } });
  const isAdmin = !!address && !!admin.data && admin.data.toLowerCase() === address.toLowerCase();
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Institution treasury</h1>
        <p className="text-sm text-[var(--subtle)]">
          Network transfers by name, payouts, Payout approval status, incident view and recovery for Member Institutions.
        </p>
      </div>
      <Card title="Open a treasury">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) router.push(`/vault/${encodeURIComponent(q.trim().toLowerCase())}`);
          }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`palantir.${network.ensParent}`} className="flex-1" aria-label="Institution name" />
          <Button type="submit">Open</Button>
        </form>
      </Card>
      <Card title="Onboard an Institution (palmfi admin)">
        <p className="mb-3 text-sm text-[var(--subtle)]">
          After offchain business verification, the palmfi admin onboards the Institution in one transaction: <code>verified=true</code> name, fail-closed
          config with an Approver, the coarse profile, and Member admission.
        </p>
        {isAdmin ? <OnboardForm mode="institution" /> : <Notice tone="gray">Connect the palmfi admin key to onboard an Institution.</Notice>}
      </Card>
    </>
  );
}
