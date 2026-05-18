-- =====================================================================
-- v4 schema: multi-country accessibility (Panama + Colombia + …)
--
-- What this adds / changes vs v3:
--   1. accessibility_indicators — one unified long table fed by the IDB
--      pipeline's results/accessibility/*.csv (FMM + OSRM, all countries).
--      Replaces the Panama-only panama_district_indicators as the live
--      source. The old Panama tables are LEFT UNTOUCHED as legacy.
--   2. district_geometries — multi-country geometries, keyed admin2_pcode.
--   3. robustness_reports / priority_scores — dropped & recreated, re-keyed
--      to (country_iso, admin2_pcode, education_level, transport_mode).
--      Robustness is now a 3-dimension model: data_completeness,
--      sample_size, method_agreement (FMM vs OSRM). friction_agreement and
--      pop_agreement are retired (the new data has no census/OSM-friction
--      variants — methodology comparison is FMM-vs-OSRM instead).
--   4. v_indicators_adm2 — the curated, LLM-visible view. Replaces
--      v_panama_indicators.
--
-- Run this in the Supabase SQL editor AFTER v3_robustness_schema.sql.
-- Safe to re-run (idempotent) EXCEPT the robustness_reports / priority_scores
-- drop+recreate, which is intentional — those tables are 100% worker-derived
-- and are repopulated on the next worker run.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- accessibility_indicators
--
-- Long / tidy format, one row per analysis slice, mirroring the IDB
-- pipeline output. district key is admin2_pcode (BID standard, e.g.
-- 'PA0101', 'CO...'). idgeo separates country / admin1 / admin2 rows.
-- Missing admin codes (country/admin1 rows) are stored as '' so the
-- natural-key unique index needs no NULL handling.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists accessibility_indicators (
  id               bigint generated always as identity primary key,

  country_iso      text not null,                       -- isoalpha3: PAN, COL, …
  idgeo            text not null check (idgeo in ('country','admin1','admin2')),
  admin1_pcode     text not null default '',
  admin1_name      text not null default '',
  admin2_pcode     text not null default '',
  admin2_name      text not null default '',

  mode             text not null check (mode in ('walking','motorized')),
  education_level  text not null
                     check (education_level in ('primaria','secbaja','secalta')),
  sector           text not null,                       -- Total | Public | Private
  area             text not null,                       -- Total | urban | semiurban | rural
  quintile         text not null,                       -- Total | quintile_1..5 | rwi_q1..5
  time_band        text not null check (time_band in ('le15','le30','le60')),

  value            numeric,                             -- % of population within the band
  population_base  numeric,                             -- absolute denominator

  method           text not null check (method in ('FMM','OSRM')),
  year             int,
  source           text
);

create unique index if not exists accessibility_indicators_natkey_idx
  on accessibility_indicators (
    country_iso, idgeo, admin1_pcode, admin2_pcode, mode, education_level,
    sector, area, quintile, time_band, method
  );

create index if not exists accessibility_indicators_lookup_idx
  on accessibility_indicators (country_iso, idgeo, admin2_pcode);

-- Partial index over the canonical slice the v_indicators_adm2 CTEs read.
-- Without it, a per-country view query for a large country (Colombia) does
-- a full-table scan and can exceed the API statement timeout. See also
-- data/seed/v4_indexes.sql (stand-alone, for an already-migrated DB).
create index if not exists accessibility_indicators_canonical_idx
  on accessibility_indicators (
    country_iso, method, admin2_pcode, education_level, mode, time_band
  )
  where idgeo = 'admin2'
    and sector = 'Total'
    and area = 'Total'
    and quintile = 'Total';

-- ─────────────────────────────────────────────────────────────────────
-- district_geometries — multi-country, keyed on admin2_pcode
-- ─────────────────────────────────────────────────────────────────────

create table if not exists district_geometries (
  country_iso   text not null,
  admin2_pcode  text not null,
  admin2_name   text,
  admin1_name   text,
  geometry      jsonb not null,
  primary key (country_iso, admin2_pcode)
);

-- ─────────────────────────────────────────────────────────────────────
-- robustness_reports — DROP & recreate, multi-country, 3-dimension model
-- 100% worker-derived; repopulated on the next worker run.
-- ─────────────────────────────────────────────────────────────────────

drop table if exists robustness_reports cascade;

create table robustness_reports (
  country_iso                text not null,
  admin2_pcode               text not null,
  education_level            text not null
                              check (education_level in ('primaria','secbaja','secalta')),
  transport_mode             text not null
                              check (transport_mode in ('walking','motorized')),

  -- numeric scores 0-100 (deterministic, computed in the worker)
  score_data_completeness    numeric not null,
  score_sample_size          numeric not null,
  score_method_agreement     numeric not null,

  -- composite + explanation
  score_overall              numeric not null,
  weakest_dimension          text not null,
  narrative                  text not null,
  caveats                    jsonb not null default '[]'::jsonb,

  -- provenance / versioning (carried from v3)
  narrative_source           text not null default 'deterministic'
                              check (narrative_source in ('deterministic','llm')),
  facts_version              int  not null default 1,
  prompt_version             int  not null default 1,
  model                      text,
  input_hash                 text,

  audit_run_id               uuid not null references audit_runs(id) on delete cascade,
  computed_at                timestamptz not null default now(),

  primary key (country_iso, admin2_pcode, education_level, transport_mode)
);

