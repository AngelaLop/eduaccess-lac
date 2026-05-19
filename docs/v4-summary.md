# EduAccess LAC — v4 Summary

**Built:** 2026-05-13 to 2026-05-19 | **Live:** https://eduaccess-lac.vercel.app | **Course:** Design, Build, Ship (MPCS 51238)

## What v4 is

v4 is the version that **goes multi-country and finishes the TA's feedback loop**. v1–v3 were Panama-only. v4 takes the platform to **five LAC countries — Panama, Colombia, Costa Rica, Ecuador and Peru** — on a new unified schema, ships the **Policy Recommender** — the per-district investment ranking the v1 feedback asked for — adds an **equity lens** (urban/rural and wealth breakdowns) across both the regional map and each country, and splits the AI chat into a **two-tier model cascade** that keeps the scarce 70B token budget for genuine data questions. A long tail of fixes came straight out of testing the platform on a large country: travel-time questions, accent-tolerant district lookup, a definitional "explainer" answer kind, and a simulation-finish polish for maps with 1,000+ districts. All work is on `main`, deployed to Vercel and Railway, CI green on every commit.

## Block A — Five countries online (the multi-country foundation)

v1–v3 ran on Panama-only tables (`panama_district_indicators`, `v_panama_indicators`). v4 replaces the live source with one unified, country-agnostic schema and keeps the old Panama tables untouched as legacy.

| Piece | Where | What it does |
|---|---|---|
| Unified schema | `data/seed/v4_multicountry_schema.sql` | `accessibility_indicators` — one long/tidy table for every country, fed by the IDB pipeline's FMM + OSRM output; `district_geometries`; re-keyed `robustness_reports` / `priority_scores` |
| Curated view | same | `v_indicators_adm2` — the LLM-visible per-district view (replaces `v_panama_indicators`), pinned to the canonical slice, OSRM surfaced alongside FMM |
| Ingest | `data/seed/load_accessibility.py` | Loads the IDB `accessibility_fmm_scl.csv` / `accessibility_osrm_scl.csv` into Supabase, per country, delete-then-insert |
| Indexes | `data/seed/v4_indexes.sql` | Partial index over the canonical slice — without it a Colombia-sized view query can exceed the API statement timeout |

All five countries — Panama, Colombia, Costa Rica, Ecuador and Peru — are loaded and live. Colombia alone is **18× the district count of Panama** (1,122 vs 76), which is what surfaced most of the v4 bug tail; the schema and views absorbed the other countries with zero new code.

## Block B — The LAC entry experience

The platform now opens on a **regional view of Latin America** instead of dropping straight into one country. `PlatformEntry` decides the first screen: no country chosen → `LacOverview` (the LAC choropleth + a clickable country ranking); a country chosen → the per-country `AppShell`. A 3D-globe fly-in plays once per page load as the entry flourish, then settles flat. Geometry is topology-aware so the regional and per-country maps share the same `admin2_pcode` keying.

## Block C — Two-tier Ask

`/api/ask` was one 70B call per question. v4 splits it by cost:

- **Stage 1 — `llama-3.1-8b-instant`** — a cheap classifier and prompt-injection guard. Sorts every question into `data` / `navigation` / `explainer` / `out_of_scope`. Navigation, explainer and out-of-scope are answered here; the 70B is never touched.
- **Stage 2 — `llama-3.3-70b`** — SQL synthesis, for `data` questions only. A `topic` tag routes to the right view (`district` → `v_indicators_adm2`, `equity` → `v_equity`).

Security is unchanged in shape — the SQL validator, the per-IP rate limiter and the constrained view still gate everything — but chatter, navigation and injection attempts no longer burn 70B tokens.

### Ask polish (from live testing)

Testing on Colombia exposed a set of rough edges, each fixed:

- **Travel-time questions.** "How long does it take to get to school?" was refused. The platform has no per-student travel time, but it *does* have proximity bands — the answer is now reframed: *"…the share of students within 15, 30 and 60 minutes is…"*.
- **New `explainer` response kind.** Definitional questions ("what does 30-minute access mean?", "FMM vs OSRM?") were rejected as out-of-scope. They now get a short, fact-grounded answer from the cheap model.
- **Recommendation routing.** "Where should we build a school?" routes to the Insight priority ranking instead of a raw worst-access query. Cross-country comparisons ("compare Panama and Colombia") route to the LAC map.
- **Country-overview questions.** "How is the country doing?" returns a population-weighted level × mode breakdown table, not a single number with a mismatched narrative.
- **Single-district questions** route to navigation — `resolveDistrict` is now accent- and punctuation-tolerant, so "bogota" resolves to "Bogotá, D.C." and the map zooms to it.

