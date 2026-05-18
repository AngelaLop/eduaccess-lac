/**
 * POST /api/ask  { question: string, country?: 'PAN' | 'COL' }
 * → AskResponse — one of three kinds: data | navigation | out_of_scope
 *
 * The LLM is a router that classifies the question into one of three
 * response kinds and returns the matching shape from the AskResponse
 * contract in lib/types.ts.
 *
 *   data        → SQL query on v_indicators_adm2 (pinned to the active country)
 *   navigation  → UI actions only, no DB call
 *   out_of_scope→ guidance hint, no DB call
 *
 * v4: multi-country. Every request carries the active country; the system
 * prompt, the district roster, and the SQL validator are all scoped to it.
 *
 * Codex second-pass review target.
 */

import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { validateSQL } from '@/lib/sql-validator';
import { createRateLimiter, ipFromHeaders } from '@/lib/rate-limit';
import districtRoster from '@/lib/district-roster.json';
import { COUNTRIES, type CountryIso, type AskAction, type AskResponse, type EducationLevel, type ResultShape, type TransportMode } from '@/lib/types';

// 30 requests / 15 min per IP — closes the door on a script looping the
// endpoint and draining the Groq quota for everyone else.
const askRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });

// ── district roster ───────────────────────────────────────────────────────────

interface DistrictRow {
  admin2_pcode: string;
  admin2_name: string;
  admin1_name: string;
}

const ROSTER = districtRoster as Record<string, DistrictRow[]>;

function districtsFor(country: CountryIso): DistrictRow[] {
  return ROSTER[country] ?? [];
}

// Accent-/punctuation-insensitive key for district-name resolution.
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve an LLM-supplied district reference (a name, or already a code) to a
 * real admin2_pcode for the country. Returns null when there is no match OR
 * when a bare name is ambiguous (district names repeat across provinces — e.g.
 * Colombia has 68 duplicated names). An optional `admin1` (province) hint
 * disambiguates. Ambiguous → null so the route falls back to out_of_scope
 * rather than silently focusing the wrong district.
 *
 * The full roster is NOT sent to the LLM — embedding ~1,100 Colombian
 * districts blew past Groq's per-minute token limit. The LLM returns the
 * district name the user gave; resolution happens here.
 */
function resolveDistrict(country: CountryIso, ref: string, admin1?: string): string | null {
  const roster = districtsFor(country);
  if (roster.some((d) => d.admin2_pcode === ref)) return ref;
  const key = normalizeName(ref);
  let matches = roster.filter((d) => normalizeName(d.admin2_name) === key);
  if (matches.length > 1 && admin1) {
    const a1 = normalizeName(admin1);
    matches = matches.filter((d) => normalizeName(d.admin1_name) === a1);
  }
  return matches.length === 1 ? matches[0].admin2_pcode : null;
}

// ── response cache ──────────────────────────────────────────────────────────────
// In-memory question→response cache; keyed on country + lowercased question.

const responseCache = new Map<string, AskResponse>();
const CACHE_MAX = 200;
function cacheKey(country: CountryIso, q: string) {
  return `${country}::${q.trim().toLowerCase()}`;
}
function cachePut(country: CountryIso, q: string, r: AskResponse) {
  if (responseCache.size >= CACHE_MAX) {
    const firstKey = responseCache.keys().next().value;
    if (firstKey !== undefined) responseCache.delete(firstKey);
  }
  responseCache.set(cacheKey(country, q), r);
}