create index robustness_reports_run_idx    on robustness_reports (audit_run_id);
create index robustness_reports_source_idx on robustness_reports (narrative_source);

-- ─────────────────────────────────────────────────────────────────────
-- priority_scores — DROP & recreate, multi-country
-- ─────────────────────────────────────────────────────────────────────

drop table if exists priority_scores cascade;

create table priority_scores (
  country_iso                text not null,
  admin2_pcode               text not null,
  education_level            text not null
                              check (education_level in ('primaria','secbaja','secalta')),
  transport_mode             text not null
                              check (transport_mode in ('walking','motorized')),

  score                      numeric not null,          -- 0-100, higher = invest sooner
  rank_in_country            int not null,              -- rank within country × level × mode

  children_underserved       int not null,
  pct_le30                   numeric not null,
  robustness                 numeric not null,

  audit_run_id               uuid not null references audit_runs(id) on delete cascade,
  computed_at                timestamptz not null default now(),

  primary key (country_iso, admin2_pcode, education_level, transport_mode)
);

create index priority_scores_rank_idx
  on priority_scores (country_iso, education_level, transport_mode, rank_in_country);

-- ─────────────────────────────────────────────────────────────────────
-- audit_runs — gains country_iso (one run row per country per refresh)
-- ─────────────────────────────────────────────────────────────────────

alter table audit_runs
  add column if not exists country_iso text;

-- country_audit_briefs already carries country_iso (v3) — no change.

-- ─────────────────────────────────────────────────────────────────────
-- v_indicators_adm2 — the curated, LLM-visible view (replaces
-- v_panama_indicators). One row per (country_iso, admin2_pcode,
-- education_level, mode), pinned to the canonical slice
-- (sector=Total, area=Total, quintile=Total), pivoting time_band into
-- pct_le15/30/60 from FMM. The OSRM le30 value is surfaced alongside for
-- transparency about methodology disagreement.
-- ─────────────────────────────────────────────────────────────────────

create or replace view v_indicators_adm2 as
with fmm as (
  select
    country_iso, admin2_pcode, admin2_name, admin1_name, education_level, mode,
    max(value) filter (where time_band = 'le15') as pct_le15,
    max(value) filter (where time_band = 'le30') as pct_le30,
    max(value) filter (where time_band = 'le60') as pct_le60,
    max(population_base)                         as pop_total
  from accessibility_indicators
  where method = 'FMM' and idgeo = 'admin2'
    and sector = 'Total' and area = 'Total' and quintile = 'Total'
  group by country_iso, admin2_pcode, admin2_name, admin1_name, education_level, mode
),
osrm as (
  select
    country_iso, admin2_pcode, education_level, mode,
    max(value) filter (where time_band = 'le30') as pct_le30_osrm
  from accessibility_indicators
  where method = 'OSRM' and idgeo = 'admin2'
    and sector = 'Total' and area = 'Total' and quintile = 'Total'
  group by country_iso, admin2_pcode, education_level, mode
)
select
  f.country_iso,
  f.admin2_pcode,
  f.admin2_name,
  f.admin1_name,
  f.education_level,
  f.mode,
  f.pct_le15,
  f.pct_le30,
  f.pct_le60,
  f.pop_total,
  o.pct_le30_osrm
from fmm f
left join osrm o using (country_iso, admin2_pcode, education_level, mode);

-- ─────────────────────────────────────────────────────────────────────
-- districts_adm2 — one row per district; the worker iterates this.
-- Replaces the panama_districts helper view.
-- ─────────────────────────────────────────────────────────────────────

create or replace view districts_adm2 as
select distinct country_iso, admin2_pcode, admin2_name, admin1_name
from accessibility_indicators
where idgeo = 'admin2';

-- ─────────────────────────────────────────────────────────────────────
-- RLS: anon reads everything; only service_role writes.
-- ─────────────────────────────────────────────────────────────────────

alter table accessibility_indicators enable row level security;
alter table district_geometries      enable row level security;
alter table robustness_reports        enable row level security;
alter table priority_scores           enable row level security;

drop policy if exists "public read" on accessibility_indicators;
drop policy if exists "public read" on district_geometries;
drop policy if exists "public read" on robustness_reports;
drop policy if exists "public read" on priority_scores;

create policy "public read" on accessibility_indicators for select using (true);
create policy "public read" on district_geometries      for select using (true);
create policy "public read" on robustness_reports        for select using (true);
create policy "public read" on priority_scores           for select using (true);

-- (No write policies → service_role bypasses RLS, anon cannot write.)
