-- =====================================================================
-- v3 schema: versioning + country audit briefs
--
-- What this adds to v2:
--   1. Versioning + provenance columns on robustness_reports so cached
--      LLM-polished narratives can be invalidated when scoring weights,
--      prompts, or model change.
--   2. country_audit_briefs — one paragraph per country per refresh,
--      written by an LLM, surfaced on the Insight landing.
--
-- Run this in the Supabase SQL editor AFTER v2_worker_schema.sql.
-- Safe to re-run (idempotent).
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- robustness_reports: versioning columns
--
-- narrative_source = 'deterministic' (the new default in v3 — rule-based
-- explainer in the worker writes text from the 4 numeric scores) or
-- 'llm' (a polished narrative produced by the on-demand /api/audit-cell
-- route or the worker's prewarm step; v4).
--
-- The four "version" columns let the frontend show "this AI text was
-- written by <model> against facts_version=<n>, prompt_version=<n>".
-- When any of them drifts from current, callers can choose to fall back
-- to the deterministic text until something re-prompts the cell.
-- ─────────────────────────────────────────────────────────────────────

alter table robustness_reports
  add column if not exists narrative_source text not null default 'deterministic'
    check (narrative_source in ('deterministic','llm')),
  add column if not exists facts_version    int  not null default 1,
  add column if not exists prompt_version   int  not null default 1,
  add column if not exists model            text,
  add column if not exists input_hash       text;

create index if not exists robustness_reports_source_idx
  on robustness_reports (narrative_source);

-- ─────────────────────────────────────────────────────────────────────
-- country_audit_briefs
--
-- One LLM-written paragraph per country per refresh. The high-leverage
-- agentic artifact in v3: summarizes where this country's data is
-- strong, where it is weak, and what to trust. Surfaced on landing.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists country_audit_briefs (
  country_iso     text not null,
  brief_text      text not null,
  model           text not null,
  prompt_version  int  not null default 1,
  facts_version   int  not null default 1,
  generated_at    timestamptz not null default now(),
  audit_run_id    uuid references audit_runs(id) on delete set null,
  primary key (country_iso, generated_at)
);

create index if not exists country_audit_briefs_country_idx
  on country_audit_briefs (country_iso, generated_at desc);

alter table country_audit_briefs enable row level security;

drop policy if exists "public read" on country_audit_briefs;
create policy "public read" on country_audit_briefs for select using (true);
