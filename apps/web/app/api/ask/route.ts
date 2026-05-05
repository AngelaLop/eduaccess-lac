/**
 * POST /api/ask  { question: string }
 * → AskResponse — one of three kinds: data | navigation | out_of_scope
 *
 * v2: Stream B
 * The LLM is no longer a SQL pipe. It's a router that classifies the question
 * into one of three response kinds and returns the matching shape from the
 * AskResponse contract in lib/types.ts.
 *
 *   data        → SQL query on v_panama_indicators (existing v1 path)
 *   navigation  → UI actions only, no DB call
 *   out_of_scope→ guidance hint, no DB call
 *
 * Codex second-pass review target.
 */

import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { validateSQL } from '@/lib/sql-validator';
import districtRoster from '@/lib/district-roster.json';
import type { AgeGroup, AskAction, AskResponse, ResultShape, TransportMode } from '@/lib/types';

// ── district roster ───────────────────────────────────────────────────────────

interface DistrictRow {
  cod_dist: string;
  nomb_dist: string;
  nomb_prov: string;
}

const DISTRICTS = districtRoster as DistrictRow[];
const DISTRICT_BY_CODE = new Map(DISTRICTS.map((d) => [d.cod_dist, d]));

// Compact form: "0810=San Miguelito,Panama" — saves ~15 chars per row vs.
// "(province)" formatting. The full roster is ~83 lines either way.
const DISTRICT_LIST_FOR_PROMPT = DISTRICTS.map(
  (d) => `${d.cod_dist}=${d.nomb_dist},${d.nomb_prov}`
).join('\n');

// In-memory cache of question → response. Survives until the dev server
// restarts (or until the serverless instance is recycled in production).
// Keyed on the lowercased+trimmed question to catch obvious duplicates.
const responseCache = new Map<string, AskResponse>();
const CACHE_MAX = 200;
function cacheKey(q: string) {
  return q.trim().toLowerCase();
}
function cachePut(q: string, r: AskResponse) {
  if (responseCache.size >= CACHE_MAX) {
    const firstKey = responseCache.keys().next().value;
    if (firstKey !== undefined) responseCache.delete(firstKey);
  }
  responseCache.set(cacheKey(q), r);
}

// ── system prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are the EduAccess LAC interface agent for Panama school-accessibility data.

For every user question, classify it into ONE of three kinds and return JSON:

  "data"         → answerable by a SQL query on v_panama_indicators
  "navigation"   → asks to interact with the UI (focus a district, switch
                   transport mode, or switch education level), no SQL needed
  "out_of_scope" → outside Panama, outside school-access topic, or asks for
                   columns we do not have

Always respond as JSON. Never as freeform text. Never mix kinds.

============================================================
KIND: "data"
============================================================

Shape: { "kind":"data", "sql":"...", "narrative":"...", "resultShape":"..." }

VIEW: v_panama_indicators — one row per district × age_group.
Canonical scenario: WorldPop population + MAP friction + walking transport.

COLUMNS:
  cod_dist               TEXT    District code (4-char zero-padded), MUST appear in SELECT for district-level results
  nomb_dist              TEXT    District name
  nomb_prov              TEXT    Province name
  age_group              TEXT    'all' | 'primary' | 'secondary' | 'highschool'
  pop_total              INT     Population in this age group
  pop_le15               INT     Population within 15 min walk of nearest school
  pop_le30               INT     Population within 30 min walk
  pop_le60               INT     Population within 60 min walk
  pop_nodata             INT     Population with no travel-time data
  pct_le15               NUMERIC % within 15 min (0-100)
  pct_le30               NUMERIC % within 30 min (0-100)
  pct_le60               NUMERIC % within 60 min (0-100)
  data_completeness_pct  NUMERIC % of population with usable travel-time data

HARD RULES — any violation makes the SQL invalid:
1. SELECT only. No INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE.
2. Only reference v_panama_indicators. No other tables or views.
3. Include LIMIT N where N ≤ 50.
4. Include cod_dist in SELECT for district-level results. Province-level aggregates may omit it.
5. No semicolons. No pg_* functions. No information_schema.

RANKING RULE:
When the user ranks by an access metric (pct_le15, pct_le30, pct_le60), ALWAYS
add "AND data_completeness_pct > 0" to the WHERE clause. Districts with zero
completeness show pct_le30 = 0 because the data is missing, not because access
is genuinely zero — including them buries the real worst-served districts
under data gaps. Exception: if the user is explicitly asking about
completeness or missing data, do NOT add this filter.

resultShape values:
  "ranking"    → top-N / bottom-N / ORDER BY ... LIMIT
  "filter"     → WHERE filter, returns matching rows without rank semantics
  "comparison" → side-by-side comparison (two age groups, two provinces, etc.)
  "aggregate"  → single-row or grouped summary stats