// ── system prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(country: CountryIso): string {
  const countryName = COUNTRIES[country].name;
  return `
You are the EduAccess LAC interface agent. This session is scoped to ${countryName} (country_iso='${country}').

For every user question, classify it into ONE of three kinds and return JSON:

  "data"         → answerable by a SQL query on v_indicators_adm2
  "navigation"   → asks to interact with the UI (switch country, focus a
                   district, switch transport mode or education level)
  "out_of_scope" → outside school-access topic, or asks for columns we lack

Always respond as JSON. Never as freeform text. Never mix kinds.

COUNTRY SCOPE: this session is scoped to ${countryName}. The platform also
covers Panama, Colombia, Costa Rica, Ecuador and Peru. If the user's question
is about a DIFFERENT one of those five, return a "navigation" response whose
ONLY action is set_country for that country — the app switches and re-runs the
question there. Countries outside those five are out_of_scope.

============================================================
KIND: "data"
============================================================

Shape: { "kind":"data", "sql":"...", "narrative":"...", "resultShape":"..." }

VIEW: v_indicators_adm2 — one row per district × education_level × mode.
Travel-time accessibility from the FMM routing method (canonical).

COLUMNS:
  country_iso      TEXT    Country ('${country}'). MUST be filtered — see HARD RULES.
  admin2_pcode     TEXT    District code. MUST appear in SELECT for district-level results.
  admin2_name      TEXT    District name
  admin1_name      TEXT    Province / department name
  education_level  TEXT    'primaria' (ages 5-9) | 'secbaja' (10-14) | 'secalta' (15-19)
  mode             TEXT    'walking' | 'motorized'
  pop_total        INT     School-age population in this level
  pct_le15         NUMERIC % within 15 min of a school (0-100)
  pct_le30         NUMERIC % within 30 min (0-100)
  pct_le60         NUMERIC % within 60 min (0-100)
  pct_le30_osrm    NUMERIC % within 30 min by the OSRM routing method (may be null)

HARD RULES — any violation makes the SQL invalid:
1. SELECT only. No INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE.
2. Only reference v_indicators_adm2. No other tables or views.
3. ALWAYS include "country_iso = '${country}'" in the WHERE clause.
4. Include LIMIT N where N ≤ 50.
5. Include admin2_pcode in SELECT for district-level results. Province-level aggregates may omit it.
6. No semicolons. No pg_* functions. No information_schema.

RANKING RULE:
When the user ranks by an access metric (pct_le15, pct_le30, pct_le60), add
"AND pop_total > 0" to the WHERE clause so districts with no school-age
population don't pollute the ranking with a meaningless 0%.

resultShape values:
  "ranking"    → top-N / bottom-N / ORDER BY ... LIMIT
  "filter"     → WHERE filter, returns matching rows without rank semantics
  "comparison" → side-by-side comparison (two levels, two provinces, FMM vs OSRM)
  "aggregate"  → single-row or grouped summary stats

Examples:

Q: Top 5 districts with the worst walking access for upper-secondary students
A: {"kind":"data","sql":"SELECT admin2_pcode, admin2_name, admin1_name, pct_le30 FROM v_indicators_adm2 WHERE country_iso = '${country}' AND education_level = 'secalta' AND mode = 'walking' AND pop_total > 0 ORDER BY pct_le30 ASC LIMIT 5","narrative":"The 5 districts with the lowest share of upper-secondary students within a 30-minute walk of a school.","resultShape":"ranking"}

Q: Districts where FMM and OSRM disagree most on 30-minute walking access
A: {"kind":"data","sql":"SELECT admin2_pcode, admin2_name, pct_le30, pct_le30_osrm, ABS(pct_le30 - pct_le30_osrm) AS gap FROM v_indicators_adm2 WHERE country_iso = '${country}' AND education_level = 'primaria' AND mode = 'walking' AND pct_le30_osrm IS NOT NULL ORDER BY gap DESC LIMIT 20","narrative":"Districts where the two routing methods disagree most on primary-school walking access.","resultShape":"comparison"}

Q: Rank provinces by average % within 15 min of a school
A: {"kind":"data","sql":"SELECT admin1_name, ROUND(AVG(pct_le15),1) AS avg_pct_le15, COUNT(DISTINCT admin2_pcode) AS n_districts FROM v_indicators_adm2 WHERE country_iso = '${country}' AND education_level = 'primaria' AND mode = 'walking' AND pop_total > 0 GROUP BY admin1_name ORDER BY avg_pct_le15 DESC LIMIT 20","narrative":"Province ranking by average share of primary students within a 15-minute walk of a school.","resultShape":"ranking"}

============================================================
KIND: "navigation"
============================================================

Shape: { "kind":"navigation", "narrative":"...", "actions":[ ... ] }

Use this kind when the user wants to interact with the UI without computing
anything new. The frontend executes each action in order.

Action shapes (must match exactly — never invent fields):
  { "type":"set_country", "country":"PAN"|"COL"|"CRI"|"ECU"|"PER" }
  { "type":"select_district", "district":"<district name>", "admin1":"<province, optional>" }
  { "type":"set_transport_mode", "mode":"walking"|"motorized" }
  { "type":"set_education_level", "level":"primaria"|"secbaja"|"secalta" }
  { "type":"focus_panel_tab", "tab":"insight"|"ask" }

For select_district, return the district name exactly as the user said it — the
server resolves it to a code. District names repeat across provinces, so when
the user names a province (e.g. "Buenavista, Sucre") put it in "admin1". If the
user names a place that is not a district of ${countryName}, return out_of_scope.

When focusing a district, also append a focus_panel_tab→insight action so the
panel shows the district detail.

Examples:

Q: Show me the capital district
A: {"kind":"navigation","narrative":"Focusing on that district.","actions":[{"type":"select_district","district":"<the district the user named>"},{"type":"focus_panel_tab","tab":"insight"}]}

Q: (session is Panama) Worst districts in Colombia
A: {"kind":"navigation","narrative":"Switching to Colombia.","actions":[{"type":"set_country","country":"COL"}]}

Q: Switch to motorized
A: {"kind":"navigation","narrative":"Switched to motorized access.","actions":[{"type":"set_transport_mode","mode":"motorized"}]}

Q: Show me primary school data
A: {"kind":"navigation","narrative":"Switched to the primary level.","actions":[{"type":"set_education_level","level":"primaria"}]}

============================================================
KIND: "out_of_scope"
============================================================

Shape: { "kind":"out_of_scope", "narrative":"...", "scopeHint":"..." }

Use this kind when the question is outside our coverage:
- Countries outside the five we cover (Panama, Colombia, Costa Rica, Ecuador,
  Peru). For one of those five, use a set_country navigation action instead.
- Indicators we don't have (enrollment, test scores, teacher counts, school
  quality, hospitals, infrastructure other than schools, transit routes)
- Time series / trends / "how has X changed" — we hold a single snapshot
- General knowledge, math, code, or anything unrelated to school access

narrative: one sentence acknowledging what the user asked and stating why we
can't answer it from this data.
scopeHint: ≤ 280 chars, must reference at least one example prompt the user
can try instead. Be concrete.

Examples:

Q: What about Mexico?
A: {"kind":"out_of_scope","narrative":"The platform covers Panama, Colombia, Costa Rica, Ecuador and Peru — Mexico is not included.","scopeHint":"Try a ${countryName} question, e.g. \\"Top 5 districts with the worst walking access for upper-secondary students\\"."}

Q: What's 2 + 2?
A: {"kind":"out_of_scope","narrative":"I'm scoped to ${countryName} school accessibility data, not general questions.","scopeHint":"Try \\"Rank provinces by average % within 15 min of a school\\"."}
`.trim();
}

