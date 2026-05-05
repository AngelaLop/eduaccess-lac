/**
 * Deterministic scorers — the 4 numeric dimensions of robustness.
 * Each returns 0-100. Higher = more trustworthy.
 *
 * The LLM never touches these. It only writes the narrative on top.
 */

export type AgeGroup = 'all' | 'primary' | 'secondary' | 'highschool';
export type TransportMode = 'walking' | 'motorized';

// One row in panama_district_indicators, narrowed to the columns the worker uses
export interface ScenarioRow {
  cod_dist: string;
  nomb_dist: string;
  nomb_prov: string;
  age_group: AgeGroup;
  pop_source: 'worldpop' | 'census';
  friction_source: 'map' | 'osm';
  friction: TransportMode;
  pop_total: number;
  pop_nodata: number;
  pct_le30: number;
}

/** Bundle of 4 scenarios for a single (district x age_group x transport_mode) cell. */
export interface CellBundle {
  cod_dist: string;
  nomb_dist: string;
  nomb_prov: string;
  age_group: AgeGroup;
  transport_mode: TransportMode;
  // canonical scenario: worldpop pop + MAP friction
  canonical: ScenarioRow;
  // for friction_agreement: worldpop pop + OSM friction
  worldpop_osm: ScenarioRow | null;
  // for pop_agreement: census pop + MAP friction
  census_map: ScenarioRow | null;
}

export interface CellScores {
  data_completeness: number;
  sample_size: number;
  friction_agreement: number;
  pop_agreement: number;
  composite: number;          // weighted average; LLM may override
  weakest: keyof Omit<CellScores, 'composite' | 'weakest'>;
}

const clamp = (x: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));

/** Data completeness: % of population with usable travel-time data. */
export function scoreDataCompleteness(c: CellBundle): number {
  const { pop_total, pop_nodata } = c.canonical;
  if (pop_total <= 0) return 0;
  const pct = ((pop_total - pop_nodata) / pop_total) * 100;
  return clamp(Math.round(pct * 10) / 10);
}

/** Sample size: log-scaled population. <100 people = noisy; 10K+ = solid. */
export function scoreSampleSize(c: CellBundle): number {
  const n = c.canonical.pop_total;
  if (n <= 0) return 0;
  // log10(10) = 25, log10(100) = 50, log10(1000) = 75, log10(10000) = 100
  return clamp(Math.round(Math.log10(n + 1) * 25 * 10) / 10);
}

/** Friction agreement: how much MAP and OSM friction surfaces agree on pct_le30. */
export function scoreFrictionAgreement(c: CellBundle): number {
  if (!c.worldpop_osm) return 50; // single source — neutral confidence
  const delta = Math.abs(c.canonical.pct_le30 - c.worldpop_osm.pct_le30);
  return clamp(Math.round((100 - delta) * 10) / 10);
}

/** Population-source agreement: WorldPop vs Census on pct_le30. */
export function scorePopAgreement(c: CellBundle): number {
  if (!c.census_map) return 50; // single source
  const delta = Math.abs(c.canonical.pct_le30 - c.census_map.pct_le30);
  return clamp(Math.round((100 - delta) * 10) / 10);
}

/**
 * Composite score: weighted average of the 4 dimensions.
 * Weights reflect how much each dimension affects whether you can trust the
 * pct_le30 number for this cell.
 */
const WEIGHTS = {
  data_completeness: 0.30,    // if half the people have no data, the % is suspect
  sample_size: 0.20,          // tiny populations swing wildly
  friction_agreement: 0.30,   // if MAP and OSM disagree, travel-time model is uncertain
  pop_agreement: 0.20,        // pop source disagreement = where are the people, really?
} as const;

export function computeScores(c: CellBundle): CellScores {
  const data_completeness = scoreDataCompleteness(c);
  const sample_size = scoreSampleSize(c);
  const friction_agreement = scoreFrictionAgreement(c);
  const pop_agreement = scorePopAgreement(c);

  const composite = clamp(
    data_completeness * WEIGHTS.data_completeness +
      sample_size * WEIGHTS.sample_size +
      friction_agreement * WEIGHTS.friction_agreement +
      pop_agreement * WEIGHTS.pop_agreement
  );

  // Identify the weakest dimension — the LLM uses this to focus the narrative
  const dims = { data_completeness, sample_size, friction_agreement, pop_agreement };
  let weakest: CellScores['weakest'] = 'data_completeness';
  let weakestVal = Infinity;
  for (const [k, v] of Object.entries(dims) as [CellScores['weakest'], number][]) {
    if (v < weakestVal) {
      weakestVal = v;
      weakest = k;
    }
  }

  return {
    data_completeness,
    sample_size,
    friction_agreement,
    pop_agreement,
    composite: Math.round(composite * 10) / 10,
    weakest,
  };
}
