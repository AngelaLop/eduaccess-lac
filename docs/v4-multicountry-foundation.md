# v4 — Multi-country data foundation — Change Summary

> Branch: `v4-multicountry-foundation` (uncommitted working tree as of writing)
> Scope: build-order steps 2-3 of v4 — the schema + data + code foundation that
> makes EduAccess LAC multi-country. **Not** in this branch: the Policy
> Recommender, the `/admin` live-pipeline UI, the cross-country comparison view,
> the Figma design pass.
> Reviewer: Codex — second-pass review requested.
> Status: web app `pnpm typecheck` + `pnpm build` clean; worker `pnpm typecheck`
> clean. All **five** countries the IDB pipeline covers (Panama, Colombia, Costa
> Rica, Ecuador, Peru) are wired up. Panama + Colombia verified end-to-end in the
> browser; CRI/ECU/PER pending their data load + worker run (§11).

---

## 1. Why this change

v3 shipped Panama-only. v4's headline is multi-country reach. This branch
replaces the Panama-only schema and code paths with a unified shape that holds
all five countries the IDB pipeline now covers — Panama, Colombia, Costa Rica,
Ecuador and Peru.

### Decisions locked with the user before implementation

1. **Adopt the IDB pipeline's unified `results/accessibility/` dataset for all
   countries, Panama included.** One schema, one code path. The old
   `panama_district_indicators` / `v_panama_indicators` are left untouched in
   the DB as legacy; the live app moves off them.
2. **Robustness is now a 3-dimension model**: `data_completeness`,
   `sample_size`, `method_agreement` (FMM vs OSRM routing disagreement).
   v3's `friction_agreement` and `pop_agreement` are retired.
3. All **five** pipeline countries are included — Panama, Colombia, Costa Rica,
   Ecuador, Peru. Colombia was the original v4 target; CRI/ECU/PER were added
   once their OSRM runs finished — no code change beyond data + ~3 lines of
   per-country config.

---

## 2. The source data

`results/accessibility/accessibility_fmm_scl.csv` (FMM) and
`accessibility_osrm_scl.csv` (OSRM) — both now cover all five countries
(PAN/COL/CRI/ECU/PER). Long/tidy format. District key is **`admin2_pcode`**
(BID standard, e.g. `PA0101`, `CO05001`, `EC0101`); `cod_dist` is retired. `education_level ∈ {primaria, secbaja, secalta}` — 3 levels, no
"all". The two routing methods (FMM = friction-surface, OSRM = road-network) are
the new robustness cross-check.

---

## 3. Phase 1 — Schema (`data/seed/v4_multicountry_schema.sql`, NEW)

Idempotent migration, run after `v3_robustness_schema.sql`.

- **`accessibility_indicators`** — long table mirroring the two CSVs. Surrogate
  `id` PK + a unique index on the 11-column natural key. Admin codes stored as
  `''` (not null) on country/admin1 rows. Carries a **partial index** over the
  canonical slice that `v_indicators_adm2` reads (see §9.6).
- **`district_geometries`** — `(country_iso, admin2_pcode)` PK, GeoJSON.
- **`robustness_reports`** / **`priority_scores`** — **DROPPED & recreated**, new
  PK `(country_iso, admin2_pcode, education_level, transport_mode)`. Score
  columns: `score_data_completeness`, `score_sample_size`,
  `score_method_agreement`. v3 versioning columns kept.
  > ⚠️ Dropping these two is intentional & safe — 100 % worker-derived,
  > repopulated on the next worker run.
- **`audit_runs`** — `country_iso` column added.
- **`v_indicators_adm2`** — NEW curated, LLM-visible view. One row per
  `(country_iso, admin2_pcode, education_level, mode)`, pinned to the canonical
  slice (`idgeo='admin2'`, `sector/area/quintile = 'Total'`), pivoting
  `time_band` → `pct_le15/30/60` from FMM, left-joining the OSRM le30 as
  `pct_le30_osrm`.
- **`districts_adm2`** — NEW helper view the worker iterates.
- RLS public-read policies on the new tables.

---

## 4. Phase 2 — Data load + geometry (NEW scripts)

- **`data/seed/load_accessibility.py`** — reads the two CSVs, pushes the
  selected countries (default: all five) to `accessibility_indicators`
  (per-country delete-then-insert, 2000-row batches).