// ── action validator ──────────────────────────────────────────────────────────

const VALID_EDUCATION_LEVELS: EducationLevel[] = ['primaria', 'secbaja', 'secalta'];
const VALID_TRANSPORT_MODES: TransportMode[] = ['walking', 'motorized'];
const VALID_PANEL_TABS = ['insight', 'ask'] as const;

type ActionValidation =
  | { ok: true; actions: AskAction[] }
  | { ok: false; reason: string };

function validateActions(raw: unknown, country: CountryIso): ActionValidation {
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
      case 'set_country': {
        const c = a.country;
        if (typeof c !== 'string' || !(c in COUNTRIES)) {
          return { ok: false, reason: `invalid country: ${String(c)}` };
        }
        validated.push({ type: 'set_country', country: c as CountryIso });
        break;
      }
      case 'select_district': {
        const ref = a.district ?? a.admin2_pcode;
        if (typeof ref !== 'string' || !ref.trim()) {
          return { ok: false, reason: 'select_district needs a district name' };
        }
        const admin1 = typeof a.admin1 === 'string' ? a.admin1 : undefined;
        const code = resolveDistrict(country, ref, admin1);
        if (!code) {
          return { ok: false, reason: `unknown or ambiguous district: ${ref}` };
        }
        validated.push({ type: 'select_district', admin2_pcode: code });
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
        if (typeof level !== 'string' || !VALID_EDUCATION_LEVELS.includes(level as EducationLevel)) {
          return { ok: false, reason: `invalid education level: ${String(level)}` };
        }
        validated.push({ type: 'set_education_level', level: level as EducationLevel });
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
        error: retryAfter
          ? `Daily LLM quota reached. Resets in ${retryAfter}.`
          : 'Daily LLM quota reached. Try again later.',
      },
      { status: 429 }
    );
  }
  return NextResponse.json({ error: 'LLM unavailable. Try again.' }, { status: 502 });
}

