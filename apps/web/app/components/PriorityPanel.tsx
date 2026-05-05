'use client';

import type { PriorityRow } from '@/lib/types';

interface DistrictMeta {
  nomb_dist: string;
  nomb_prov: string;
}

interface Props {
  rows: PriorityRow[];                              // already sorted by rank
  meta: Record<string, DistrictMeta>;               // cod_dist → name + province
  narrative: string;                                // e.g., "high schoolers"
  mode: string;                                     // e.g., "walking"
  onSelectDist: (cod: string) => void;
}

/**
 * Plain-English "why" line per row, derived from the inputs that produced the
 * priority score. Picks the dominant driver (largest underserved, severe
 * access gap, low confidence pulling it down) and frames the row accordingly.
 */
function interpret(row: PriorityRow, peers: PriorityRow[], narrative: string): string {
  const maxUnderserved = Math.max(...peers.map((p) => p.children_underserved), 1);
  const isLargestStakes = row.children_underserved === maxUnderserved && peers.length > 1;
  const isSevereAccess = row.pct_le30 < 30;
  const isLowConfidence = row.robustness < 60;
  const isHighConfidence = row.robustness >= 80;

  if (isSevereAccess && isHighConfidence) {
    return `Only ${row.pct_le30}% reach a school within 30 min — severe access gap, high confidence in the number.`;
  }
  if (isLargestStakes && isHighConfidence) {
    return `Largest underserved population in this list (${row.children_underserved.toLocaleString()} ${narrative}), with high confidence in the data.`;
  }
  if (isLargestStakes) {
    return `Largest stakes here (${row.children_underserved.toLocaleString()} ${narrative}); confidence is moderate (${Math.round(row.robustness)}/100).`;
  }
  if (isLowConfidence) {
    return `${row.children_underserved.toLocaleString()} ${narrative} in a high-gap district, but the number is uncertain — verify before acting.`;
  }
  if (isSevereAccess) {
    return `Only ${row.pct_le30}% within 30 min — wide access gap drives the score.`;
  }
  return `Combined ${row.children_underserved.toLocaleString()} ${narrative} underserved with a ${Math.round(100 - row.pct_le30)}-point access gap.`;
}

export default function PriorityPanel({
  rows,
  meta,
  narrative,
  mode,
  onSelectDist,
}: Props) {
  if (rows.length === 0) return null;

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Top priority for {narrative}
        </p>
      </div>
      <p className="mb-2 text-[11px] leading-snug text-neutral-500">
        Ranked by combining absolute underserved population × access gap × confidence in
        the underlying numbers. Districts with low confidence are pushed down.
      </p>
      <ol className="space-y-1.5">
        {rows.map((entry, i) => {
          const m = meta[entry.cod_dist];
          const why = interpret(entry, rows, narrative);
          return (
            <li key={entry.cod_dist}>
              <button
                onClick={() => onSelectDist(entry.cod_dist)}
                className="block w-full rounded-md border border-neutral-200 px-3 py-2 text-left transition-colors hover:bg-neutral-50"
              >
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <div className="min-w-0 truncate">
                    <span className="mr-1.5 text-xs text-neutral-400">{i + 1}.</span>
                    <span className="text-sm font-medium text-neutral-800">
                      {m?.nomb_dist ?? entry.cod_dist}
                    </span>
                    {m?.nomb_prov && (
                      <span className="ml-1 text-xs text-neutral-400">{m.nomb_prov}</span>
                    )}
                  </div>
                  <span className="shrink-0 text-sm font-bold text-emerald-700">
                    {Math.round(entry.score)}
                  </span>
                </div>
                <div className="mb-1.5 h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                  <div
                    className="h-full rounded-full bg-emerald-600"
                    style={{ width: `${Math.max(entry.score, 2)}%` }}
                  />
                </div>
                <p className="text-[11px] leading-snug text-neutral-700">{why}</p>
                <p className="mt-0.5 text-[10px] text-neutral-400">
                  {entry.children_underserved.toLocaleString()} underserved · {entry.pct_le30}%
                  within 30 min by {mode} · confidence {Math.round(entry.robustness)}/100
                </p>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
