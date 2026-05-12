/**
 * Country Audit Brief — the one high-leverage LLM call per refresh.
 *
 * Reads the just-written robustness_reports for a country, aggregates a
 * compact statistical summary, hands it to the LLM, and asks for ONE
 * paragraph (~120 words) summarizing:
 *   - where the country's data is strong
 *   - where it is weak
 *   - what a minister should trust and what they should not
 *
 * Why one paragraph, not per-cell prose: a minister reading 664 single-
 * cell sentences gets noise. A paragraph that names the one or two
 * structural weaknesses gives them what they need in 30 seconds. This is
 * the agentic artifact the TA's feedback was actually asking for.
 *
 * Token budget: ~2K in / 200 out per country per refresh. Comfortably
 * inside Groq free tier even at v3+ country counts.
 */

import { sb } from './supabase.js';
import { groq, MODEL } from './llm.js';

export const PROMPT_VERSION = 1;

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
   most often "weakest" across cells, with one concrete number.
3. What a director should and should not conclude from these indicators.

Output PLAIN TEXT only. No JSON. No markdown. One paragraph.
`.trim();

interface BriefInputStats {
  country_iso: string;
  cell_count: number;
  median_overall: number;
  p25_overall: number;
  p75_overall: number;
  pct_high_trust: number;       // share of cells with overall >= 70
  pct_low_trust: number;        // share of cells with overall < 40
  weakest_dimension_counts: Record<string, number>;
  avg_data_completeness: number;
  avg_friction_agreement: number;
  avg_pop_agreement: number;
  avg_sample_size: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

async function loadStats(countryIso: string, auditRunId: string): Promise<BriefInputStats> {
  // Note: v1-v3 only has Panama and the indicators table doesn't carry
  // country_iso yet, so we ignore countryIso here and pull every cell
  // from the just-finished run. When v3.5 adds a second country, we
  // filter by joining to a country column.
  void countryIso;

  const { data, error } = await sb
    .from('robustness_reports')
    .select(
      'score_overall, score_data_completeness, score_sample_size, score_friction_agreement, score_pop_agreement, weakest_dimension'
    )
    .eq('audit_run_id', auditRunId);
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error('country brief: no robustness_reports found for this run');
  }

  const overalls = data.map((r) => Number(r.score_overall)).sort((a, b) => a - b);
  const cell_count = overalls.length;
  const median_overall = percentile(overalls, 50);
  const p25_overall = percentile(overalls, 25);
  const p75_overall = percentile(overalls, 75);
  const pct_high_trust = (overalls.filter((s) => s >= 70).length / cell_count) * 100;
  const pct_low_trust = (overalls.filter((s) => s < 40).length / cell_count) * 100;

  const weakestCounts: Record<string, number> = {};
  let sumCompleteness = 0;
  let sumFriction = 0;
  let sumPop = 0;
  let sumSample = 0;
  for (const r of data) {
    const w = String(r.weakest_dimension);
    weakestCounts[w] = (weakestCounts[w] ?? 0) + 1;
    sumCompleteness += Number(r.score_data_completeness);
    sumFriction += Number(r.score_friction_agreement);
    sumPop += Number(r.score_pop_agreement);
    sumSample += Number(r.score_sample_size);
  }

  return {
    country_iso: 'PAN',
    cell_count,
    median_overall: Math.round(median_overall * 10) / 10,
    p25_overall: Math.round(p25_overall * 10) / 10,
    p75_overall: Math.round(p75_overall * 10) / 10,
    pct_high_trust: Math.round(pct_high_trust * 10) / 10,
    pct_low_trust: Math.round(pct_low_trust * 10) / 10,
    weakest_dimension_counts: weakestCounts,
    avg_data_completeness: Math.round((sumCompleteness / cell_count) * 10) / 10,
    avg_friction_agreement: Math.round((sumFriction / cell_count) * 10) / 10,
    avg_pop_agreement: Math.round((sumPop / cell_count) * 10) / 10,
    avg_sample_size: Math.round((sumSample / cell_count) * 10) / 10,
  };
}

function formatUserPrompt(stats: BriefInputStats): string {
  const weakestEntries = Object.entries(stats.weakest_dimension_counts).sort(
    (a, b) => b[1] - a[1]
  );
  const weakestSummary = weakestEntries
    .map(
      ([dim, n]) =>
        `${dim}: ${n} cells (${((n / stats.cell_count) * 100).toFixed(0)}%)`
    )
    .join('; ');

  return [
    `Country: ${stats.country_iso}`,
    `Cells analyzed: ${stats.cell_count}`,
    `Overall trust score — median ${stats.median_overall}, p25 ${stats.p25_overall}, p75 ${stats.p75_overall}`,
    `High-trust cells (overall ≥ 70): ${stats.pct_high_trust}%`,
    `Low-trust cells (overall < 40): ${stats.pct_low_trust}%`,
    `Dimension averages — completeness: ${stats.avg_data_completeness}, sample: ${stats.avg_sample_size}, friction-agreement: ${stats.avg_friction_agreement}, pop-agreement: ${stats.avg_pop_agreement}`,
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
