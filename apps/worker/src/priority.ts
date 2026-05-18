/**
 * Priority scorer (v4 — multi-country) — derives "where to invest next".
 *
 * Runs AFTER the Robustness Auditor for a country, reading from
 * robustness_reports + v_indicators_adm2. Pure aggregation, no LLM.
 *
 * Inputs per cell (admin2_pcode x education_level x transport_mode):
 *   - children_underserved = pop_total - pop_le30
 *   - access_gap           = 100 - pct_le30
 *   - robustness           = score_overall from robustness_reports
 *
 *   raw = log_norm(children_underserved) * access_gap * (robustness / 100)
 *
 * The robustness factor penalizes low-confidence cells. log-norming the
 * children count keeps small districts from being drowned by the capital.
 * Ranks are computed within the country, per education_level x mode.
 */

import { sb } from './supabase.js';
import type { EducationLevel, TransportMode } from './scores.js';

interface PriorityInput {
  country_iso: string;
  admin2_pcode: string;
  education_level: EducationLevel;
  transport_mode: TransportMode;
  children_underserved: number;
  pct_le30: number;
  robustness: number;
}

interface PriorityRow extends PriorityInput {
  score: number;
  rank_in_country: number;
  audit_run_id: string;
}

const clamp = (x: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));

export async function computeAndWritePriorities(
  auditRunId: string,
  countryIso: string
): Promise<number> {
  const { data: indicators, error: indErr } = await sb
    .from('v_indicators_adm2')
    .select('admin2_pcode, education_level, mode, pct_le30, pop_total')
    .eq('country_iso', countryIso);
  if (indErr) throw indErr;

  const { data: reports, error: repErr } = await sb
    .from('robustness_reports')
    .select('admin2_pcode, education_level, transport_mode, score_overall')
    .eq('audit_run_id', auditRunId);
  if (repErr) throw repErr;

  const robByKey = new Map<string, number>();
  for (const r of reports ?? []) {
    robByKey.set(
      `${r.admin2_pcode}|${r.education_level}|${r.transport_mode}`,
      Number(r.score_overall)
    );
  }

  const inputs: PriorityInput[] = [];
  for (const row of indicators ?? []) {
    const transport_mode = row.mode as TransportMode;
    const key = `${row.admin2_pcode}|${row.education_level}|${transport_mode}`;
    const robustness = robByKey.get(key);
    if (robustness === undefined) continue;
    const pop_total = Number(row.pop_total ?? 0);
    if (pop_total <= 0) continue;
    const pct_le30 = Number(row.pct_le30 ?? 0);
    const pop_le30 = pop_total * (pct_le30 / 100);
    inputs.push({
      country_iso: countryIso,
      admin2_pcode: row.admin2_pcode,
      education_level: row.education_level as EducationLevel,
      transport_mode,
      children_underserved: Math.max(0, Math.round(pop_total - pop_le30)),
      pct_le30: Number(pct_le30.toFixed(1)),
      robustness,
    });
  }

  // log-norm by max children in this education_level x mode partition.
  const partitionKey = (i: PriorityInput) => `${i.education_level}|${i.transport_mode}`;
  const partitionMaxChildren = new Map<string, number>();
  for (const i of inputs) {
    const k = partitionKey(i);
    partitionMaxChildren.set(k, Math.max(partitionMaxChildren.get(k) ?? 0, i.children_underserved));
  }

  const scoredRows = inputs.map((i) => {
    const maxC = partitionMaxChildren.get(partitionKey(i)) ?? 1;
    const childrenNorm = maxC > 0 ? Math.log10(i.children_underserved + 1) / Math.log10(maxC + 1) : 0;
    const accessGap = 100 - i.pct_le30;
    const raw = childrenNorm * accessGap * (i.robustness / 100);
    return { i, raw };
  });

  // Per-partition normalization to 0-100, then rank.
  const partitions = new Map<string, typeof scoredRows>();
  for (const s of scoredRows) {
    const k = partitionKey(s.i);
    if (!partitions.has(k)) partitions.set(k, []);
    partitions.get(k)!.push(s);
  }

  const finalRows: PriorityRow[] = [];
  for (const [, group] of partitions) {
    const maxRaw = Math.max(...group.map((s) => s.raw), 0);
    const ranked = [...group].sort((a, b) => b.raw - a.raw);
    ranked.forEach((s, idx) => {
      const score = maxRaw > 0 ? clamp((s.raw / maxRaw) * 100) : 0;
      finalRows.push({
        ...s.i,
        score: Math.round(score * 10) / 10,
        rank_in_country: idx + 1,
        audit_run_id: auditRunId,
      });
    });
  }

  if (finalRows.length === 0) return 0;

  const CHUNK = 500;
  for (let i = 0; i < finalRows.length; i += CHUNK) {
    const { error: upErr } = await sb
      .from('priority_scores')
      .upsert(finalRows.slice(i, i + CHUNK), {
        onConflict: 'country_iso,admin2_pcode,education_level,transport_mode',
      });
    if (upErr) throw upErr;
  }

  return finalRows.length;
}
