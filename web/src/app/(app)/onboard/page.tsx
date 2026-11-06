import Link from "next/link";
import { Suspense } from "react";
import { OnboardWizard } from "@/components/onboard-wizard";
import { PageHead } from "@/components/brand";

export const metadata = { title: "Create a vault" };

const KINDS = [
  {
    k: "institution",
    label: "Institution",
    title: "For teams and organisations",
    body: "A shared treasury for your company, DAO or fund. Several teammates' wallets approve big payouts together.",
  },
  {
    k: "individual",
    label: "Individual",
    title: "For a personal wallet",
    body: "A protected vault for your own funds. Everyday spending is instant; big moves need a nod from your other wallets or people you trust.",
  },
] as const;

export default async function OnboardPage({ searchParams }: { searchParams: Promise<{ as?: string }> }) {
  const { as } = await searchParams;
  if (as === "institution" || as === "individual") {
    return (
      <Suspense>
        <OnboardWizard />
      </Suspense>
    );
  }
  return (
    <>
      <PageHead index="(Create a vault)" title="Who is this vault" em="for?" lede="Pick how you'll use palmfi. We'll tailor the setup to you." />
      <div className="grid gap-4 sm:grid-cols-2">
        {KINDS.map((c) => (
          <Link key={c.k} href={`/onboard?as=${c.k}`} className="pf-card flex flex-col gap-3 transition-transform hover:-translate-y-0.5" data-pf>
            <span className="pf-mono pf-dim">{c.label}</span>
            <h2 className="pf-h3">{c.title}</h2>
            <p className="text-[15px] text-[var(--subtle)]">{c.body}</p>
            <span className="pf-mono mt-auto">Continue →</span>
          </Link>
        ))}
      </div>
    </>
  );
}
