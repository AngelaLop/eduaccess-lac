/**
 * Robustness Auditor agent — the LLM piece.
 *
 * Input: a cell's numeric scores + minimal indicator context.
 * Output: { score_overall, weakest_dimension, narrative, caveats[] }
 *
 * The numeric scores ARE the answer. The LLM's job is interpretation:
 *  - confirm or override the composite score (it can downweight if context warrants)
 *  - write a one-sentence narrative for a non-technical reader
 *  - list 1-3 specific caveats
 */

import { groq, MODEL } from './llm.js';
import type { CellBundle, CellScores } from './scores.js';

const SYSTEM_PROMPT = `
You are the Robustness Auditor for the EduAccess LAC platform.

For each Panama district cell, you receive 4 numeric robustness scores
(0-100, higher = more trustworthy) and minimal context. You return JSON:

{
  "score_overall": <0-100, integer>,
  "weakest_dimension": "data_completeness" | "sample_size" | "friction_agreement" | "pop_agreement",
  "narrative": "<one short sentence, written for a non-technical reader>",
  "caveats": ["<string>", "<string>"]   // 1-3 short specific caveats
}

The 4 dimensions:
- data_completeness  — % of population with usable travel-time data
- sample_size        — log-scaled population (small populations are noisier)
- friction_agreement — MAP vs OSM friction surfaces agree on % within 30 min
- pop_agreement      — WorldPop vs Census population sources agree

RULES:
1. score_overall starts from the suggested composite; you may shift it up to 10 points
   either way if context warrants. Most of the time, return the composite as-is.
2. weakest_dimension must be exactly one of the 4 strings above — pick the lowest score.
3. narrative should NAME the weakest dimension in plain language and say what it
   means for trusting the pct_le30 number. Avoid jargon.
4. caveats should be SPECIFIC to this cell, not generic. Reference the actual numbers
   when useful (e.g., "MAP and OSM disagree by 18 points").
5. Output JSON only. No markdown. No prose around it.

Examples:

INPUT:
  district: Santa Fe (Darien), age_group: highschool, transport_mode: walking
  pct_le30 (canonical): 0
  scores: completeness=12, sample=85, friction_agree=42, pop_agree=78
  composite suggestion: 50

OUTPUT:
{"score_overall":50,"weakest_dimension":"data_completeness","narrative":"Only 12% of the high-school population in this district has usable travel-time data — treat the 0% access reading as a strong signal but not a precise number.","caveats":["88% of the population lacks travel-time coverage in this scenario","MAP and OSM friction surfaces disagree by 58 points — typical for jungle terrain in Darien","Sample size is adequate but not large; the 0% may shift if more population coverage becomes available"]}

INPUT:
  district: San Miguelito (Panama), age_group: highschool, transport_mode: walking
  pct_le30 (canonical): 99.98
  scores: completeness=99, sample=100, friction_agree=92, pop_agree=88
  composite suggestion: 95

OUTPUT:
{"score_overall":95,"weakest_dimension":"pop_agreement","narrative":"This number is highly reliable: nearly all high schoolers in San Miguelito are accounted for, and both friction surfaces and population sources agree closely.","caveats":["WorldPop and Census disagree by 12 points on the underlying population — the % within 30 min could shift modestly if you switch sources"]}
`.trim();

export interface AuditorOutput {
  score_overall: number;
  weakest_dimension: 'data_completeness' | 'sample_size' | 'friction_agreement' | 'pop_agreement';
  narrative: string;
  caveats: string[];
}

export async function auditCell(
  bundle: CellBundle,
  scores: CellScores
): Promise<AuditorOutput> {
  const userPrompt = [
    `district: ${bundle.nomb_dist} (${bundle.nomb_prov})`,
    `age_group: ${bundle.age_group}`,
    `transport_mode: ${bundle.transport_mode}`,
    `pct_le30 (canonical): ${bundle.canonical.pct_le30}`,
    `pop_total (canonical): ${bundle.canonical.pop_total}`,
    `pop_nodata (canonical): ${bundle.canonical.pop_nodata}`,
    `scores: completeness=${scores.data_completeness}, sample=${scores.sample_size}, friction_agree=${scores.friction_agreement}, pop_agree=${scores.pop_agreement}`,
    `composite suggestion: ${scores.composite}`,
    `suggested weakest: ${scores.weakest}`,
  ].join('\n');

  const completion = await groq.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw) as Partial<AuditorOutput>;

  // Defensive coercion — fall back to numeric scores if LLM returns garbage
  const validDims = [
    'data_completeness',
    'sample_size',
    'friction_agreement',
    'pop_agreement',
  ] as const;
  const weakest =
    typeof parsed.weakest_dimension === 'string' &&
    (validDims as readonly string[]).includes(parsed.weakest_dimension)
      ? (parsed.weakest_dimension as AuditorOutput['weakest_dimension'])
      : scores.weakest;

  const score_overall =
    typeof parsed.score_overall === 'number' && parsed.score_overall >= 0 && parsed.score_overall <= 100
      ? Math.round(parsed.score_overall)
      : Math.round(scores.composite);

  const narrative =
    typeof parsed.narrative === 'string' && parsed.narrative.trim().length > 0
      ? parsed.narrative.trim()
      : 'Numeric robustness scores were computed; narrative unavailable.';

  const caveats = Array.isArray(parsed.caveats)
    ? parsed.caveats.filter((c): c is string => typeof c === 'string').slice(0, 3)
    : [];

  return { score_overall, weakest_dimension: weakest, narrative, caveats };
}
