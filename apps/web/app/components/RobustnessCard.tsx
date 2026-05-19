'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type {
  EducationLevel,
  RobustnessDimension,
  RobustnessReport,
  TransportMode,
} from '@/lib/types';

interface Props {
  country_iso: string;
  admin2_pcode: string;
  education_level: EducationLevel;
  transport_mode: TransportMode;
}

const DIMENSION_LABELS: Record<RobustnessDimension, string> = {
  data_completeness: 'Data completeness',
  sample_size: 'Sample size',
  method_agreement: 'FMM vs OSRM agreement',
};

const DIMENSION_HELP: Record<RobustnessDimension, string> = {
  data_completeness: 'is the accessibility value present and valid for this cell?',
  sample_size: 'how many people in this education level, small is noisy',
  method_agreement: 'do the FMM and OSRM routing methods agree on % within 30 min?',
};

function scoreColor(score: number): string {
  if (score >= 80) return 'bg-emerald-600';
  if (score >= 60) return 'bg-emerald-500';
  if (score >= 40) return 'bg-amber-500';
  if (score >= 20) return 'bg-orange-500';
  return 'bg-red-600';
}

function scoreTextColor(score: number): string {
  if (score >= 60) return 'text-emerald-700';
  if (score >= 40) return 'text-amber-700';
  if (score >= 20) return 'text-orange-700';
  return 'text-red-700';
}

function DimensionBar({
  dim,
  value,
  isWeakest,
}: {
  dim: RobustnessDimension;
  value: number;
  isWeakest: boolean;
}) {
  return (
    <li>
      <div className="mb-0.5 flex items-baseline justify-between text-xs">
        <span className={isWeakest ? 'font-semibold text-neutral-800' : 'text-neutral-600'}>
          {DIMENSION_LABELS[dim]}
        </span>
        <span className={`font-mono ${scoreTextColor(value)}`}>{Math.round(value)}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
        <div
          className={`h-full rounded-full ${scoreColor(value)}`}
          style={{ width: `${Math.max(value, 2)}%` }}
        />
      </div>
      {isWeakest && (
        <p className="mt-0.5 text-[10px] text-neutral-400">{DIMENSION_HELP[dim]}</p>
      )}
    </li>
  );
}

export default function RobustnessCard({
  country_iso,
  admin2_pcode,
  education_level,
  transport_mode,
}: Props) {
  const [report, setReport] = useState<RobustnessReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReport(null);

    supabase
      .from('robustness_reports')
      .select(
        'country_iso, admin2_pcode, education_level, transport_mode, score_data_completeness, score_sample_size, score_method_agreement, score_overall, weakest_dimension, narrative, caveats, audit_run_id, computed_at'
      )
      .eq('country_iso', country_iso)
      .eq('admin2_pcode', admin2_pcode)
      .eq('education_level', education_level)
      .eq('transport_mode', transport_mode)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error('[RobustnessCard]', error);
        setReport(data as RobustnessReport | null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [country_iso, admin2_pcode, education_level, transport_mode]);

  if (loading) {
    return (
      <section className="rounded-md border border-neutral-100 bg-neutral-50 p-3">
        <div className="h-3 w-32 animate-pulse rounded bg-neutral-200" />
        <div className="mt-3 h-2 w-full animate-pulse rounded bg-neutral-200" />
        <div className="mt-2 h-2 w-full animate-pulse rounded bg-neutral-200" />
      </section>
    );
  }

  if (!report) {
    return (
      <section className="rounded-md border border-neutral-100 bg-neutral-50 p-3 text-xs">
        <p className="font-semibold text-neutral-700">How much can we trust this?</p>
        <p className="mt-1 text-neutral-500">
          Robustness profile not yet computed for this cell. The Auditor
          worker runs on data or rubric changes; it has not yet seen this
          scenario.
        </p>
        <p className="mt-2 text-neutral-400">
          Population: WorldPop 2023 · Routing: FMM (friction surface) + OSRM (road network)
        </p>
      </section>
    );
  }

  const dimensions: { dim: RobustnessDimension; value: number }[] = [
    { dim: 'data_completeness', value: report.score_data_completeness },
    { dim: 'sample_size', value: report.score_sample_size },
    { dim: 'method_agreement', value: report.score_method_agreement },
  ];

  const computedAt = new Date(report.computed_at);
  const computedDate = isNaN(computedAt.getTime())
    ? null
    : computedAt.toISOString().slice(0, 10);

  return (
    <section className="rounded-md border border-neutral-100 bg-neutral-50 p-3">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="text-sm font-semibold text-neutral-800">How much can we trust this?</p>
        <div className="flex items-baseline gap-1">
          <span className={`font-mono text-lg font-bold ${scoreTextColor(report.score_overall)}`}>
            {Math.round(report.score_overall)}
          </span>
          <span className="text-xs text-neutral-400">/100</span>
        </div>
      </div>

      <ul className="mb-3 space-y-2">
        {dimensions.map(({ dim, value }) => (
          <DimensionBar
            key={dim}
            dim={dim}
            value={value}
            isWeakest={dim === report.weakest_dimension}
          />
        ))}
      </ul>

      <p className="border-t border-neutral-100 pt-2 text-xs leading-relaxed text-neutral-700">
        {report.narrative}
      </p>

      {report.caveats.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] leading-snug text-neutral-500">
          {report.caveats.map((c, i) => (
            <li key={i}>· {c}</li>
          ))}
        </ul>
      )}

      <p className="mt-3 border-t border-neutral-100 pt-2 text-[10px] text-neutral-400">
        Computed by the Robustness Auditor
        {computedDate ? ` on ${computedDate}` : ''} · 3 numeric dimensions ·
        text generated from the scores by a rule-based explainer (no LLM
        on this cell)
      </p>
    </section>
  );
}
