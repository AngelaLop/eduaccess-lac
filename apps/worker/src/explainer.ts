/**
 * Deterministic Robustness Explainer (v4)
 *
 * For every cell we have 3 numeric scores from scores.ts; this module
 * composes a one-sentence narrative plus 1-3 specific caveats, both
 * grounded in those numbers.
 *
 * Why deterministic, not LLM:
 *  - Faster (no network), free (no tokens), idempotent.
 *  - Easier to defend to a minister: "the same scores always produce the
 *    same explanation" beats "the model wrote it differently each time".
 *  - Stays available when Groq quota is exhausted.
 *
 * The LLM is reserved for one job per refresh per country (the audit
 * brief in country-brief.ts).
 */

import { createHash } from 'node:crypto';
import type { IndicatorCell, CellScores } from './scores.js';

export interface ExplainerOutput {
  narrative: string;
  caveats: string[];
  input_hash: string;
}

/** Bump when scoring thresholds or text templates change. v4: 3-dimension model. */
export const FACTS_VERSION = 2;

function band(score: number): 'high' | 'moderate' | 'low' | 'very low' {
  if (score >= 80) return 'high';
  if (score >= 60) return 'moderate';
  if (score >= 30) return 'low';
  return 'very low';
}

function methodDelta(c: IndicatorCell): number | null {
  if (c.pct_le30_osrm == null || c.pct_le30 == null) return null;
  return Math.abs(c.pct_le30 - c.pct_le30_osrm);
}

// Phrase fragment for the weakest dimension.
function weakestPhrase(scores: CellScores, c: IndicatorCell): string {
  switch (scores.weakest) {
    case 'data_completeness': {
      return 'the accessibility value for this cell is incomplete, so the % cannot be fully trusted';
    }
    case 'sample_size': {
      const n = c.pop_total ?? 0;
      return `the population in this cell is small (${n.toLocaleString()} people), so the % can swing on small changes`;
    }
    case 'method_agreement': {
      const delta = methodDelta(c);
      return delta != null
        ? `the FMM and OSRM routing methods disagree by ${delta.toFixed(0)} points on the % within 30 min`
        : 'only one routing method (FMM) is available, so the travel-time estimate cannot be cross-checked';
    }
  }
}

function headline(scores: CellScores): string {
  switch (band(scores.composite)) {
    case 'high':
      return 'This number is trustworthy';
    case 'moderate':
      return 'This number is moderately trustworthy';
    case 'low':
      return 'This number should be treated with caution';
    case 'very low':
      return 'This number is weak and should not drive a decision on its own';
  }
}

// Produce 1-3 specific caveats, ordered by severity (weakest first).
function caveatsFor(c: IndicatorCell, scores: CellScores): string[] {
  const items: { score: number; text: string }[] = [];

  if (scores.data_completeness < 80) {
    items.push({
      score: scores.data_completeness,
      text: 'the underlying accessibility value is incomplete for this cell',
    });
  }
  if (scores.sample_size < 60) {
    items.push({
      score: scores.sample_size,
      text: `sample is small (${(c.pop_total ?? 0).toLocaleString()} people) — the % is statistically noisy`,
    });
  }
  const delta = methodDelta(c);
  if (delta == null) {
    items.push({
      score: scores.method_agreement,
      text: 'only FMM routing is available — no OSRM cross-check on travel time',
    });
  } else if (delta >= 10) {
    items.push({
      score: scores.method_agreement,
      text: `FMM and OSRM routing differ by ${delta.toFixed(0)} points — the travel-time estimate is method-sensitive here`,
    });
  }

  items.sort((a, b) => a.score - b.score);
  return items.slice(0, 3).map((i) => i.text);
}

function hashInput(c: IndicatorCell, scores: CellScores): string {
  const payload = JSON.stringify({
    country_iso: c.country_iso,
    admin2_pcode: c.admin2_pcode,
    education_level: c.education_level,
    transport_mode: c.mode,
    pct_le30: c.pct_le30,
    pct_le30_osrm: c.pct_le30_osrm,
    pop_total: c.pop_total,
    scores,
    facts_version: FACTS_VERSION,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function explainCell(c: IndicatorCell, scores: CellScores): ExplainerOutput {
  // No population at all — the numeric scores already capture this; the
  // narrative needs to say so plainly.
  if ((c.pop_total ?? 0) <= 0) {
    return {
      narrative:
        'No school-age population is recorded in this cell for this education level, so the accessibility number is not meaningful.',
      caveats: ['Population is zero in the source — no travel-time computation is informative here'],
      input_hash: hashInput(c, scores),
    };
  }

  const lead = headline(scores);
  const weak = weakestPhrase(scores, c);
  const narrative = `${lead}: ${weak}.`;
  const caveats = caveatsFor(c, scores);
  return { narrative, caveats, input_hash: hashInput(c, scores) };
}