- **`data/seed/geometry/build_geometries.py`** — reads the BID LAC level-2
  shapefile via geopandas (pyogrio engine), filters each country by its
  `admin2_pcode` prefix, simplifies, writes one GeoJSON per country to
  `apps/web/public/` keyed on `admin2_pcode`, optionally pushes
  `district_geometries`. District **names are joined from the sibling UTF-8
  CSV** (the shapefile `.dbf` strings are mis-encoded). Adding a country is a
  one-line entry in the script's `COUNTRIES` map.
- Both scripts gained a dependency-free **`.env` auto-loader** — they read
  `apps/worker/.env` (then repo `.env`, then `apps/web/.env.local`)
  automatically, so `--push` needs no manual env-var setup.
- **`apps/web/lib/district-roster.json`** — regenerated as
  `{ PAN, COL, CRI, ECU, PER }` (1,699 districts) with
  `admin2_pcode / admin2_name / admin1_name`.

Geometry output: Panama 456 KB, Colombia 1.1 MB, Costa Rica 251 KB,
Ecuador 451 KB, Peru 537 KB.

---

## 5. Phase 3 — Worker rewire (`apps/worker/src`)

A "cell" is now one row of `v_indicators_adm2`; the worker loops per country.

- **`scores.ts`** — `IndicatorCell` replaces the `ScenarioRow`/`CellBundle`
  triple. `scoreMethodAgreement` (|FMM − OSRM| on pct_le30; neutral 50 when
  OSRM absent) replaces `scoreFrictionAgreement`/`scorePopAgreement`. Weights
  0.35 / 0.25 / 0.40.
- **`explainer.ts`** — narrative + caveats rewritten for the 3 dimensions.
  `FACTS_VERSION` → 2.
- **`audit.ts`** — reads `v_indicators_adm2`; groups cells by `country_iso`;
  one `audit_runs` row per country; upsert key includes `country_iso`.
  `AUDIT_COUNTRY` env limits to one country.
- **`priority.ts`** — re-keyed; ranks per `(country, education_level,
  transport_mode)`.
- **`country-brief.ts`** — `country_iso` no longer hardcoded; `loadStats`
  filters by country; `PROMPT_VERSION` → 2.
- **`auditor-agent.ts` — DELETED** (dead v2 code, broke against new types).

> ⚠️ Review note — `data_completeness`: the unified aggregate has no explicit
> `pop_nodata`, so `data_completeness` is a data-validity check (FMM value
> present + population positive) and saturates near 100 for normal cells. The
> effective discrimination is `sample_size` + `method_agreement`. Documented in
> `scores.ts`.

---

## 6. Phase 4 — LLM / API rewire (`apps/web`)

- **`lib/sql-validator.ts`** — `ALLOWED_VIEW` → `v_indicators_adm2`. New
  `checkCountryFilter(sql, country)` requires a literal `country_iso = 'XXX'`
  matching the request's country. `validateSQL` now takes a `country` argument.
- **`app/api/ask/route.ts`** — request schema gains `country` (the five ISOs).
  `buildSystemPrompt(country)`: new view + column docs, active country, refreshed
  examples. Navigation actions use the 3 education levels. Response field
  `highlightCodDist` → `highlightAdm2`. Cache key includes country.
  - **District resolution is server-side** (see §9.1) — the LLM returns a
    district *name*; `resolveDistrict` / `normalizeName` map it to a code. The
    roster is **not** embedded in the prompt.

---

## 7. Phase 5 — Frontend rewire (`apps/web`)

- **`lib/types.ts`** — `AgeGroup` → `EducationLevel`. New `CountryIso`,
  `CountryConfig`, `COUNTRIES` (name/center/zoom/geojson per country),
  `DEFAULT_COUNTRY`. `IndicatorRow` reshaped to match `v_indicators_adm2`.
  `RobustnessReport`/`PriorityRow` re-keyed; `RobustnessDimension` → 3 values.
  `AskAction` gains `set_country` (see §9.2).
- **`AppShell.tsx`** — holds `country` state + a top-bar country **dropdown**
  (`<select>`, 5 countries, alphabetical by name); loads `v_indicators_adm2`
  filtered by country. `?country=` URL param honoured.
- **`PanamaMap.tsx` → `CountryMap.tsx`** (renamed) — per-country geometry,
  feature-state choropleth (see §9.4).
