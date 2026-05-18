/**
 * Audit orchestration (v4 — multi-country).
 *
 * No per-cell LLM call. Every cell gets a *deterministic* narrative +
 * caveats from rule-based templates over the numeric scores. The LLM is
 * reserved for one country audit brief per refresh (country-brief.ts).
 *
 * Flow (repeated per country):
 *   1. Open an audit_runs row (status=running, country_iso set)
 *   2. Score every cell of that country from v_indicators_adm2
 *   3. computeScores() + explainCell() — pure functions, free, instant
 *   4. Flush to robustness_reports every N cells
 *   5. Run the priority scorer for the country
 *   6. Write the country audit brief (ONE LLM call, optional via env flag)
 *   7. Mark the audit_runs row done
 *
 * A "cell" is one (country_iso, admin2_pcode, education_level, mode) row
 * of v_indicators_adm2 — the view already collapses the source slices.
 */

import { sb } from './supabase.js';
import { explainCell, FACTS_VERSION } from './explainer.js';
import { writeCountryAuditBrief, PROMPT_VERSION as BRIEF_PROMPT_VERSION } from './country-brief.js';
import { computeScores, type IndicatorCell } from './scores.js';
import { computeAndWritePriorities } from './priority.js';

const FLUSH_BATCH_SIZE = 200;

// Bump when the rule-based explainer's text templates change.
const EXPLAINER_PROMPT_VERSION = 2;

interface AuditOptions {
  cellLimit?: number;       // smoke-test: process only N cells per country
  dryRun?: boolean;         // skip LLM brief and skip writes
  triggerSource?: string;   // 'cron' | 'manual'
  skipCountryBrief?: boolean;
  country?: string;         // limit the run to one country_iso
}

// ── data loading ───────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => (v == null ? null : Number(v));

