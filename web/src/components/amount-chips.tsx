"use client";

import { formatUnits } from "viem";

const STEPS = [10, 20, 50];

/** Quick-fill chips under an amount field: +10 / +20 / +50 add to the current value, Max fills the balance. */
export function AmountChips({ value, onChange, max, decimals = 6 }: { value: string; onChange: (v: string) => void; max?: bigint; decimals?: number }) {
  const maxN = max !== undefined ? Number(formatUnits(max, decimals)) : undefined;
  const add = (n: number) => {
    const next = Math.round(((Number(value) || 0) + n) * 1e6) / 1e6;
    onChange(String(maxN !== undefined ? Math.min(next, maxN) : next));
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {STEPS.map((n) => (
        <button key={n} type="button" className="pf-chip" onClick={() => add(n)} disabled={maxN !== undefined && (Number(value) || 0) >= maxN}>
          +{n}
        </button>
      ))}
      {max !== undefined && (
        <button type="button" className="pf-chip" onClick={() => onChange(formatUnits(max, decimals))} disabled={max === 0n}>
          Max
        </button>
      )}
      {value && (
        <button type="button" className="pf-chip" onClick={() => onChange("")}>
          Clear
        </button>
      )}
    </div>
  );
}