- **`IndicatorPanel.tsx`** — re-keyed; surfaces the FMM-vs-OSRM gap line;
  priority query filtered by country.
- **`RobustnessCard.tsx`** — 3 dimensions; queried by
  `(country_iso, admin2_pcode, education_level, transport_mode)`.
- **`PriorityPanel / SimulationPanel / CountryAuditBrief / ScopeCard`** —
  re-keyed to the new field names.
- `app/page.tsx` (landing) intentionally unchanged.

---

## 8. Explicitly OUT of scope (later v4 steps)

Policy Recommender; the `/admin` live-pipeline UI; the cross-country comparison
view; the Figma design pass.

---

## 9. Post-implementation fixes (made during user testing)

These landed after the initial build, while the user smoke-tested the deployed
data. They are part of this branch and need review.

### 9.1 Ask prompt exceeded the Groq token limit → server-side district resolution
The first design embedded the full district roster in the system prompt so the
LLM could map a district name to a code. For Colombia that is 1,122 lines; the
request hit **15,156 tokens vs Groq free-tier's 12,000 TPM cap** (HTTP 413).
**Fix:** the roster is no longer sent. The LLM returns the district *name*;
`route.ts` resolves it to an `admin2_pcode` server-side via `resolveDistrict()`
+ `normalizeName()` (accent/punctuation-insensitive match against
`district-roster.json`). Prompt dropped ~15K → ~6K tokens. `validateActions`
takes the `country` and resolves; an unresolved name fails validation → the
route returns a clean `out_of_scope` reply.
> Review: `resolveDistrict` picks the first match on duplicate municipality
> names across departments — acceptable for a demo, flagged.

### 9.2 Cross-country Ask — `set_country` action
Asking about Colombia while scoped to Panama used to return out_of_scope. Now a
new `set_country` navigation action is emitted; `AppShell.ask()` switches the
country **and auto-re-runs the question** scoped to the new country (guarded
against re-ask loops with an `opts.reask` flag). The user sees their question,
the map switches, and the answer appears — one turn.

### 9.3 Simulation choropleth lagged the clock (Colombia)
With 1,122 polygons the per-frame `setPaintProperty` saturated the render
thread, so the choropleth finished seconds after the clock. **Fix in
`CountryMap.tsx`:** throttle simulation repaints to ~11 fps (0 and 60 edges
always paint) and disable MapLibre's `fill-color` cross-fade transition.

### 9.4 Map performance — feature-state rewrite of `CountryMap.tsx`
The choropleth baked data into the GeoJSON and called `setData` on every
level/transport/indicator change → MapLibre **re-tessellated all 1,122 polygons
each time** (and twice on initial load). Rewritten to:
- tessellate each country's geometry **once** (`addSource` with
  `promoteId: 'admin2_pcode'`);
- drive colours via **`setFeatureState`** (`has_data`, `pct`, `le15/30/60`) —
  the fill expressions read `['feature-state', …]`;
- move rank labels to a **separate tiny point source** (`rank-points`, ≤ ~20
  points) so a chat ranking result never re-uploads the polygon source;
- module-level **GeoJSON cache** + background **prefetch** of the other country.

> ⚠️ Regression caught & fixed (see §10): an interim "parallelise the indicator
> load" change derived the page count from a `count` query; when that count
> came back null it silently loaded only one 1,000-row page and greyed out most
> of Colombia. Reverted to a sequential, **explicitly ordered** `.range()` loop.

### 9.5 Expanded to all five pipeline countries
Once OSRM finished for Costa Rica, Ecuador and Peru (all five now have both FMM
and OSRM), they were added: `COUNTRIES` in `lib/types.ts` (+3 entries with map
centre/zoom/geojson), the `build_geometries.py` / `load_accessibility.py`
country maps, and the `/api/ask` country enum + system-prompt scope. The
two-button country toggle became a `<select>` dropdown. The worker needed **no
change** — it already loops every country present in `v_indicators_adm2`.
District counts: PAN 76, COL 1,122, CRI 81, ECU 224, PER 196.

