export type AgeGroup = 'all' | 'primary' | 'secondary' | 'highschool';

export const AGE_GROUP_LABELS: Record<AgeGroup, string> = {
  all: 'All school-age',
  primary: 'Primary (6–11)',
  secondary: 'Lower secondary (12–14)',
  highschool: 'High school (15–17)',
};

export interface IndicatorRow {
  cod_dist: string;
  nomb_dist: string;
  nomb_prov: string;
  age_group: AgeGroup;
  pop_total: number;
  pop_le15: number;
  pop_le30: number;
  pop_le60: number;
  pop_nodata: number;
  pct_le15: number;
  pct_le30: number;
  pct_le60: number;
  data_completeness_pct: number;
}

/** All 4 age-group rows for a single district, keyed by age_group. */
export type DistrictIndicators = Partial<Record<AgeGroup, IndicatorRow>>;

/** All districts, keyed by cod_dist. */
export type IndicatorsByDist = Record<string, DistrictIndicators>;
