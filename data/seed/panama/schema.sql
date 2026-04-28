-- Panama v1 schema. Run this in the Supabase SQL editor before seeding.
-- All 32 scenarios for Panama districts. ~2,656 rows total.

create table if not exists panama_district_indicators (
  cod_dist        text not null,
  nomb_dist       text,
  nomb_prov       text,
  sid             text not null,
  label           text,
  pop_source      text not null check (pop_source in ('census','worldpop')),
  friction_source text not null check (friction_source in ('map','osm')),
  friction        text not null check (friction in ('motorized','walking')),
  age_group       text not null check (age_group in ('all','primary','secondary','highschool')),
  pop_total       int,
  pop_le15        int,
  pop_le30        int,
  pop_le60        int,
  pop_gt60        int,
  pop_nodata      int,
  pct_le15        numeric,
  pct_le30        numeric,
  pct_le60        numeric,
  primary key (cod_dist, sid)
);

create table if not exists panama_district_geometries (
  cod_dist  text primary key,
  nomb_dist text,
  nomb_prov text,
  geometry  jsonb not null
);

-- The view the LLM is allowed to see.
-- Canonical v1 scenario: WorldPop + MAP friction surface + walking transport.
-- The other 31 scenarios stay in the underlying table for v3 Friction Sensitivity.
create or replace view v_panama_indicators as
select
  i.cod_dist,
  i.nomb_dist,
  i.nomb_prov,
  i.age_group,
  i.pop_total,
  i.pop_le15,
  i.pop_le30,
  i.pop_le60,
  i.pop_nodata,
  i.pct_le15,
  i.pct_le30,
  i.pct_le60,
  case when i.pop_total > 0
       then round(100.0 * (i.pop_total - i.pop_nodata) / i.pop_total, 1)
       else 0 end as data_completeness_pct
from panama_district_indicators i
where i.pop_source    = 'worldpop'
  and i.friction_source = 'map'
  and i.friction      = 'walking';

-- RLS: anon key can read, nothing else.
alter table panama_district_indicators enable row level security;
alter table panama_district_geometries enable row level security;

create policy "public read" on panama_district_indicators for select using (true);
create policy "public read" on panama_district_geometries for select using (true);

-- run_sql: executes a validated SELECT and returns rows as JSONB.
-- Called by /api/ask (server-side, service_role key only).
-- SQL is pre-validated by the app before this function is ever called.
create or replace function run_sql(query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  execute 'select coalesce(json_agg(row_to_json(t)),''[]''::json) from (' || query || ') t'
    into result;
  return result;
end;
$$;

-- Restrict to service_role only — anon/authenticated cannot call this.
revoke execute on function run_sql(text) from public, anon, authenticated;
grant  execute on function run_sql(text) to service_role;
