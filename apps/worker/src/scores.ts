/**
 * Deterministic scorers — the 3 numeric dimensions of robustness (v4).
 * Each returns 0-100. Higher = more trustworthy.
 *
 * v4 change: the unified multi-country dataset has no census/worldpop or
 * MAP/OSM-friction variants, so the v3 `friction_agreement` and
 * `pop_agreement` dimensions are retired. Methodology cross-check is now
 * FMM vs OSRM (`method_agreement`).
 *
 * Note on `data_completeness`: the unified aggregate has no explicit
 * `pop_nodata`, so completeness is a data-validity check (FMM value present
 * and population positive). It saturates near 100 for normal cells — the
 * discriminating signal is sample_size + method_agreement. This is the
 * 2-effective-dimension fallback the plan anticipated; the explainer is
 * honest about it.
 *
 * The LLM never touches these. It only writes the country brief on top.
 */

export type EducationLevel = 'primaria' | 'secbaja' | 'secalta';
export type TransportMode = 'walking' | 'motorized';

/** One row of v_indicators_adm2 — one robustness cell. */
export interface IndicatorCell {
  country_iso: string;
  admin2_pcode: string;
  admin2_name: string | null;
  admin1_name: string | null;
  education_level: EducationLevel;
  mode: TransportMode;
  pct_le15: number | null;
  pct_le30: number | null;
  pct_le60: number | null;
  pop_total: number | null;
  pct_le30_osrm: number | null; // OSRM canonical-slice le30, null if OSRM not run
}

export interface CellScores {
  data_completeness: number;
  sample_size: number;
  method_agreement: number;
  composite: number;
  weakest: keyof Omit<CellScores, 'composite' | 'weakest'>;
}

const clamp = (x: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Data completeness: is the FMM accessibility value present and population positive? */
export function scoreDataCompleteness(c: IndicatorCell): number {
  const pop = c.pop_total ?? 0;
  if (pop <= 0) return 0;
  if (c.pct_le30 == null) return 0;
  // pct_le15/le60 missing while le30 is present = a partial pivot.
  if (c.pct_le15 == null || c.pct_le60 == null) return 60;
  return 100;
}

/** Sample size: log-scaled population. <100 people = noisy; 10K+ = solid. */
export function scoreSampleSize(c: IndicatorCell): number {
  const n = c.pop_total ?? 0;
  if (n <= 0) return 0;
  // log10(10) -> 25, log10(100) -> 50, log10(1000) -> 75, log10(10000) -> 100
  return round1(clamp(Math.log10(n + 1) * 25));
}

/** Method agreement: how close FMM and OSRM are on pct_le30. */
export function scoreMethodAgreement(c: IndicatorCell): number {
  if (c.pct_le30_osrm == null || c.pct_le30 == null) return 50; // single method — neutral
  const delta = Math.abs(c.pct_le30 - c.pct_le30_osrm);
  return round1(clamp(100 - delta));
}

/**
 * Composite score: weighted average of the 3 dimensions.
 * method_agreement carries the most weight — two independent routing
 * engines disagreeing is the strongest signal that a number is uncertain.
 */
const WEIGHTS = {
  data_completeness: 0.35,
  sample_size: 0.25,
  method_agreement: 0.40,
} as const;

export function computeScores(c: IndicatorCell): CellScores {
  const data_completeness = scoreDataCompleteness(c);
  const sample_size = scoreSampleSize(c);
  const method_agreement = scoreMethodAgreement(c);

  const composite = clamp(
    data_completeness * WEIGHTS.data_completeness +
      sample_size * WEIGHTS.sample_size +
      method_agreement * WEIGHTS.method_agreement
  );

  const dims = { data_completeness, sample_size, method_agreement };
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
    method_agreement,
    composite: round1(composite),
    weakest,
  };
}
