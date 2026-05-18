/**
 * Country Audit Brief — the one high-leverage LLM call per refresh.
 *
 * Reads the just-written robustness_reports for a country, aggregates a
 * compact statistical summary, hands it to the LLM, and asks for ONE
 * paragraph (~120 words) summarizing where the country's data is strong,
 * where it is weak, and what a minister should trust.
 *
 * Token budget: ~2K in / 200 out per country per refresh. Comfortably
 * inside Groq free tier.
 */

import { sb } from './supabase.js';
import { groq, MODEL } from './llm.js';

export const PROMPT_VERSION = 2; // v4: 3-dimension robustness model

const SYSTEM_PROMPT = `
You are the Country Audit Brief writer for the EduAccess LAC platform.

You receive aggregated robustness statistics for a Latin American country's
school-accessibility indicators. You write ONE paragraph (90-130 words,
single paragraph, no bullets) for a non-technical reader — a ministry
director who needs to know which numbers on the platform they can act on
and which they should treat as exploratory.

Style: plain language, name specific weaknesses with numbers when
relevant, avoid jargon. Do NOT recommend policies or interventions — that
is a separate agent. Only describe data trust.

Always cover three things in this order:
1. The headline trust level for the country (high / moderate / mixed / low),
   anchored to median overall score across all cells.
2. The single biggest structural weakness, identified by the dimension
   most often "weakest" across cells, with one concrete number. The
   dimensions are: data completeness, sample size, and method agreement
   (how closely the FMM and OSRM routing methods agree).
3. What a director should and should not conclude from these indicators.

Output PLAIN TEXT only. No JSON. No markdown. One paragraph.
`.trim();

interface BriefInputStats {
  country_iso: string;
  cell_count: number;
  median_overall: number;
  p25_overall: number;
  p75_overall: number;
  pct_high_trust: number;
  pct_low_trust: number;
  weakest_dimension_counts: Record<string, number>;
  avg_data_completeness: number;
  avg_sample_size: number;
  avg_method_agreement: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

async function loadStats(countryIso: string, auditRunId: string): Promise<BriefInputStats> {
  const { data, error } = await sb
    .from('robustness_reports')
    .select(
      'score_overall, score_data_completeness, score_sample_size, score_method_agreement, weakest_dimension'
    )
    .eq('audit_run_id', auditRunId)
    .eq('country_iso', countryIso);
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error('country brief: no robustness_reports found for this run');
  }

  const overalls = data.map((r) => Number(r.score_overall)).sort((a, b) => a - b);
  const cell_count = overalls.length;
  const pct_high_trust = (overalls.filter((s) => s >= 70).length / cell_count) * 100;
  const pct_low_trust = (overalls.filter((s) => s < 40).length / cell_count) * 100;

  const weakestCounts: Record<string, number> = {};
  let sumCompleteness = 0;
  let sumSample = 0;
  let sumMethod = 0;
  for (const r of data) {
    const w = String(r.weakest_dimension);
    weakestCounts[w] = (weakestCounts[w] ?? 0) + 1;
    sumCompleteness += Number(r.score_data_completeness);
    sumSample += Number(r.score_sample_size);
    sumMethod += Number(r.score_method_agreement);
  }

  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    country_iso: countryIso,
    cell_count,
    median_overall: r1(percentile(overalls, 50)),
    p25_overall: r1(percentile(overalls, 25)),
    p75_overall: r1(percentile(overalls, 75)),
    pct_high_trust: r1(pct_high_trust),
    pct_low_trust: r1(pct_low_trust),
    weakest_dimension_counts: weakestCounts,
    avg_data_completeness: r1(sumCompleteness / cell_count),
    avg_sample_size: r1(sumSample / cell_count),
    avg_method_agreement: r1(sumMethod / cell_count),
  };
}

function formatUserPrompt(stats: BriefInputStats): string {
  const weakestSummary = Object.entries(stats.weakest_dimension_counts)
    .sort((a, b) => b[1] - a[1])
    .map(([dim, n]) => `${dim}: ${n} cells (${((n / stats.cell_count) * 100).toFixed(0)}%)`)
    .join('; ');

  return [
    `Country: ${stats.country_iso}`,
    `Cells analyzed: ${stats.cell_count}`,
    `Overall trust score — median ${stats.median_overall}, p25 ${stats.p25_overall}, p75 ${stats.p75_overall}`,
    `High-trust cells (overall ≥ 70): ${stats.pct_high_trust}%`,
    `Low-trust cells (overall < 40): ${stats.pct_low_trust}%`,
    `Dimension averages — completeness: ${stats.avg_data_completeness}, sample: ${stats.avg_sample_size}, method-agreement: ${stats.avg_method_agreement}`,
    `Weakest-dimension distribution — ${weakestSummary}`,
  ].join('\n');
}

interface WriteOpts {
  countryIso: string;
  auditRunId: string;
  factsVersion: number;
  promptVersion: number;
}

export async function writeCountryAuditBrief(opts: WriteOpts): Promise<void> {
  const stats = await loadStats(opts.countryIso, opts.auditRunId);

  const completion = await groq.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    max_tokens: 400,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: formatUserPrompt(stats) },
    ],
  });

  const brief = completion.choices[0]?.message?.content?.trim();
  if (!brief) throw new Error('country brief: empty LLM response');

  const { error } = await sb.from('country_audit_briefs').insert({
    country_iso: opts.countryIso,
    brief_text: brief,
    model: MODEL,
    prompt_version: opts.promptVersion,
    facts_version: opts.factsVersion,
    audit_run_id: opts.auditRunId,
  });
  if (error) throw error;
}