async function loadCells(country?: string): Promise<IndicatorCell[]> {
  const all: IndicatorCell[] = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    let q = sb
      .from('v_indicators_adm2')
      .select(
        'country_iso, admin2_pcode, admin2_name, admin1_name, education_level, mode, pct_le15, pct_le30, pct_le60, pop_total, pct_le30_osrm'
      )
      // Deterministic order — paginating an unordered view with range()
      // can drop or duplicate rows across pages.
      .order('country_iso', { ascending: true })
      .order('admin2_pcode', { ascending: true })
      .order('education_level', { ascending: true })
      .order('mode', { ascending: true })
      .range(from, from + PAGE - 1);
    if (country) q = q.eq('country_iso', country);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) {
      all.push({
        country_iso: String(r.country_iso),
        admin2_pcode: String(r.admin2_pcode),
        admin2_name: r.admin2_name == null ? null : String(r.admin2_name),
        admin1_name: r.admin1_name == null ? null : String(r.admin1_name),
        education_level: r.education_level as IndicatorCell['education_level'],
        mode: r.mode as IndicatorCell['mode'],
        pct_le15: num(r.pct_le15),
        pct_le30: num(r.pct_le30),
        pct_le60: num(r.pct_le60),
        pop_total: num(r.pop_total),
        pct_le30_osrm: num(r.pct_le30_osrm),
      });
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ── audit run lifecycle ────────────────────────────────────────────────────────

async function openRun(
  triggerSource: string,
  countryIso: string,
  cellsTotal: number
): Promise<string> {
  const { data, error } = await sb
    .from('audit_runs')
    .insert({
      country_iso: countryIso,
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
  country_iso: string;
  admin2_pcode: string;
  education_level: string;
  transport_mode: string;
  score_data_completeness: number;
  score_sample_size: number;
  score_method_agreement: number;
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

function processCell(cell: IndicatorCell, runId: string): ReportRow {
  const scores = computeScores(cell);
  const { narrative, caveats, input_hash } = explainCell(cell, scores);
  return {
    country_iso: cell.country_iso,
    admin2_pcode: cell.admin2_pcode,
    education_level: cell.education_level,
    transport_mode: cell.mode,
    score_data_completeness: scores.data_completeness,
    score_sample_size: scores.sample_size,
    score_method_agreement: scores.method_agreement,
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
    .upsert(buffer, {
      onConflict: 'country_iso,admin2_pcode,education_level,transport_mode',
    });
  if (error) throw error;
}

// ── per-country audit ──────────────────────────────────────────────────────────

interface CountryResult {
  countryIso: string;
  runId: string;
  doneCount: number;
  failedCount: number;
}

async function auditCountry(
  countryIso: string,
  cells: IndicatorCell[],
  opts: { triggerSource: string; dryRun: boolean; skipCountryBrief: boolean }
): Promise<CountryResult> {
  const runId = await openRun(opts.triggerSource, countryIso, cells.length);
  console.log(`[audit] ${countryIso}: run id=${runId}, ${cells.length} cells`);

  const buffer: ReportRow[] = [];
  let doneCount = 0;
  let failedCount = 0;

  try {
    for (let idx = 0; idx < cells.length; idx++) {
      const cell = cells[idx];
      try {
        buffer.push(processCell(cell, runId));
        doneCount++;
      } catch (err) {
        failedCount++;
        console.error(
          `[audit] cell failed: ${cell.admin2_pcode} ${cell.education_level} ${cell.mode}:`,
          (err as Error).message
        );
      }
      if (buffer.length >= FLUSH_BATCH_SIZE && !opts.dryRun) {
        const toFlush = buffer.splice(0, buffer.length);
        await flush(toFlush);
        await bumpRun(runId, toFlush.length, 0);
        console.log(`[audit] ${countryIso}: flushed ${toFlush.length} (${idx + 1}/${cells.length})`);
      }
    }

    if (buffer.length > 0 && !opts.dryRun) {
      const finalCount = buffer.length;
      await flush(buffer);
      await bumpRun(runId, finalCount, failedCount);
    }

    if (!opts.dryRun) {
      const priorityCount = await computeAndWritePriorities(runId, countryIso);
      console.log(`[audit] ${countryIso}: wrote ${priorityCount} priority rows`);

      if (!opts.skipCountryBrief) {
        try {
          await writeCountryAuditBrief({
            countryIso,
            auditRunId: runId,
            factsVersion: FACTS_VERSION,
            promptVersion: BRIEF_PROMPT_VERSION,
          });
          console.log(`[audit] ${countryIso}: country audit brief written`);
        } catch (err) {
          // Brief failure must NOT fail the run — deterministic text is
          // already in robustness_reports and the brief is best-effort.
          console.error(`[audit] ${countryIso}: brief failed (continuing):`, (err as Error).message);
        }
      }
    }

    await closeRun(runId, 'done');
  } catch (err) {
    console.error(`[audit] ${countryIso}: run failed:`, err);
    await closeRun(runId, 'failed');
    throw err;
  }

  return { countryIso, runId, doneCount, failedCount };
}

// ── public entry ───────────────────────────────────────────────────────────────

export async function runFullAudit(opts: AuditOptions = {}) {
  const triggerSource = opts.triggerSource ?? process.env.AUDIT_TRIGGER_SOURCE ?? 'manual';
  const cellLimit =
    opts.cellLimit ??
    (process.env.AUDIT_CELL_LIMIT ? Number(process.env.AUDIT_CELL_LIMIT) : undefined);
  const dryRun = opts.dryRun ?? process.env.AUDIT_DRY_RUN === 'true';
  const skipCountryBrief = opts.skipCountryBrief ?? process.env.AUDIT_SKIP_BRIEF === 'true';
  const country = opts.country ?? process.env.AUDIT_COUNTRY ?? undefined;

  console.log(
    `[audit] starting run: trigger=${triggerSource} dryRun=${dryRun}` +
      (country ? ` country=${country}` : '') +
      (cellLimit ? ` limit=${cellLimit}/country` : '') +
      (skipCountryBrief ? ' skipBrief=true' : '')
  );

  const t0 = Date.now();
  const allCells = await loadCells(country);
  console.log(`[audit] loaded ${allCells.length} cells from v_indicators_adm2`);

  // Group cells by country, stable order within each.
  const byCountry = new Map<string, IndicatorCell[]>();
  for (const c of allCells) {
    if (!byCountry.has(c.country_iso)) byCountry.set(c.country_iso, []);
    byCountry.get(c.country_iso)!.push(c);
  }

  const results: CountryResult[] = [];
  for (const [countryIso, cells] of byCountry) {
    cells.sort(
      (a, b) =>
        a.admin2_pcode.localeCompare(b.admin2_pcode) ||
        a.education_level.localeCompare(b.education_level) ||
        a.mode.localeCompare(b.mode)
    );
    const selected = cellLimit ? cells.slice(0, cellLimit) : cells;
    // Isolate per-country failures — one country erroring must not abort the
    // remaining countries. auditCountry already marks its own run failed.
    try {
      results.push(
        await auditCountry(countryIso, selected, { triggerSource, dryRun, skipCountryBrief })
      );
    } catch (err) {
      console.error(`[audit] ${countryIso}: aborted, continuing —`, (err as Error).message);
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const done = results.reduce((s, r) => s + r.doneCount, 0);
  const failed = results.reduce((s, r) => s + r.failedCount, 0);
  console.log(
    `[audit] done in ${dt}s — ${results.length} countries, ${done} cells written, ${failed} failed`
  );
  return { countries: results, doneCount: done, failedCount: failed };
}
