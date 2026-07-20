/**
 * Golden-question eval for /api/ask.
 *
 * Runs the cases in eval-cases.json against a live deployment (local dev
 * server by default) and grades the full pipeline: stage-1 classification,
 * stage-2 SQL synthesis, the SQL validator and real execution. The point is
 * model migration with evidence — run once against the current models, flip
 * GROQ_GUARD_MODEL / GROQ_MODEL on the server, run again, compare.
 *
 * Usage:
 *   npx tsx scripts/eval-ask.ts [--url http://localhost:3000] [--label baseline]
 *                               [--only <substring>] [--delay <ms>] [--out <file>]
 *                               [--country COL] [--level secalta] [--transport walking]
 *
 * Caveats (both are in-memory in the route, so restarting the dev server
 * between runs resets them):
 *   - The route caches responses per question+scope; a rerun without restart
 *     measures the cache, not the model.
 *   - The route rate-limits 30 requests / 15 min per IP; the full set is 22
 *     requests, so one run per window without a restart.
 */

import { readFileSync, writeFileSync } from 'node:fs';

interface ExpectedAction {
  type: string;
  [key: string]: unknown;
}

interface CaseExpect {
  kind: string;
  view?: string;
  sqlIncludes?: string[];
  minRows?: number;
  actions?: ExpectedAction[];
}

interface EvalCase {
  id: string;
  category: string;
  question: string;
  expect: CaseExpect;
  notes?: string;
}

interface CaseResult {
  id: string;
  category: string;
  pass: boolean;
  failures: string[];
  latencyMs: number;
  kind: string | null;
  sql: string | null;
  httpStatus: number;
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    }
  }
  return args;
}

function grade(c: EvalCase, status: number, body: Record<string, unknown>): string[] {
  const failures: string[] = [];
  const exp = c.expect;

  if (status !== 200) {
    failures.push(`HTTP ${status}: ${String(body?.error ?? 'no error message')}`);
    return failures;
  }

  const kind = typeof body.kind === 'string' ? body.kind : null;
  if (kind !== exp.kind) {
    failures.push(`kind: expected "${exp.kind}", got "${kind}"`);
    // A wrong kind makes the remaining checks meaningless noise.
    return failures;
  }

  const sql = typeof body.sql === 'string' ? body.sql.toLowerCase() : '';
  if (exp.view && !sql.includes(exp.view)) {
    failures.push(`sql does not reference ${exp.view}`);
  }
  for (const frag of exp.sqlIncludes ?? []) {
    if (!sql.includes(frag.toLowerCase())) failures.push(`sql missing "${frag}"`);
  }
  if (exp.minRows !== undefined) {
    const n = Array.isArray(body.rows) ? body.rows.length : 0;
    if (n < exp.minRows) failures.push(`rows: expected >= ${exp.minRows}, got ${n}`);
  }
  if (exp.kind === 'explainer') {
    const narrative = typeof body.narrative === 'string' ? body.narrative.trim() : '';
    if (!narrative) failures.push('explainer with empty narrative');
  }
  for (const expAction of exp.actions ?? []) {
    const actions = Array.isArray(body.actions) ? (body.actions as Record<string, unknown>[]) : [];
    const found = actions.some((a) =>
      Object.entries(expAction).every(([k, v]) => a[k] === v)
    );
    if (!found) failures.push(`no action matching ${JSON.stringify(expAction)}`);
  }
  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (args.url ?? 'http://localhost:3000').replace(/\/$/, '');
  const label = args.label ?? 'unlabeled';
  const delayMs = Number(args.delay ?? 1500);
  const scope = {
    country: args.country ?? 'COL',
    level: args.level ?? 'secalta',
    transport: args.transport ?? 'walking',
  };

  const casesUrl = new URL('./eval-cases.json', import.meta.url);
  let cases: EvalCase[] = JSON.parse(readFileSync(casesUrl, 'utf8'));
  if (args.only) cases = cases.filter((c) => c.id.includes(args.only));
  if (cases.length === 0) {
    console.error(`No cases match --only "${args.only}"`);
    process.exit(2);
  }

  console.log(`eval-ask · ${cases.length} cases · ${baseUrl} · label=${label}`);
  console.log(`scope: ${scope.country}/${scope.level}/${scope.transport}\n`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    const t0 = Date.now();
    let status = 0;
    let body: Record<string, unknown> = {};
    try {
      const res = await fetch(`${baseUrl}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: c.question, ...scope }),
      });
      status = res.status;
      body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (err) {
      body = { error: `fetch failed: ${String(err)}` };
    }
    const latencyMs = Date.now() - t0;
    const failures = grade(c, status, body);
    const result: CaseResult = {
      id: c.id,
      category: c.category,
      pass: failures.length === 0,
      failures,
      latencyMs,
      kind: typeof body.kind === 'string' ? body.kind : null,
      sql: typeof body.sql === 'string' ? body.sql : null,
      httpStatus: status,
    };
    results.push(result);

    const mark = result.pass ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${c.id.padEnd(22)} ${c.category.padEnd(14)} ${String(latencyMs).padStart(6)}ms`);
    for (const f of failures) console.log(`      · ${f}`);

    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  // ── summary ────────────────────────────────────────────────────────────────
  const byCategory = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const s = byCategory.get(r.category) ?? { pass: 0, total: 0 };
    s.total++;
    if (r.pass) s.pass++;
    byCategory.set(r.category, s);
  }
  const passed = results.filter((r) => r.pass).length;
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  // Stage-1-only kinds resolve in one model call; data kinds pay both stages.
  const stage1 = results.filter((r) => r.kind && r.kind !== 'data').map((r) => r.latencyMs);
  const stage2 = results.filter((r) => r.kind === 'data').map((r) => r.latencyMs);

  console.log(`\n── summary (${label}) ─────────────────────────────`);
  for (const [cat, s] of byCategory) console.log(`${cat.padEnd(14)} ${s.pass}/${s.total}`);
  console.log(`total          ${passed}/${results.length}`);
  console.log(`latency avg    stage1-only ${avg(stage1)}ms · data ${avg(stage2)}ms`);

  if (args.out) {
    writeFileSync(args.out, JSON.stringify({ label, baseUrl, scope, date: new Date().toISOString(), results }, null, 2));
    console.log(`results written to ${args.out}`);
  }

  process.exit(passed === results.length ? 0 : 1);
}

main();
