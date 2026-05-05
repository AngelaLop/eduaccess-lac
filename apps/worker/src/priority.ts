/**
 * Priority scorer — derives "where to invest next" rankings.
 *
 * Runs AFTER the Robustness Auditor finishes, because it reads from
 * robustness_reports. Pure SQL aggregation, no LLM.
 *
 * Inputs per cell (district x age_group x transport_mode):
 *   - children_underserved = pop_total - pop_le30
 *   - access_gap           = 100 - pct_le30
 *   - robustness           = score_overall from robustness_reports
 *
 * Score (0-100): a weighted combination, then ranked within country.
 *
 *   raw = log_norm(children_underserved) * access_gap * (robustness / 100)
 *
 * The robustness factor PENALIZES low-confidence cells: we don't want to
 * recommend building a school based on a number we can't trust. log-norming
 * the children count keeps small districts from being drowned by Panama City.
 */

import { sb } from './supabase.js';
import type { AgeGroup, TransportMode } from './scores.js';

interface PriorityInput {
  cod_dist: string;
  age_group: AgeGroup;
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

export async function computeAndWritePriorities(auditRunId: string): Promise<number> {
  // Pull all canonical-scenario indicators (worldpop + map + walking|motorized × 4 ages)
  // joined to the just-written robustness_reports for this run.
  const { data: indicators, error: indErr } = await sb
    .from('panama_district_indicators')
    .select('cod_dist, age_group, friction, pop_total, pop_le30')
    .eq('pop_source', 'worldpop')
    .eq('friction_source', 'map');
  if (indErr) throw indErr;

  const { data: reports, error: repErr } = await sb
    .from('robustness_reports')
    .select('cod_dist, age_group, transport_mode, score_overall')
    .eq('audit_run_id', auditRunId);
  if (repErr) throw repErr;

  const robByKey = new Map<string, number>();
  for (const r of reports ?? []) {
    robByKey.set(`${r.cod_dist}|${r.age_group}|${r.transport_mode}`, Number(r.score_overall));
  }

  // Build PriorityInput per (cod, age, mode), filter cells with no underserved children
  const inputs: PriorityInput[] = [];
  for (const row of indicators ?? []) {
    const transport_mode = row.friction as TransportMode;
    const key = `${row.cod_dist}|${row.age_group}|${transport_mode}`;
    const robustness = robByKey.get(key);
    if (robustness === undefined) continue;
    const pop_total = Number(row.pop_total);
    const pop_le30 = Number(row.pop_le30);
    const underserved = Math.max(0, pop_total - pop_le30);
    if (pop_total <= 0) continue;
    const pct_le30 = pop_total > 0 ? (pop_le30 / pop_total) * 100 : 0;
    inputs.push({
      cod_dist: row.cod_dist,
      age_group: row.age_group as AgeGroup,
      transport_mode,
      children_underserved: underserved,
      pct_le30: Number(pct_le30.toFixed(1)),
      robustness,
    });
  }

  // Compute raw scores. log-norm by max children in this group×mode partition.
  const partitionKey = (i: PriorityInput) => `${i.age_group}|${i.transport_mode}`;
  const partitionMaxChildren = new Map<string, number>();
  for (const i of inputs) {
    const k = partitionKey(i);
    partitionMaxChildren.set(k, Math.max(partitionMaxChildren.get(k) ?? 0, i.children_underserved));
  }

  const scoredRows = inputs.map((i) => {
    const k = partitionKey(i);
    const maxC = partitionMaxChildren.get(k) ?? 1;
    const childrenNorm = maxC > 0 ? Math.log10(i.children_underserved + 1) / Math.log10(maxC + 1) : 0;
    const accessGap = 100 - i.pct_le30; // 0-100
    const robustnessFactor = i.robustness / 100;
    const raw = childrenNorm * accessGap * robustnessFactor;
    // Normalize to 0-100 within the partition by dividing by the partition's max raw
    return { i, raw };
  });

  // Per-partition normalization to 0-100, then rank
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

  // Upsert in chunks
  const CHUNK = 500;
  for (let i = 0; i < finalRows.length; i += CHUNK) {
    const chunk = finalRows.slice(i, i + CHUNK);
    const { error: upErr } = await sb
      .from('priority_scores')
      .upsert(chunk, { onConflict: 'cod_dist,age_group,transport_mode' });
    if (upErr) throw upErr;
  }

  return finalRows.length;
}
