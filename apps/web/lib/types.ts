// ── Country ───────────────────────────────────────────────────────────────────
// v4: the platform is multi-country. Panama is the default; Colombia is the
// second country. The schema holds CRI/ECU/PER too once their data lands.

export type CountryIso = 'PAN' | 'COL' | 'CRI' | 'ECU' | 'PER';

export interface CountryConfig {
  iso: CountryIso;
  name: string;
  /** MapLibre initial view */
  center: [number, number];
  zoom: number;
  /** static GeoJSON in /public, keyed on admin2_pcode */
  geojson: string;
}

export const COUNTRIES: Record<CountryIso, CountryConfig> = {
  PAN: {
    iso: 'PAN',
    name: 'Panama',
    center: [-80.0, 8.5],
    zoom: 6.5,
    geojson: '/panama_districts.geojson',
  },
  COL: {
    iso: 'COL',
    name: 'Colombia',
    center: [-73.5, 4.3],
    zoom: 4.6,
    geojson: '/colombia_districts.geojson',
  },
  CRI: {
    iso: 'CRI',
    name: 'Costa Rica',
    center: [-84.1, 9.8],
    zoom: 6.8,
    geojson: '/costa_rica_districts.geojson',
  },
  ECU: {
    iso: 'ECU',
    name: 'Ecuador',
    center: [-78.6, -1.4],
    zoom: 5.7,
    geojson: '/ecuador_districts.geojson',
  },
  PER: {
    iso: 'PER',
    name: 'Peru',
    center: [-74.4, -9.2],
    zoom: 4.6,
    geojson: '/peru_districts.geojson',
  },
};

// Ordered alphabetically by country name — drives the country dropdown.
export const COUNTRY_ISOS: CountryIso[] = ['COL', 'CRI', 'ECU', 'PAN', 'PER'];

export const DEFAULT_COUNTRY: CountryIso = 'PAN';

// ── Education level ─────────────────────────────────────────────────────────────
// The unified dataset has three levels (no "all" aggregate).

export type EducationLevel = 'primaria' | 'secbaja' | 'secalta';
export type TransportMode = 'walking' | 'motorized';

export const EDUCATION_LEVELS: EducationLevel[] = ['primaria', 'secbaja', 'secalta'];

export const EDUCATION_LEVEL_LABELS: Record<EducationLevel, string> = {
  primaria: 'Primary (5-9)',
  secbaja: 'Lower secondary (10-14)',
  secalta: 'Upper secondary (15-19)',
};

export const EDUCATION_LEVEL_SHORT_LABELS: Record<EducationLevel, string> = {
  primaria: 'Primary',
  secbaja: 'Lower sec.',
  secalta: 'Upper sec.',
};

// Narrative form for embedding in sentences ("...of primary students", etc.)
export const EDUCATION_LEVEL_NARRATIVE: Record<EducationLevel, string> = {
  primaria: 'primary students',
  secbaja: 'lower-secondary students',
  secalta: 'upper-secondary students',
};

export const TRANSPORT_LABELS: Record<TransportMode, string> = {
  walking: 'Walking',
  motorized: 'Motorized',
};

// ── Indicators ──────────────────────────────────────────────────────────────────
// One row of v_indicators_adm2: one (country, district, education_level, mode).

export interface IndicatorRow {
  country_iso: string;
  admin2_pcode: string;
  admin2_name: string;
  admin1_name: string;
  education_level: EducationLevel;
  mode: TransportMode;
  pct_le15: number;
  pct_le30: number;
  pct_le60: number;
  pop_total: number;
  /** OSRM canonical-slice le30 — null when OSRM has not been run for the country */
  pct_le30_osrm: number | null;
}

export type DistrictIndicators = Partial<Record<EducationLevel, IndicatorRow>>;
/** keyed by admin2_pcode */
export type IndicatorsByDist = Record<string, DistrictIndicators>;

// ── /api/ask response contract ──────────────────────────────────────────────────

export type PanelTab = 'insight' | 'ask' | 'simulation';

export type AskAction =
  | { type: 'select_district'; admin2_pcode: string }
  | { type: 'set_country'; country: CountryIso }
  | { type: 'set_transport_mode'; mode: TransportMode }
  | { type: 'set_education_level'; level: EducationLevel }
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
  highlightAdm2?: string[];
  resultShape?: ResultShape;
  // 'navigation' kind
  actions?: AskAction[];
  // all kinds
  narrative?: string;
  // 'out_of_scope' kind — human-readable "here's what I CAN do", ≤ 280 chars
  scopeHint?: string;
}

// ── Worker output ───────────────────────────────────────────────────────────────
// Written by apps/worker, read here via the anon key (RLS public read).

export type RobustnessDimension =
  | 'data_completeness'
  | 'sample_size'
  | 'method_agreement';

export interface RobustnessReport {
  country_iso: string;
  admin2_pcode: string;
  education_level: EducationLevel;
  transport_mode: TransportMode;
  score_data_completeness: number;
  score_sample_size: number;
  score_method_agreement: number;
  score_overall: number;
  weakest_dimension: RobustnessDimension;
  narrative: string;
  caveats: string[];
  audit_run_id: string;
  computed_at: string;
}

export interface PriorityRow {
  country_iso: string;
  admin2_pcode: string;
  education_level: EducationLevel;
  transport_mode: TransportMode;
  score: number;
  rank_in_country: number;
  children_underserved: number;
  pct_le30: number;
  robustness: number;
}
