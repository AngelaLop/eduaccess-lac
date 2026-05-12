/**
 * Deterministic Robustness Explainer
 *
 * Replaces the v2 per-cell LLM call. For every cell we have 4 numeric
 * scores from scores.ts; this module composes a one-sentence narrative
 * plus 1-3 specific caveats, both grounded in those numbers.
 *
 * Why deterministic, not LLM:
 *  - Faster (no network), free (no tokens), idempotent.
 *  - Easier to defend to a minister: "the same scores always produce the
 *    same explanation" beats "the model wrote it differently each time".
 *  - Stays available when Groq quota is exhausted.
 *
 * The LLM is reserved for one job per refresh per country (the audit
 * brief in country-brief.ts) and for on-demand polish on cells the user
 * actually opens (v4: /api/audit-cell).
 */

import { createHash } from 'node:crypto';
import type { CellBundle, CellScores } from './scores.js';

export interface ExplainerOutput {
  narrative: string;
  caveats: string[];
  input_hash: string;
}

/** Bump when scoring thresholds or text templates change. */
export const FACTS_VERSION = 1;

// Score-band labels used in narrative text.
function band(score: number): 'high' | 'moderate' | 'low' | 'very low' {
  if (score >= 80) return 'high';
  if (score >= 60) return 'moderate';
  if (score >= 30) return 'low';
  return 'very low';
}

// Phrase fragments for the weakest dimension. Kept short and specific so
// the sentence reads naturally without resembling a templated form letter.
function weakestPhrase(scores: CellScores, c: CellBundle): string {
  switch (scores.weakest) {
    case 'data_completeness': {
      const pct = scores.data_completeness; // already 0-100
      return `only ${pct.toFixed(0)}% of the population in this cell has usable travel-time data`;
    }
    case 'sample_size': {
      const n = c.canonical.pop_total;
      return `the population in this cell is small (${n.toLocaleString()} people), so the % can swing on small changes`;
    }
    case 'friction_agreement': {
      const delta = c.worldpop_osm
        ? Math.abs(c.canonical.pct_le30 - c.worldpop_osm.pct_le30).toFixed(0)
        : null;
      return delta
        ? `the MAP and OSM friction surfaces disagree by ${delta} points on the % within 30 min`
        : 'only one friction surface is available, so we cannot cross-check the travel-time model';
    }
    case 'pop_agreement': {
      const delta = c.census_map
        ? Math.abs(c.canonical.pct_le30 - c.census_map.pct_le30).toFixed(0)
        : null;
      return delta
        ? `WorldPop and Census disagree by ${delta} points on the underlying population, which moves the %`
        : 'only one population source is available, so the underlying head-count is not cross-checked';
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

// Produce 1-3 specific caveats, ordered by severity (weakest first), but
// only including dimensions that meaningfully degrade the cell.
function caveatsFor(c: CellBundle, scores: CellScores): string[] {
  const items: { dim: keyof CellScores; score: number; text: string }[] = [];

  if (scores.data_completeness < 80) {
    items.push({
      dim: 'data_completeness',
      score: scores.data_completeness,
      text: `${(100 - scores.data_completeness).toFixed(0)}% of the population lacks travel-time coverage in this scenario`,
    });
  }
  if (scores.sample_size < 60) {
    items.push({
      dim: 'sample_size',
      score: scores.sample_size,
      text: `sample is small (${c.canonical.pop_total.toLocaleString()} people) — the % is statistically noisy`,
    });
  }
  if (c.worldpop_osm) {
    const delta = Math.abs(c.canonical.pct_le30 - c.worldpop_osm.pct_le30);
    if (delta >= 10) {
      items.push({
        dim: 'friction_agreement',
        score: scores.friction_agreement,
        text: `MAP vs OSM friction surfaces differ by ${delta.toFixed(0)} points — travel-time model is uncertain here`,
      });
    }
  } else {
    items.push({
      dim: 'friction_agreement',
      score: scores.friction_agreement,
      text: 'only one friction surface is available — no cross-check on travel-time',
    });
  }
  if (c.census_map) {
    const delta = Math.abs(c.canonical.pct_le30 - c.census_map.pct_le30);
    if (delta >= 10) {
      items.push({
        dim: 'pop_agreement',
        score: scores.pop_agreement,
        text: `WorldPop vs Census disagree by ${delta.toFixed(0)} points on population — the % shifts with the source`,
      });
    }
  } else {
    items.push({
      dim: 'pop_agreement',
      score: scores.pop_agreement,
      text: 'only one population source is available — no cross-check on head-count',
    });
  }

  // Sort by score ascending (worst first), keep top 3.
  items.sort((a, b) => a.score - b.score);
  return items.slice(0, 3).map((i) => i.text);
}

function hashInput(c: CellBundle, scores: CellScores): string {
  // Hash the numeric inputs that drive the explanation. If any input
  // changes, the hash changes, and downstream cache-invalidation works.
  const payload = JSON.stringify({
    cod_dist: c.cod_dist,
    age_group: c.age_group,
    transport_mode: c.transport_mode,
    pct_le30_canonical: c.canonical.pct_le30,
    pct_le30_osm: c.worldpop_osm?.pct_le30 ?? null,
    pct_le30_census: c.census_map?.pct_le30 ?? null,
    pop_total: c.canonical.pop_total,
    pop_nodata: c.canonical.pop_nodata,
    scores,
    facts_version: FACTS_VERSION,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function explainCell(c: CellBundle, scores: CellScores): ExplainerOutput {
  // Special case: pop_total = 0 — the cell has no people at all. The
  // numeric scores already capture this (everything is 0), but the
  // narrative needs to say so plainly.
  if (c.canonical.pop_total <= 0) {
    return {
      narrative:
        'No school-age population is recorded in this cell for this age group, so the accessibility number is not meaningful.',
      caveats: ['Population is zero in the canonical source — no travel-time computation is informative here'],
      input_hash: hashInput(c, scores),
    };
  }

  const lead = headline(scores);
  const weak = weakestPhrase(scores, c);
  const narrative = `${lead}: ${weak}.`;
  const caveats = caveatsFor(c, scores);
  return { narrative, caveats, input_hash: hashInput(c, scores) };
}
