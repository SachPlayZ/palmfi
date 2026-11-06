"use client";

import { OnboardForm } from "@/components/onboard-form";

export default function OnboardPage() {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Create your Vault</h1>
        <p className="text-sm text-[var(--subtle)]">
          One transaction: your Vault, your Protected USDC token, its seat in the Orbital pool and your name.
        </p>
      </div>
      <OnboardForm />
    </>
  );
}
