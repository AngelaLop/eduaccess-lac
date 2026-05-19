'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { CountryIso, EducationLevel, TransportMode } from '@/lib/types';
import { EDUCATION_LEVEL_SHORT_LABELS, TRANSPORT_LABELS } from '@/lib/types';

/**
 * EquityGapCard — the "Access gaps" card on the country-level Insight landing.
 *
 * Reads v_equity (country grain) and shows two headline gaps: urban vs rural,
 * and wealthiest vs poorest income quintile. Each gap is the endpoint pair
 * plus the point difference. A dimension with no data is simply omitted; a
 * country with no equity breakdown at all renders nothing.
 *
 * Country-grain only — income quintiles do not exist per district, and the
 * national figure is the policy-relevant comparison anyway.
 */

interface EquityRow {
  dimension: string;
  category: string;
  pct_le30: number | null;
}

interface Gap {
  highLabel: string;
  highPct: number;
  lowLabel: string;
  lowPct: number;
}

interface Props {
  country: CountryIso;
  level: EducationLevel;
  transport: TransportMode;
}

// One gap = the best-served vs worst-served end of a breakdown dimension.
function buildGap(
  rows: EquityRow[],
  dimension: string,
  high: { code: string; label: string },
  low: { code: string; label: string }
): Gap | null {
  const pick = (code: string) =>
    rows.find((r) => r.dimension === dimension && r.category === code)?.pct_le30;
  const hi = pick(high.code);
  const lo = pick(low.code);
  if (hi == null || lo == null) return null;
  return { highLabel: high.label, highPct: hi, lowLabel: low.label, lowPct: lo };
}

export default function EquityGapCard({ country, level, transport }: Props) {
  const [gaps, setGaps] = useState<Gap[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGaps(null);
    supabase
      .from('v_equity')
      .select('dimension, category, pct_le30')
      .eq('country_iso', country)
      .eq('idgeo', 'country')
      .eq('education_level', level)
      .eq('mode', transport)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('[EquityGapCard] v_equity:', error);
          setGaps([]);
          return;
        }
        const rows = (data as EquityRow[]) ?? [];
        const built = [
          buildGap(
            rows,
            'area',
            { code: 'urban', label: 'Urban' },
            { code: 'rural', label: 'Rural' }
          ),
          buildGap(
            rows,
            'income',
            { code: 'quintile_5', label: 'Wealthiest' },
            { code: 'quintile_1', label: 'Poorest' }
          ),
        ].filter((g): g is Gap => g !== null);
        setGaps(built);
      });
    return () => {
      cancelled = true;
    };
  }, [country, level, transport]);

  // Nothing until the data lands, and nothing if the country has no equity
  // breakdown at all — the card simply does not appear.
  if (!gaps || gaps.length === 0) return null;

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        Access gaps · share within 30 min
      </p>

      <div className="mt-3 flex flex-col gap-3">
        {gaps.map((g) => (
          <div key={g.highLabel} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="w-[4.5rem] shrink-0 text-sm text-neutral-500">
                  {g.highLabel}
                </span>
                <span className="text-sm font-semibold text-neutral-900">
                  {g.highPct.toFixed(0)}%
                </span>
              </div>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span className="w-[4.5rem] shrink-0 text-sm text-neutral-500">
                  {g.lowLabel}
                </span>
                <span className="text-sm font-semibold text-neutral-900">
                  {g.lowPct.toFixed(0)}%
                </span>
              </div>
            </div>
            <span className="shrink-0 rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600">
              gap {Math.round(g.highPct - g.lowPct)} pts
            </span>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[11px] leading-snug text-neutral-400">
        National estimate · {EDUCATION_LEVEL_SHORT_LABELS[level].toLowerCase()} ·{' '}
        {TRANSPORT_LABELS[transport].toLowerCase()} · FMM routing
      </p>
    </div>
  );
}