## Block D — The Policy Recommender

The agent the v1 TA feedback asked for. The worker computes a **deterministic per-district investment ranking** into `priority_scores` — each district scored on underserved-children impact and carrying a robustness band, so **no recommendation ships without a confidence band attached**. `PriorityPanel` surfaces the top districts on the Insight landing; the country audit brief gives the one LLM-written paragraph of context per country per refresh. Pure numeric ranking, no per-district LLM calls, no cost.

## Block E — Equity breakdowns (area + wealth)

The IDB data carries urban/rural and income-quintile slices that v3 never surfaced. v4 adds an equity lens — without touching the clean per-district core.

| Piece | Where | What it does |
|---|---|---|
| Equity view | `data/seed/v4_equity_view.sql` | `v_equity` — urban/rural and income-quintile breakdowns at province + country grain (income quintiles do not exist per district) |
| Insight card | `apps/web/app/components/EquityGapCard.tsx` | "Access gaps" card on each country's Insight landing — urban vs rural, wealthiest vs poorest, with the headline gap |
| LAC map views | `apps/web/app/components/LacOverview.tsx` | An `Access / Area gap / Wealth gap` toggle on the regional map, with a **data-relative colour gradient** so five clustered countries still contrast |
| Equity Ask | `apps/web/app/api/ask/route.ts` | A separate equity SQL prompt + `v_equity`; the validator was parameterised to gate either view |

A design finding shaped this: income quintiles exist only at country/province level, never per-district, and never crossed with area — so a separate `v_equity` was the right call, not a wider `v_indicators_adm2`. The card degrades gracefully where a country lacks a dimension.

## Block F — Simulation finish polish

On a 1,000+-district map the three sampled "kid track" districts got lost at the end of a run. v4 pins a label on each at simulation finish and recolours its polygon to **match its race bar** (emerald = reached, red = stuck) — so a bar and its municipality on the map read as the same thing.

## Robustness

v4 moved the robustness model from four dimensions to three, dropping the friction/population variants the new data no longer has:

| Dimension | Meaning |
|---|---|
| `data_completeness` | share of population with usable travel-time data |
| `sample_size` | population magnitude — small N swings wildly |
| `method_agreement` | how closely FMM and OSRM routing agree |

The per-cell explainer stays deterministic; the only worker LLM call remains the one country audit brief per refresh.

## Closing the TA feedback loop

The v1 feedback (Shubham) was: *"think about how you'll use agents for each part of the analysis and how to explain the robustness of recommendations."* v4 answers it structurally — the Policy Recommender is a per-district recommendation agent and **every recommendation ships with a robustness band**. The Ask cascade, the deterministic robustness explainer, and the country audit brief are each an inspectable step. Nothing on screen is a number without provenance.

## What's NOT in v4 (cut on purpose)

- PDF report export — stretch goal, cut first.
- Spanish / Portuguese locale (i18n) — stretch goal.
- Auth — out of scope; the data is public.
- Phase B GIS pipeline for new countries — proxy indicators instead.
- Husky pre-commit hook — CI is the actual gate.
- Sentry / structured monitoring — deferred.

## Architecture

Three deployables — `apps/web` on Vercel, `apps/worker` on Railway, Supabase Postgres — with Groq-hosted Llama models (8B classifier, 70B SQL synthesis). The full picture — system diagrams, the two-tier chat request flow, the database schema, the security model — is in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Demo readiness

Open the platform → the LAC regional map → toggle **Area gap** / **Wealth gap** to compare all countries on inequality → click Colombia → the Insight tab shows the national priority ranking and the "Access gaps" card → ask *"how long does it take children to get to school?"* and get the travel-time bands → ask *"where should we build schools?"* and land on the priority ranking → run the Simulate tab and watch the three sampled districts finish with pinned, colour-matched labels.

Every number has provenance, every recommendation has a confidence band, and the AI chat cannot touch a raw table or run arbitrary SQL. The TA's feedback is answered structurally, not cosmetically — and the platform now speaks for five Latin American countries.
