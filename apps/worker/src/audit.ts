/**
 * Audit orchestration (v3).
 *
 * v3 pivot: no per-cell LLM call. Every cell gets a *deterministic*
 * narrative + caveats from rule-based templates over the numeric scores.
 * The LLM is reserved for one country audit brief per refresh (see
 * country-brief.ts) — and for the v4 lazy /api/audit-cell route.
 *
 * Flow:
 *   1. Open an audit_runs row (status=running)
 *   2. Load all 32-scenario indicators in one SELECT
 *   3. Build CellBundle per (district x age_group x transport_mode) — 664 max
 *   4. For each cell:
 *      a. computeScores() — pure SQL-derived, fast
 *      b. explainCell() — pure-function explainer, free, instant
 *      c. accumulate to a batch
 *      d. flush batch to robustness_reports every N cells
 *   5. Run priority scorer (no LLM)
 *   6. Write country audit brief (ONE LLM call, optional via env flag)
 *   7. Mark audit_runs row done
 */

import { sb } from './supabase.js';
import { explainCell, FACTS_VERSION } from './explainer.js';
import { writeCountryAuditBrief, PROMPT_VERSION as BRIEF_PROMPT_VERSION } from './country-brief.js';
import { computeScores, type AgeGroup, type CellBundle, type ScenarioRow, type TransportMode } from './scores.js';
import { computeAndWritePriorities } from './priority.js';

const AGE_GROUPS: AgeGroup[] = ['all', 'primary', 'secondary', 'highschool'];
const TRANSPORT_MODES: TransportMode[] = ['walking', 'motorized'];

const FLUSH_BATCH_SIZE = 100;

// Bump when the rule-based explainer's text templates change.
const EXPLAINER_PROMPT_VERSION = 1;

interface AuditOptions {
  cellLimit?: number;       // smoke-test: process only N cells
  dryRun?: boolean;         // skip LLM brief and skip writes
  triggerSource?: string;   // 'cron' | 'manual'
  skipCountryBrief?: boolean;
}

// ── data loading ───────────────────────────────────────────────────────────────

