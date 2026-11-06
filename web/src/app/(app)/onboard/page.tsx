"use client";

import { OnboardForm } from "@/components/onboard-form";

export default function OnboardPage() {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Create your Vault</h1>
        <p className="text-sm text-[var(--subtle)]">
          One transaction from your normal wallet: your Vault, your Protected tokens, your Uniswap pool and your name.
        </p>
      </div>
      <OnboardForm mode="individual" />
    </>
  );
}