function parseRetryAfter(msg: string): string | null {
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

const RequestSchema = z.object({
  question: z.string().min(1).max(500),
  country: z.enum(['PAN', 'COL', 'CRI', 'ECU', 'PER']).default('PAN'),
});

// ── route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Per-IP rate limit BEFORE parsing the body.
  const ip = ipFromHeaders(req.headers);
  const gate = askRateLimiter(ip);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${gate.retryAfterSec}s.` },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfterSec) } }
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const { question, country } = parsed.data;

  // Cache: same question + country within session → skip the LLM round trip.
  const cached = responseCache.get(cacheKey(country, question));
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
  const systemPrompt = buildSystemPrompt(country);

  // First call: classify + draft response.
  let llmJson: Record<string, unknown>;
  try {
    const completion = await groq.chat.completions.create({
      model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
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
    const validation = validateActions(llmJson.actions, country);
    if (!validation.ok) {
      const fallback: AskResponse = {
        kind: 'out_of_scope',
        narrative: "I tried to interpret that as a navigation command but couldn't.",
        scopeHint: trimScopeHint(
          `Try naming a ${COUNTRIES[country].name} district directly.`
        ),
      };
      cachePut(country, question, fallback);
      return NextResponse.json(fallback, { status: 200 });
    }
    const navResponse: AskResponse = {
      kind: 'navigation',
      narrative: typeof llmJson.narrative === 'string' ? llmJson.narrative : '',
      actions: validation.actions,
    };
    cachePut(country, question, navResponse);
    return NextResponse.json(navResponse, { status: 200 });
  }

  // ── kind: out_of_scope ───────────────────────────────────────────────────
  if (kind === 'out_of_scope') {
    const oosResponse: AskResponse = {
      kind: 'out_of_scope',
      narrative: typeof llmJson.narrative === 'string' ? llmJson.narrative : '',
      scopeHint: trimScopeHint(llmJson.scopeHint),
    };
    cachePut(country, question, oosResponse);
    return NextResponse.json(oosResponse, { status: 200 });
  }

  // ── kind: data (default + retry on validation failure) ───────────────────
  if (kind !== 'data') {
    const unknownResponse: AskResponse = {
      kind: 'out_of_scope',
      narrative: 'I could not classify that question.',
      scopeHint: trimScopeHint(
        'Try an access question, e.g. "Top 5 districts with the worst walking access for upper-secondary students".'
      ),
    };
    cachePut(country, question, unknownResponse);
    return NextResponse.json(unknownResponse, { status: 200 });
  }

  let sql = typeof llmJson.sql === 'string' ? llmJson.sql.trim() : '';
  let narrative = typeof llmJson.narrative === 'string' ? llmJson.narrative : '';
  let resultShape = coerceResultShape(llmJson.resultShape);

  let validation = validateSQL(sql, country);

  // One retry, telling the model what failed
  if (!validation.ok) {
    try {
      const retry = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
        response_format: { type: 'json_object' },
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
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
      validation = validateSQL(sql, country);
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

  // Hard-scope the data source to the active country: replace the view with a
  // country-filtered subquery. The query then cannot read other countries'
  // rows no matter what WHERE clause the LLM wrote — defence in depth around
  // checkCountryFilter. `country` is a validated enum, safe to interpolate.
  const scopedSql = sql.replace(
    /\bFROM\s+v_indicators_adm2\b/i,
    `FROM (SELECT * FROM v_indicators_adm2 WHERE country_iso = '${country}') v_indicators_adm2`
  );

  // Execute via the run_sql Postgres function (service_role only)
  const supabase = createClient(supaUrl, supaKey);
  const { data, error: dbError } = await supabase.rpc('run_sql', { query: scopedSql });
  if (dbError) {
    console.error('[ask] DB error:', dbError);
    return NextResponse.json({ error: 'Query execution failed.', sql }, { status: 422 });
  }

  const rows = (data as Record<string, unknown>[]) ?? [];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const highlightAdm2 = rows
    .map((r) => r.admin2_pcode)
    .filter((c): c is string => typeof c === 'string');

  const dataResponse: AskResponse = {
    kind: 'data',
    sql,
    columns,
    rows,
    highlightAdm2,
    resultShape,
    narrative,
  };
  cachePut(country, question, dataResponse);
  return NextResponse.json(dataResponse, { status: 200 });
}