Examples:

Q: Top 5 districts with the worst walking access for high schoolers
A: {"kind":"data","sql":"SELECT cod_dist, nomb_dist, nomb_prov, pct_le30 FROM v_panama_indicators WHERE age_group = 'highschool' AND data_completeness_pct > 0 ORDER BY pct_le30 ASC LIMIT 5","narrative":"The 5 districts with the lowest share of high schoolers within 30 minutes walk of a school (excluding districts with no travel-time data).","resultShape":"ranking"}

Q: Districts with over 1,000 high schoolers more than 30 min from a school
A: {"kind":"data","sql":"SELECT cod_dist, nomb_dist, nomb_prov, pop_total - pop_le30 AS unreachable FROM v_panama_indicators WHERE age_group = 'highschool' AND (pop_total - pop_le30) > 1000 ORDER BY unreachable DESC LIMIT 20","narrative":"Districts with more than 1,000 high schoolers beyond a 30-minute walk from a school.","resultShape":"filter"}

Q: Compare primary vs high school walking access in Panama province
A: {"kind":"data","sql":"SELECT cod_dist, nomb_dist, age_group, pct_le30 FROM v_panama_indicators WHERE nomb_prov = 'Panama' AND age_group IN ('primary','highschool') ORDER BY cod_dist, age_group LIMIT 50","narrative":"Walking access for primary and high school students across the districts of Panama province.","resultShape":"comparison"}

Q: Rank provinces by average % within 15 min of a school
A: {"kind":"data","sql":"SELECT nomb_prov, ROUND(AVG(pct_le15),1) AS avg_pct_le15, COUNT(DISTINCT cod_dist) AS n_districts FROM v_panama_indicators WHERE age_group = 'all' AND data_completeness_pct > 0 GROUP BY nomb_prov ORDER BY avg_pct_le15 DESC LIMIT 20","narrative":"Province ranking by average share of school-age population within 15 minutes walk of a school.","resultShape":"ranking"}

============================================================
KIND: "navigation"
============================================================

Shape: { "kind":"navigation", "narrative":"...", "actions":[ ... ] }

Use this kind when the user wants to interact with the UI without computing
anything new. The frontend executes each action in order.

Action shapes (must match exactly — never invent fields, never invent codes):
  { "type":"select_district", "cod_dist":"<4-char code from roster below>" }
  { "type":"set_transport_mode", "mode":"walking"|"motorized" }
  { "type":"set_education_level", "level":"all"|"primary"|"secondary"|"highschool" }
  { "type":"focus_panel_tab", "tab":"insight"|"ask" }

DISTRICT ROSTER (use these exact codes; if the user names a district not in
this list, return out_of_scope instead):
${DISTRICT_LIST_FOR_PROMPT}

When focusing a district, also append a focus_panel_tab→insight action so the
panel shows the district detail.

Examples:

Q: Show me San Miguelito
A: {"kind":"navigation","narrative":"Focusing on San Miguelito.","actions":[{"type":"select_district","cod_dist":"0810"},{"type":"focus_panel_tab","tab":"insight"}]}

Q: Switch to motorized
A: {"kind":"navigation","narrative":"Switched to motorized access.","actions":[{"type":"set_transport_mode","mode":"motorized"}]}

Q: Show me primary school data
A: {"kind":"navigation","narrative":"Switched to primary level.","actions":[{"type":"set_education_level","level":"primary"}]}

============================================================
KIND: "out_of_scope"
============================================================

Shape: { "kind":"out_of_scope", "narrative":"...", "scopeHint":"..." }

Use this kind when the question is outside our coverage:
- Countries other than Panama (Honduras, Colombia, Costa Rica, etc.)
- Indicators we don't have (enrollment, test scores, teacher counts, school
  quality, hospitals, infrastructure other than schools, transit routes)
- Time series / trends / "how has X changed" — we hold a single snapshot
- General knowledge, math, code, or anything unrelated to school access

narrative: one sentence acknowledging what the user asked and stating why we
can't answer it from this data.
scopeHint: ≤ 280 chars, must reference at least one example prompt the user
can try instead. Be concrete.

Examples:

Q: What about Honduras?
A: {"kind":"out_of_scope","narrative":"This release covers Panama only — other Latin American countries land in a future version.","scopeHint":"Try a Panama question, e.g. \\"Top 5 districts with the worst walking access for high schoolers\\"."}

Q: What's 2 + 2?
A: {"kind":"out_of_scope","narrative":"I'm scoped to Panama school accessibility data, not general questions.","scopeHint":"Try \\"Rank provinces by average % within 15 min of a school\\"."}

