-- =====================================================================
-- v4 equity view: v_equity
--
-- Powers the Insight "Access gaps" card and equity Ask questions
-- (urban vs rural, wealth quintiles).
--
-- Why a separate view (not a wider v_indicators_adm2):
--   * income quintiles only exist at country / admin1 level in the IDB
--     data — there is NO per-district (admin2) income breakdown.
--   * area and income are never crossed (no "rural + poorest" cell).
--   So v_indicators_adm2 stays the pristine per-district core; v_equity is
--   the province/country-grain equity lens.
--
-- Grain: one row per
--   (country_iso, idgeo, admin1, education_level, mode, dimension, category)
--   where idgeo is 'country' or 'admin1'.
--   dimension = 'area'   → category in (urban, semiurban, rural)
--   dimension = 'income' → category in (quintile_1 … quintile_5)
--                          quintile_1 = poorest, quintile_5 = wealthiest.
--
-- Methodology: FMM (canonical), sector = Total. Income uses the raw income
-- quintiles (quintile_*), not the RWI quintiles — raw quintiles cover all
-- currently-live countries (PAN, COL) plus CRI and ECU.
--
-- Run AFTER v4_multicountry_schema.sql. Safe to re-run (idempotent).
-- =====================================================================

-- Partial index over the slices v_equity reads — keeps the view fast even
-- for a large country (mirrors accessibility_indicators_canonical_idx).
create index if not exists accessibility_indicators_equity_idx
  on accessibility_indicators (
    country_iso, education_level, mode, area, quintile, time_band
  )
  where method = 'FMM'
    and sector = 'Total'
    and idgeo in ('country', 'admin1');

create or replace view v_equity as
select
  country_iso,
  idgeo,
  admin1_pcode,
  admin1_name,
  education_level,
  mode,
  case when area <> 'Total' then 'area' else 'income' end as dimension,
  case when area <> 'Total' then area     else quintile end as category,
  max(value) filter (where time_band = 'le15') as pct_le15,
  max(value) filter (where time_band = 'le30') as pct_le30,
  max(value) filter (where time_band = 'le60') as pct_le60,
  max(population_base)                         as pop_total
from accessibility_indicators
where method = 'FMM'
  and sector = 'Total'
  and idgeo in ('country', 'admin1')
  and (
        -- area breakdown (income held at Total)
        (area <> 'Total' and quintile = 'Total')
        -- income breakdown (area held at Total)
     or (area  = 'Total'
         and quintile in ('quintile_1','quintile_2','quintile_3',
                           'quintile_4','quintile_5'))
      )
group by 1, 2, 3, 4, 5, 6, 7, 8;

-- The frontend reads v_equity with the anon key, so it needs an explicit
-- grant. Underlying RLS on accessibility_indicators is public-read anyway.
grant select on v_equity to anon, authenticated;
