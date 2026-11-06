import Link from "next/link";
import { Shell } from "@/components/shell";
import { HillsBand } from "@/components/brand";

export default function NotFound() {
  return (
    <Shell>
      <HillsBand className="px-6 pt-20 pb-[min(30vw,320px)] text-center">
        <span className="pf-mono pf-dim">404</span>
        <h1 className="pf-h1 mt-3">
          Nothing <em>here.</em>
        </h1>
        <p className="mx-auto mt-4 max-w-[44ch] text-[16px] text-[var(--ink-2)]">The page moved or never existed. Your vaults are where you left them.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Link className="pf-btn dark" href="/inbox">
            Go to inbox
          </Link>
          <Link className="pf-btn line" href="/">
            Home
          </Link>
        </div>
      </HillsBand>
    </Shell>
  );
}
