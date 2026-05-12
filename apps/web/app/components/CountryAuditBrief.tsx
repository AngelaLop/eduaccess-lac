'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface BriefRow {
  country_iso: string;
  brief_text: string;
  model: string;
  prompt_version: number;
  facts_version: number;
  generated_at: string;
}

interface Props {
  countryIso: string;
}

/**
 * Country Audit Brief — one paragraph at the top of the Insight landing.
 *
 * Reads the latest row from country_audit_briefs for the country. Includes
 * a tiny "How we computed this" disclosure listing model + versions +
 * generated date, so a reader can tell whether the text is current.
 *
 * Quiet styling on purpose: this is data the user reads, not a CTA.
 */
export default function CountryAuditBrief({ countryIso }: Props) {
  const [brief, setBrief] = useState<BriefRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [showProvenance, setShowProvenance] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    supabase
      .from('country_audit_briefs')
      .select('country_iso, brief_text, model, prompt_version, facts_version, generated_at')
      .eq('country_iso', countryIso)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error('[CountryAuditBrief]', error);
        setBrief((data as BriefRow | null) ?? null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [countryIso]);

  if (loading) {
    return (
      <section className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
        <div className="h-2 w-24 animate-pulse rounded bg-neutral-200" />
        <div className="mt-2 h-2 w-full animate-pulse rounded bg-neutral-200" />
        <div className="mt-1 h-2 w-5/6 animate-pulse rounded bg-neutral-200" />
        <div className="mt-1 h-2 w-3/4 animate-pulse rounded bg-neutral-200" />
      </section>
    );
  }

  if (!brief) {
    return null;
  }

  const generated = new Date(brief.generated_at);
  const generatedLabel = isNaN(generated.getTime())
    ? null
    : generated.toISOString().slice(0, 10);

  return (
    <section className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        Data trust brief
      </p>
      <p className="mt-2 text-[13px] leading-relaxed text-neutral-700">
        {brief.brief_text}
      </p>
      <button
        type="button"
        onClick={() => setShowProvenance((v) => !v)}
        className="mt-2 text-[10px] text-neutral-400 underline-offset-2 hover:text-neutral-600 hover:underline"
      >
        {showProvenance ? 'Hide' : 'How we computed this'}
      </button>
      {showProvenance && (
        <p className="mt-1 text-[10px] leading-snug text-neutral-400">
          Written by {brief.model} on {generatedLabel ?? 'unknown date'} from
          aggregated numeric robustness scores across all district × age-group ×
          transport-mode cells. Facts v{brief.facts_version} · prompt v
          {brief.prompt_version}.
        </p>
      )}
    </section>
  );
}
