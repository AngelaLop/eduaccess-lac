export type AgeGroup = 'all' | 'primary' | 'secondary' | 'highschool';
export type TransportMode = 'walking' | 'motorized';

export const AGE_GROUPS: AgeGroup[] = ['all', 'primary', 'secondary', 'highschool'];

export const AGE_GROUP_LABELS: Record<AgeGroup, string> = {
  all: 'All school-age',
  primary: 'Primary (6-11)',
  secondary: 'Lower secondary (12-14)',
  highschool: 'High school (15-17)',
};

export const AGE_GROUP_SHORT_LABELS: Record<AgeGroup, string> = {
  all: 'All',
  primary: 'Primary',
  secondary: 'Secondary',
  highschool: 'High school',
};

// Narrative form for embedding in sentences ("...of high schoolers", etc.)
export const AGE_GROUP_NARRATIVE: Record<AgeGroup, string> = {
  all: 'school-age children',
  primary: 'primary students',
  secondary: 'secondary students',
  highschool: 'high schoolers',
};

export const TRANSPORT_LABELS: Record<TransportMode, string> = {
  walking: 'Walking',
  motorized: 'Motorized',
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

export type DistrictIndicators = Partial<Record<AgeGroup, IndicatorRow>>;
export type IndicatorsByDist = Record<string, DistrictIndicators>;

// ── /api/ask response contract (v2) ───────────────────────────────────────────
// Shared across the three v2 worktrees:
//   - Stream B produces this shape server-side
//   - Stream A consumes `kind`, `narrative`, `scopeHint`, and `actions`
//   - Stream C consumes `resultShape` and the order of `highlightCodDist`

export type PanelTab = 'insight' | 'ask';

export type AskAction =
  | { type: 'select_district'; cod_dist: string }
  | { type: 'set_transport_mode'; mode: TransportMode }
  | { type: 'set_education_level'; level: AgeGroup }
  | { type: 'focus_panel_tab'; tab: PanelTab };

export type AskResponseKind = 'data' | 'navigation' | 'out_of_scope';

export type ResultShape = 'ranking' | 'filter' | 'comparison' | 'aggregate';

export interface AskResponse {
  kind: AskResponseKind;
  // 'data' kind
  sql?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  // ordered by rank when resultShape === 'ranking' (#1 first)
  highlightCodDist?: string[];
  resultShape?: ResultShape;
  // 'navigation' kind
  actions?: AskAction[];
  // all kinds
  narrative?: string;
  // 'out_of_scope' kind — human-readable "here's what I CAN do", ≤ 280 chars
  scopeHint?: string;
}

// ── Worker output (v2 worker) ────────────────────────────────────────────────
// Written by apps/worker, read here via the anon key (RLS public read).

export type RobustnessDimension =
  | 'data_completeness'
  | 'sample_size'
  | 'friction_agreement'
  | 'pop_agreement';

export interface RobustnessReport {
  cod_dist: string;
  age_group: AgeGroup;
  transport_mode: TransportMode;
  score_data_completeness: number;
  score_sample_size: number;
  score_friction_agreement: number;
  score_pop_agreement: number;
  score_overall: number;
  weakest_dimension: RobustnessDimension;
  narrative: string;
  caveats: string[];
  audit_run_id: string;
  computed_at: string;
}

export interface PriorityRow {
  cod_dist: string;
  age_group: AgeGroup;
  transport_mode: TransportMode;
  score: number;
  rank_in_country: number;
  children_underserved: number;
  pct_le30: number;
  robustness: number;
}
