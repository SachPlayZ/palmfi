"use client";

import Link from "next/link";
import { EmptyState } from "@/components/brand";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="pf-card">
      <EmptyState
        glyph="wave"
        title="Something went sideways"
        body={
          <>
            The page hit an error while reading from Arc. Your funds aren&apos;t affected. {error.digest && <span className="pf-mono">ref {error.digest}</span>}
          </>
        }
        action={
          <div className="flex justify-center gap-2">
            <button className="pf-btn dark" onClick={reset}>
              Try again
            </button>
            <Link className="pf-btn line" href="/status">
              Check status
            </Link>
          </div>
        }
      />
    </div>
  );
}