Q: How are reading scores in Panama?
A: {"kind":"out_of_scope","narrative":"I have geographic access to schools, not learning outcomes — no reading scores in our data.","scopeHint":"Try \\"Top 5 districts with worst walking access\\" or compare two age groups."}
`.trim();

// ── action validator ──────────────────────────────────────────────────────────

const VALID_AGE_GROUPS: AgeGroup[] = ['all', 'primary', 'secondary', 'highschool'];
const VALID_TRANSPORT_MODES: TransportMode[] = ['walking', 'motorized'];
const VALID_PANEL_TABS = ['insight', 'ask'] as const;

type ActionValidation =
  | { ok: true; actions: AskAction[] }
  | { ok: false; reason: string };

function validateActions(raw: unknown): ActionValidation {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: 'navigation kind requires a non-empty actions array' };
  }
  if (raw.length > 4) {
    return { ok: false, reason: 'too many actions in a single response' };
  }

  const validated: AskAction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return { ok: false, reason: 'action is not an object' };
    }
    const a = item as Record<string, unknown>;
    switch (a.type) {
      case 'select_district': {
        const code = a.cod_dist;
        if (typeof code !== 'string' || !DISTRICT_BY_CODE.has(code)) {
          return { ok: false, reason: `unknown district code: ${String(code)}` };
        }
        validated.push({ type: 'select_district', cod_dist: code });
        break;
      }
      case 'set_transport_mode': {
        const mode = a.mode;
        if (typeof mode !== 'string' || !VALID_TRANSPORT_MODES.includes(mode as TransportMode)) {
          return { ok: false, reason: `invalid transport mode: ${String(mode)}` };
        }
        validated.push({ type: 'set_transport_mode', mode: mode as TransportMode });
        break;
      }
      case 'set_education_level': {
        const level = a.level;
        if (typeof level !== 'string' || !VALID_AGE_GROUPS.includes(level as AgeGroup)) {
          return { ok: false, reason: `invalid education level: ${String(level)}` };
        }
        validated.push({ type: 'set_education_level', level: level as AgeGroup });
        break;
      }
      case 'focus_panel_tab': {
        const tab = a.tab;
        if (typeof tab !== 'string' || !(VALID_PANEL_TABS as readonly string[]).includes(tab)) {
          return { ok: false, reason: `invalid panel tab: ${String(tab)}` };
        }
        validated.push({ type: 'focus_panel_tab', tab: tab as 'insight' | 'ask' });
        break;
      }
      default:
        return { ok: false, reason: `unknown action type: ${String(a.type)}` };
    }
  }
  return { ok: true, actions: validated };
}

// ── scope hint trimmer ────────────────────────────────────────────────────────

const SCOPE_HINT_MAX = 280;

function trimScopeHint(hint: unknown): string {
  if (typeof hint !== 'string') return 'Try one of the seeded prompts above.';
  const trimmed = hint.trim();
  if (trimmed.length <= SCOPE_HINT_MAX) return trimmed;
  return trimmed.slice(0, SCOPE_HINT_MAX - 1).trimEnd() + '…';
}

// ── LLM error handler ─────────────────────────────────────────────────────────
// Detects rate limits specifically and surfaces them as a friendly message
// with the retry-after duration parsed from the Groq error.

interface MaybeApiError {
  status?: number;
  message?: string;
}

function handleLlmError(err: unknown): NextResponse {
  console.error('[ask] LLM error:', err);
  const e = err as MaybeApiError;
  if (e?.status === 429) {
    const retryAfter = parseRetryAfter(e.message ?? '');
    return NextResponse.json(
      {
        error:
          retryAfter
            ? `Daily LLM quota reached. Resets in ${retryAfter}.`
            : 'Daily LLM quota reached. Try again later.',
      },
      { status: 429 }
    );
  }
  return NextResponse.json({ error: 'LLM unavailable. Try again.' }, { status: 502 });
}

function parseRetryAfter(msg: string): string | null {
  // Matches "Please try again in 3m55.008s" / "in 124s" / "in 2m3.5s" etc.
  const match = msg.match(/try again in (\d+m)?\s?(\d+(?:\.\d+)?)s/i);
  if (!match) return null;
  const minutes = match[1] ? parseInt(match[1], 10) : 0;
  const seconds = Math.round(parseFloat(match[2]));
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ── result shape coercion ─────────────────────────────────────────────────────

const VALID_RESULT_SHAPES: ResultShape[] = ['ranking', 'filter', 'comparison', 'aggregate'];

function coerceResultShape(raw: unknown): ResultShape | undefined {
  return typeof raw === 'string' && (VALID_RESULT_SHAPES as readonly string[]).includes(raw)
    ? (raw as ResultShape)
    : undefined;
}

// ── request validation ────────────────────────────────────────────────────────

const RequestSchema = z.object({ question: z.string().min(1).max(500) });

// ── route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const { question } = parsed.data;

  // Cache: same question within session → skip the LLM round trip entirely.
  const cached = responseCache.get(cacheKey(question));
  if (cached) {
    return NextResponse.json(cached, { status: 200 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!apiKey || !supaUrl || !supaKey) {
    console.error('[ask] Missing required env vars');
    return NextResponse.json({ error: 'Server configuration error.' }, { status: 500 });
  }
  const groq = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });

  // First call: classify + draft response. SQL retries get a second LLM call below.
  let llmJson: Record<string, unknown>;
  try {
    const completion = await groq.chat.completions.create({
      model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? '{}';
    llmJson = JSON.parse(raw);
  } catch (err) {
    return handleLlmError(err);
  }

  const kind = llmJson.kind;

  // ── kind: navigation ─────────────────────────────────────────────────────
  if (kind === 'navigation') {
    const validation = validateActions(llmJson.actions);
    if (!validation.ok) {
      const fallback: AskResponse = {
        kind: 'out_of_scope',
        narrative: "I tried to interpret that as a navigation command but couldn't.",
        scopeHint: trimScopeHint(
          'Try naming a Panama district directly, e.g. "Show me San Miguelito".'
        ),
      };
      cachePut(question, fallback);
      return NextResponse.json(fallback, { status: 200 });
    }
    const navResponse: AskResponse = {
      kind: 'navigation',
      narrative: typeof llmJson.narrative === 'string' ? llmJson.narrative : '',
      actions: validation.actions,
    };
    cachePut(question, navResponse);
    return NextResponse.json(navResponse, { status: 200 });
  }

  // ── kind: out_of_scope ───────────────────────────────────────────────────
  if (kind === 'out_of_scope') {
    const oosResponse: AskResponse = {
      kind: 'out_of_scope',
      narrative: typeof llmJson.narrative === 'string' ? llmJson.narrative : '',
      scopeHint: trimScopeHint(llmJson.scopeHint),
    };
    cachePut(question, oosResponse);
    return NextResponse.json(oosResponse, { status: 200 });
  }

  // ── kind: data (default + retry on validation failure) ───────────────────
  if (kind !== 'data') {
    const unknownResponse: AskResponse = {
      kind: 'out_of_scope',
      narrative: 'I could not classify that question.',
      scopeHint: trimScopeHint(
        'Try a Panama-specific access question, e.g. "Top 5 districts with the worst walking access for high schoolers".'
      ),
    };
    cachePut(question, unknownResponse);
    return NextResponse.json(unknownResponse, { status: 200 });
  }

  let sql = typeof llmJson.sql === 'string' ? llmJson.sql.trim() : '';
  let narrative = typeof llmJson.narrative === 'string' ? llmJson.narrative : '';
  let resultShape = coerceResultShape(llmJson.resultShape);

  let validation = validateSQL(sql);

  // One retry, telling the model what failed
  if (!validation.ok) {
    try {
      const retry = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
        response_format: { type: 'json_object' },
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Previous SQL failed validation: "${validation.reason}". Original question: ${question}`,
          },
        ],
      });
      const raw = retry.choices[0]?.message?.content ?? '{}';
      const retryJson = JSON.parse(raw) as Record<string, unknown>;
      if (retryJson.kind !== 'data' || typeof retryJson.sql !== 'string') {
        return NextResponse.json(
          { error: `Generated SQL failed validation: ${validation.reason}`, sql },
          { status: 422 }
        );
      }
      sql = retryJson.sql.trim();
      narrative = typeof retryJson.narrative === 'string' ? retryJson.narrative : narrative;
      resultShape = coerceResultShape(retryJson.resultShape) ?? resultShape;
      validation = validateSQL(sql);
    } catch (err) {
      return handleLlmError(err);
    }
  }

  if (!validation.ok) {
    return NextResponse.json(
      { error: `Generated SQL failed validation: ${validation.reason}`, sql },
      { status: 422 }
    );
  }

  // Execute via the run_sql Postgres function (service_role only)
  const supabase = createClient(supaUrl, supaKey);
  const { data, error: dbError } = await supabase.rpc('run_sql', { query: sql });
  if (dbError) {
    console.error('[ask] DB error:', dbError);
    return NextResponse.json({ error: 'Query execution failed.', sql }, { status: 422 });
  }

  const rows = (data as Record<string, unknown>[]) ?? [];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const highlightCodDist = rows
    .map((r) => r.cod_dist)
    .filter((c): c is string => typeof c === 'string');

  const dataResponse: AskResponse = {
    kind: 'data',
    sql,
    columns,
    rows,
    highlightCodDist,
    resultShape,
    narrative,
  };
  cachePut(question, dataResponse);
  return NextResponse.json(dataResponse, { status: 200 });
}