### 9.6 Colombia view query timed out → partial index
With all five countries loaded (~700k rows in `accessibility_indicators`), the
per-country query on `v_indicators_adm2` for Colombia returned **HTTP 500
(statement timeout)** — the view's CTEs full-scanned the table and Colombia's
1,122 districts pushed it past the API timeout; the small countries were
unaffected. **Fix:** `accessibility_indicators_canonical_idx`, a partial index
matching the CTEs' canonical-slice filter (`idgeo='admin2'`,
`sector/area/quintile='Total'`), keyed `(country_iso, method, admin2_pcode,
education_level, mode, time_band)` — the view query becomes an index range scan.
Shipped in both `v4_multicountry_schema.sql` and the stand-alone
`data/seed/v4_indexes.sql` (for an already-migrated DB). Confirmed: Colombia
loads fast after the index.

---

## 10. Resolved regression — Colombia rendered mostly grey

During testing the Colombia map rendered **mostly grey ("No data")** — only
~166 districts coloured (`1000 ÷ 6` = view rows ÷ levels×modes) — and the
Country Audit Brief said **"1000 cells analyzed."** Initially misdiagnosed as an
incomplete data load; the user confirmed **all municipalities coloured before
the speed work**, so the data was complete.

**Root cause:** a pagination regression. The interim "parallel load" change in
`AppShell` computed the number of pages from a Supabase `count` query
(`select(..., { count: 'exact', head: true })`); that count returned null in
practice, so `pageCount` collapsed to 1 and only the first 1,000 of Colombia's
6,732 view rows were fetched.

**Fix:** `AppShell` reverted to a sequential `.range()` loop that pages until a
short page is returned — no dependency on a count. Both `AppShell` and the
worker's `loadCells` now apply an **explicit `ORDER BY`** before `.range()`
(paginating an unordered view can drop/duplicate rows — also the likely reason
the worker brief undercounted). Verify after re-running the worker:
`select country_iso, count(*) from robustness_reports group by country_iso;`
should show COL ≈ 6,732.

---

## 11. Verified vs. runtime steps

**Verified:** worker + web `pnpm typecheck` clean; web `pnpm build` clean; no
stale `cod_dist`/`age_group`/`panama_district_indicators` references in `apps/`;
both seed scripts execute; Panama works end-to-end in the browser (map,
switcher, choropleth, Ask).

**Runtime steps the user runs (DB credentials behind the agent deny list):**
1. `data/seed/v4_multicountry_schema.sql` in the Supabase SQL editor — done.
   `data/seed/v4_indexes.sql` (the §9.6 canonical-slice index) — done; required
   before a large country is queryable.
2. `load_accessibility.py --push` — PAN + COL loaded & verified; **CRI/ECU/PER
   pending** (`--push --countries CRI ECU PER`).
3. `build_geometries.py` — all five GeoJSON written to `apps/web/public/`; the
   `--push` to `district_geometries` is optional (the frontend reads the static
   files, not the table).
4. Worker run — **re-run** after the §10 ordering fix and after the CRI/ECU/PER
   load, so all five countries are scored end-to-end.
5. Web smoke test — Panama + Colombia verified end-to-end; CRI/ECU/PER pending
   their data load.

---

## 12. Specific things for Codex to review

1. **`checkCountryFilter`** in `sql-validator.ts` — bypass resistance (e.g. a
   subquery filtering a different country than the top-level query).
2. **`resolveDistrict` / server-side name resolution** (§9.1) — accent
   handling, duplicate-name ambiguity, the `out_of_scope` fallback path.
3. The **`v_indicators_adm2`** view — is the canonical-slice pin correct, and
   does the FMM/OSRM left-join yield exactly one row per
   `(country, district, level, mode)`?
4. The **`data_completeness` near-saturation** trade-off (§5).
5. **`scoreMethodAgreement` neutral-50** when OSRM is absent.
6. The **drop + recreate** of `robustness_reports` / `priority_scores`.
7. The **feature-state rewrite** of `CountryMap.tsx` (§9.4) — feature-state
   survival across `setData` on country switch; `promoteId` correctness.
8. The **cross-country re-ask** flow (§9.2) — loop guard, the `isAsking` race
   when the re-ask is fired.
9. Worker **per-country loop** in `audit.ts` — one `audit_runs` row per country,
   error isolation.
10. **Paginated reads of `v_indicators_adm2`** in both `AppShell` and the worker
    `loadCells` (§10) — confirm the explicit `ORDER BY` + sequential `.range()`
    loop reads every row exactly once.