async function loadAllScenarios(): Promise<ScenarioRow[]> {
  const all: ScenarioRow[] = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('panama_district_indicators')
      .select(
        'cod_dist, nomb_dist, nomb_prov, age_group, pop_source, friction_source, friction, pop_total, pop_nodata, pct_le30'
      )
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as unknown as ScenarioRow[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function buildCellBundles(rows: ScenarioRow[]): CellBundle[] {
  // Group rows by (cod, age, mode), then pick the canonical + the comparison rows.
  type Key = string;
  const byKey = new Map<Key, ScenarioRow[]>();
  for (const r of rows) {
    const k = `${r.cod_dist}|${r.age_group}|${r.friction}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }

  const bundles: CellBundle[] = [];
  for (const [, group] of byKey) {
    const canonical = group.find(
      (r) => r.pop_source === 'worldpop' && r.friction_source === 'map'
    );
    if (!canonical || canonical.pop_total <= 0) continue; // skip cells with no canonical or no pop

    const worldpop_osm =
      group.find((r) => r.pop_source === 'worldpop' && r.friction_source === 'osm') ?? null;
    const census_map =
      group.find((r) => r.pop_source === 'census' && r.friction_source === 'map') ?? null;

    bundles.push({
      cod_dist: canonical.cod_dist,
      nomb_dist: canonical.nomb_dist,
      nomb_prov: canonical.nomb_prov,
      age_group: canonical.age_group,
      transport_mode: canonical.friction,
      canonical,
      worldpop_osm,
      census_map,
    });
  }

  // Stable order: cod_dist asc, then age_group, then mode
  bundles.sort((a, b) => {
    if (a.cod_dist !== b.cod_dist) return a.cod_dist.localeCompare(b.cod_dist);
    const aG = AGE_GROUPS.indexOf(a.age_group) - AGE_GROUPS.indexOf(b.age_group);
    if (aG !== 0) return aG;
    return TRANSPORT_MODES.indexOf(a.transport_mode) - TRANSPORT_MODES.indexOf(b.transport_mode);
  });

  return bundles;
}

// ── audit run lifecycle ────────────────────────────────────────────────────────

async function openRun(triggerSource: string, cellsTotal: number): Promise<string> {
  const { data, error } = await sb
    .from('audit_runs')
    .insert({
      cells_total: cellsTotal,
      cells_done: 0,
      cells_failed: 0,
      status: 'running',
      trigger_source: triggerSource,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function bumpRun(runId: string, doneDelta: number, failedDelta: number) {
  // Read-modify-write. Not race-safe across multiple workers, but a single
  // worker run never has concurrent bumps with itself (we flush sequentially).
  const { data: row } = await sb
    .from('audit_runs')
    .select('cells_done, cells_failed')
    .eq('id', runId)
    .single();
  if (!row) return;
  await sb
    .from('audit_runs')
    .update({
      cells_done: (row.cells_done ?? 0) + doneDelta,
      cells_failed: (row.cells_failed ?? 0) + failedDelta,
    })
    .eq('id', runId);
}

async function closeRun(runId: string, status: 'done' | 'failed') {
  await sb
    .from('audit_runs')
    .update({ status, finished_at: new Date().toISOString() })
    .eq('id', runId);
}

// ── per-cell processing ────────────────────────────────────────────────────────

interface ReportRow {
  cod_dist: string;
  age_group: string;
  transport_mode: string;
  score_data_completeness: number;
  score_sample_size: number;
  score_friction_agreement: number;
  score_pop_agreement: number;
  score_overall: number;
  weakest_dimension: string;
  narrative: string;
  caveats: string[];
  narrative_source: 'deterministic' | 'llm';
  facts_version: number;
  prompt_version: number;
  model: string | null;
  input_hash: string;
  audit_run_id: string;
}

function processCell(bundle: CellBundle, runId: string): ReportRow {
  const scores = computeScores(bundle);
  const { narrative, caveats, input_hash } = explainCell(bundle, scores);
  return {
    cod_dist: bundle.cod_dist,
    age_group: bundle.age_group,
    transport_mode: bundle.transport_mode,
    score_data_completeness: scores.data_completeness,
    score_sample_size: scores.sample_size,
    score_friction_agreement: scores.friction_agreement,
    score_pop_agreement: scores.pop_agreement,
    score_overall: scores.composite,
    weakest_dimension: scores.weakest,
    narrative,
    caveats,
    narrative_source: 'deterministic',
    facts_version: FACTS_VERSION,
    prompt_version: EXPLAINER_PROMPT_VERSION,
    model: null,
    input_hash,
    audit_run_id: runId,
  };
}

async function flush(buffer: ReportRow[]) {
  if (buffer.length === 0) return;
  const { error } = await sb
    .from('robustness_reports')
    .upsert(buffer, { onConflict: 'cod_dist,age_group,transport_mode' });
  if (error) throw error;
}

// ── public entry ───────────────────────────────────────────────────────────────

export async function runFullAudit(opts: AuditOptions = {}) {
  const triggerSource = opts.triggerSource ?? process.env.AUDIT_TRIGGER_SOURCE ?? 'manual';
  const cellLimit =
    opts.cellLimit ??
    (process.env.AUDIT_CELL_LIMIT ? Number(process.env.AUDIT_CELL_LIMIT) : undefined);
  const dryRun = opts.dryRun ?? process.env.AUDIT_DRY_RUN === 'true';
  const skipCountryBrief =
    opts.skipCountryBrief ?? process.env.AUDIT_SKIP_BRIEF === 'true';

  console.log(
    `[audit] starting run: trigger=${triggerSource} dryRun=${dryRun}` +
      (cellLimit ? ` limit=${cellLimit}` : '') +
      (skipCountryBrief ? ' skipBrief=true' : '')
  );

  const t0 = Date.now();
  const rows = await loadAllScenarios();
  console.log(`[audit] loaded ${rows.length} scenario rows`);
  const bundles = buildCellBundles(rows);
  const cells = cellLimit ? bundles.slice(0, cellLimit) : bundles;
  console.log(`[audit] ${bundles.length} cells available; processing ${cells.length}`);

  const runId = await openRun(triggerSource, cells.length);
  console.log(`[audit] audit_run id=${runId}`);

  const buffer: ReportRow[] = [];
  let doneCount = 0;
  let failedCount = 0;

  try {
    // Deterministic explainer: synchronous, in-process. No need for
    // concurrency or retry — just iterate and batch-flush.
    for (let idx = 0; idx < cells.length; idx++) {
      const bundle = cells[idx];
      try {
        const report = processCell(bundle, runId);
        buffer.push(report);
        doneCount++;
      } catch (err) {
        failedCount++;
        console.error(
          `[audit] cell failed: ${bundle.cod_dist} ${bundle.age_group} ${bundle.transport_mode}:`,
          (err as Error).message
        );
      }

      if (buffer.length >= FLUSH_BATCH_SIZE && !dryRun) {
        const toFlush = buffer.splice(0, buffer.length);
        await flush(toFlush);
        await bumpRun(runId, toFlush.length, 0);
        console.log(`[audit] flushed ${toFlush.length} cells (${idx + 1}/${cells.length})`);
      }
    }

    if (buffer.length > 0 && !dryRun) {
      const finalCount = buffer.length;
      await flush(buffer);
      await bumpRun(runId, finalCount, failedCount);
      console.log(`[audit] flushed final ${finalCount} cells`);
    }

    if (!dryRun) {
      console.log('[audit] computing priority scores…');
      const priorityCount = await computeAndWritePriorities(runId);
      console.log(`[audit] wrote ${priorityCount} priority rows`);

      if (!skipCountryBrief) {
        try {
          console.log('[audit] writing country audit brief…');
          await writeCountryAuditBrief({
            countryIso: 'PAN',
            auditRunId: runId,
            factsVersion: FACTS_VERSION,
            promptVersion: BRIEF_PROMPT_VERSION,
          });
          console.log('[audit] country audit brief written');
        } catch (err) {
          // Brief failure must NOT fail the run — deterministic text is
          // already in robustness_reports and the brief is best-effort.
          console.error('[audit] country brief failed (continuing):', (err as Error).message);
        }
      }
    }

    await closeRun(runId, 'done');
  } catch (err) {
    console.error('[audit] run failed:', err);
    await closeRun(runId, 'failed');
    throw err;
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[audit] done in ${dt}s — ${doneCount} cells written, ${failedCount} failed, run=${runId}`
  );
  return { runId, doneCount, failedCount };
}
