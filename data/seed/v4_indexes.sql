-- =====================================================================
-- v4 performance index for v_indicators_adm2
--
-- The view's CTEs filter accessibility_indicators down to the canonical
-- slice (idgeo='admin2', sector='Total', area='Total', quintile='Total')
-- for each method, then GROUP BY district. With ~700k rows across five
-- countries and no supporting index that is a full-table scan — and a
-- per-country query for a large country (Colombia, 1,122 districts /
-- 6,732 view rows) can exceed the API statement timeout, so the frontend
-- load fails and the whole map renders grey.
--
-- This partial index matches the CTE's constant filters exactly and is
-- ordered by (country_iso, method) + the group-by columns, so the view
-- query becomes an index range scan. Small countries were always fast;
-- this is what makes Colombia fast too.
--
-- Run once in the Supabase SQL editor. Idempotent. Does NOT touch data.
-- =====================================================================

create index if not exists accessibility_indicators_canonical_idx
  on accessibility_indicators (
    country_iso, method, admin2_pcode, education_level, mode, time_band
  )
  where idgeo = 'admin2'
    and sector = 'Total'
    and area = 'Total'
    and quintile = 'Total';

analyze accessibility_indicators;
