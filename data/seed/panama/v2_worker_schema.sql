-- =====================================================================
-- v2 worker schema: Robustness Auditor + Priority Scorer
-- Run this in the Supabase SQL editor.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- audit_runs: one row per worker run, holds run-level lifecycle state
-- ─────────────────────────────────────────────────────────────────────

create table if not exists audit_runs (
  id              uuid primary key default gen_random_uuid(),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  cells_total     int not null default 0,
  cells_done      int not null default 0,
  cells_failed    int not null default 0,
  status          text not null default 'running'
                    check (status in ('running','done','failed')),
  trigger_source  text                                -- 'cron' | 'manual'
);

create index if not exists audit_runs_started_at_idx
  on audit_runs (started_at desc);

-- ─────────────────────────────────────────────────────────────────────
-- robustness_reports: one row per (district x age_group x transport_mode)
-- Computed by the worker; surfaced by the frontend's RobustnessCard.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists robustness_reports (
  cod_dist                   text not null,
  age_group                  text not null
                              check (age_group in ('all','primary','secondary','highschool')),
  transport_mode             text not null
                              check (transport_mode in ('walking','motorized')),

  -- numeric scores 0-100 (deterministic, computed in SQL)
  score_data_completeness    numeric not null,
  score_sample_size          numeric not null,
  score_friction_agreement   numeric not null,
  score_pop_agreement        numeric not null,

  -- composite + LLM-written
  score_overall              numeric not null,
  weakest_dimension          text not null,
  narrative                  text not null,
  caveats                    jsonb not null default '[]'::jsonb,

  -- provenance
  audit_run_id               uuid not null references audit_runs(id) on delete cascade,
  computed_at                timestamptz not null default now(),

  primary key (cod_dist, age_group, transport_mode)
);

create index if not exists robustness_reports_run_idx
  on robustness_reports (audit_run_id);

-- ─────────────────────────────────────────────────────────────────────
-- priority_scores: derived from robustness_reports + indicators
-- "Where to build a school next" — combines stakes, access gap, robustness
-- ─────────────────────────────────────────────────────────────────────

create table if not exists priority_scores (
  cod_dist                   text not null,
  age_group                  text not null
                              check (age_group in ('all','primary','secondary','highschool')),
  transport_mode             text not null
                              check (transport_mode in ('walking','motorized')),

  -- 0-100 composite. Higher = higher priority to invest.
  score                      numeric not null,
  rank_in_country            int not null,

  -- inputs that produced the score (for transparency in the UI)
  children_underserved       int not null,
  pct_le30                   numeric not null,
  robustness                 numeric not null,

  audit_run_id               uuid not null references audit_runs(id) on delete cascade,
  computed_at                timestamptz not null default now(),

  primary key (cod_dist, age_group, transport_mode)
);

create index if not exists priority_scores_rank_idx
  on priority_scores (age_group, transport_mode, rank_in_country);

-- ─────────────────────────────────────────────────────────────────────
-- RLS: anon reads everything; only service_role writes.
-- ─────────────────────────────────────────────────────────────────────

alter table audit_runs           enable row level security;
alter table robustness_reports   enable row level security;
alter table priority_scores      enable row level security;

drop policy if exists "public read" on audit_runs;
drop policy if exists "public read" on robustness_reports;
drop policy if exists "public read" on priority_scores;

create policy "public read" on audit_runs           for select using (true);
create policy "public read" on robustness_reports   for select using (true);
create policy "public read" on priority_scores      for select using (true);

-- (No write policies → service_role bypasses RLS, anon cannot write.)

-- ─────────────────────────────────────────────────────────────────────
-- Helper view: panama_districts (one row per cod_dist)
-- The worker iterates this to know which cells to audit.
-- ─────────────────────────────────────────────────────────────────────

create or replace view panama_districts as
select distinct cod_dist, nomb_dist, nomb_prov
from panama_district_indicators
order by cod_dist;
