/**
 * POST /api/ask  { question: string }
 * → { sql, columns, rows, highlightCodDist, narrative }
 *
 * LLM: Groq + Llama 3.3 70B via OpenAI-compatible SDK.
 * SQL is validated before execution. LLM sees only v_panama_indicators.
 * Codex second-pass review target (prompt engineering + validator integration).
 */

import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { validateSQL } from '@/lib/sql-validator';

// ── schema prompt ─────────────────────────────────────────────────────────────

const SCHEMA_PROMPT = `
You are a SQL assistant for the EduAccess LAC platform.
Generate a single SQL SELECT query against v_panama_indicators and return JSON
with exactly two keys: "sql" (the query string) and "narrative" (one sentence summary).

VIEW: v_panama_indicators
One row per Panama district × age_group.
Canonical scenario: WorldPop population + MAP friction surface + walking transport.

COLUMNS:
  cod_dist             TEXT    District code (4-char zero-padded string), MUST appear in SELECT
  nomb_dist            TEXT    District name
  nomb_prov            TEXT    Province name
  age_group            TEXT    'all' | 'primary' | 'secondary' | 'highschool'
  pop_total            INT     Population in this age group
  pop_le15             INT     Population within 15 min walk of nearest school
  pop_le30             INT     Population within 30 min walk
  pop_le60             INT     Population within 60 min walk
  pop_nodata           INT     Population with no travel-time data
  pct_le15             NUMERIC % within 15 min (0-100)
  pct_le30             NUMERIC % within 30 min (0-100)
  pct_le60             NUMERIC % within 60 min (0-100)
  data_completeness_pct NUMERIC % of population with usable travel-time data

HARD RULES — any violation makes the SQL invalid:
1. SELECT only. No INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE.
2. Only reference v_panama_indicators. No other tables or views.
3. Include LIMIT N where N ≤ 50.
4. Include cod_dist in SELECT for district-level results (needed for map highlights). Province-level aggregates may omit it.
5. No semicolons. No pg_* functions. No information_schema.

EXAMPLES:

Q: Top 5 districts with worst high-school walking access
{"sql":"SELECT cod_dist, nomb_dist, nomb_prov, pct_le30 FROM v_panama_indicators WHERE age_group = 'highschool' ORDER BY pct_le30 ASC LIMIT 5","narrative":"The 5 districts with the lowest share of high schoolers within 30 minutes walk of a school."}

Q: Districts where over 1000 high schoolers are more than 30 min from a school
{"sql":"SELECT cod_dist, nomb_dist, nomb_prov, pop_total - pop_le30 AS unreachable FROM v_panama_indicators WHERE age_group = 'highschool' AND (pop_total - pop_le30) > 1000 ORDER BY unreachable DESC LIMIT 20","narrative":"Districts with more than 1,000 high schoolers who cannot reach a school within 30 minutes walking."}

Q: Compare primary vs high school access in Panama province
{"sql":"SELECT cod_dist, nomb_dist, age_group, pct_le30 FROM v_panama_indicators WHERE nomb_prov = 'Panama' AND age_group IN ('primary','highschool') ORDER BY cod_dist, age_group LIMIT 50","narrative":"Comparison of walking access between primary and high school students in Panama province."}

Q: Districts where over 20% of population lacks travel-time data
{"sql":"SELECT cod_dist, nomb_dist, nomb_prov, data_completeness_pct FROM v_panama_indicators WHERE data_completeness_pct < 80 AND age_group = 'all' ORDER BY data_completeness_pct ASC LIMIT 20","narrative":"Districts where more than 20% of school-age population lacks travel-time coverage — indicators here carry more uncertainty."}

Q: Rank provinces by average % within 15 minutes of a school
{"sql":"SELECT nomb_prov, ROUND(AVG(pct_le15),1) AS avg_pct_le15, COUNT(DISTINCT cod_dist) AS n_districts FROM v_panama_indicators WHERE age_group = 'all' GROUP BY nomb_prov ORDER BY avg_pct_le15 DESC LIMIT 20","narrative":"Province ranking by average share of school-age population within 15 minutes walk of a school."}
`.trim();

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

  const apiKey = process.env.GROQ_API_KEY;
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!apiKey || !supaUrl || !supaKey) {
    console.error('[ask] Missing required env vars');
    return NextResponse.json({ error: 'Server configuration error.' }, { status: 500 });
  }
  const groq = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });
  const supabase = createClient(supaUrl, supaKey);

  let sql = '';
  let narrative = '';
  let lastError = '';

  // Up to 2 LLM attempts — on the second attempt, tell the model what went wrong
  for (let attempt = 1; attempt <= 2; attempt++) {
    const userMsg =
      attempt === 1
        ? question
        : `The previous SQL failed validation: "${lastError}". Fix it.\nOriginal question: ${question}`;

    let raw: string;
    try {
      const completion = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
        response_format: { type: 'json_object' },
        temperature: 0,
        messages: [
          { role: 'system', content: SCHEMA_PROMPT },
          { role: 'user', content: userMsg },
        ],
      });
      raw = completion.choices[0]?.message?.content ?? '{}';
    } catch {
      return NextResponse.json({ error: 'LLM unavailable. Try again.' }, { status: 502 });
    }

    let llmJson: { sql?: string; narrative?: string };
    try {
      llmJson = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'LLM returned malformed JSON.' }, { status: 502 });
    }

    sql = (llmJson.sql ?? '').trim();
    narrative = llmJson.narrative ?? '';

    const validation = validateSQL(sql);
    if (validation.ok) break;

    lastError = validation.reason;
    if (attempt === 2) {
      return NextResponse.json(
        { error: `Generated SQL failed validation: ${validation.reason}`, sql },
        { status: 422 }
      );
    }
  }

  // Execute via the run_sql Postgres function (service_role only)
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

  return NextResponse.json({ sql, columns, rows, highlightCodDist, narrative });
}
