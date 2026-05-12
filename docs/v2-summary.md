# EduAccess LAC — v2 Summary

**Built:** 2026-05-04 to 2026-05-05 | **Live:** https://eduaccess-lac.vercel.app | **Course:** Design, Build, Ship (MPCS 51238)

## What we built

V2 is two things at once: an iteration on v1 driven by cohort feedback, and an architectural step up to a real multi-service system. The cohort told us the platform was confusing on first glance, the chat bot didn't gracefully handle out-of-scope questions, the right panel was cramped, the rankings weren't visual enough, the map didn't show queried districts informatively, hover was missing, and the LLM should be able to drive the UI. Each of those landed. On top of that, we shipped a separate worker service on Railway that runs a Robustness Auditor agent across all 664 (district × age × transport) cells and writes scored reports to Supabase, plus a Priority Scorer that combines stakes, access gap, and confidence into a "where to invest next" ranking the frontend reads from a cache table.

## Parallelization, in earnest

The Week 6 brief asked us to try parallel agents and git worktrees. We built v2 across three named branches in three sibling worktrees, with three Claude Code sessions running side-by-side on three dev servers (ports 3001/3002/3003), all branched from a single integration-contract commit on `main`. A fourth worktree (`v2/worker`) added the Railway worker service. The streams merged in order — A → B → C → worker — onto `main`.

| Stream | Branch | Owns |
|---|---|---|
| A | `v2/stream-a-layout` | Tabbed Insight/Ask panel, scope card, out_of_scope render path, landing copy |
| B | `v2/stream-b-agent` | `/api/ask` rewrite as a router (data \| navigation \| out_of_scope), district-name resolution, action validation |
| C | `v2/stream-c-viz` | Map hover popups, fitBounds zoom, ranked-highlight numbered labels, Insight landing visualization |
| Worker | `v2/worker` | `apps/worker` Node service, Robustness Auditor agent, Priority Scorer, Supabase tables, Railway deploy |

## Architecture

```
[Browser]
  Landing (/) + Platform (/platform)
  MapLibre choropleth · tabbed Insight/Ask panel · hover · Overview button
  Reads ?tab=ask, ?ask=<prompt> from URL on mount
         │ anon key, RLS read-only
         ▼
[Vercel API route /api/ask]
  Groq Llama-3.3-70B as a tool-routing agent
  Returns one of three kinds: data | navigation | out_of_scope
  Validates SQL or actions before executing
  In-memory + (eventually) Supabase response cache
         │ service-role key (server-only)
         ▼
[Supabase Postgres]
  panama_district_indicators (2,656 rows · 32 scenarios)
  panama_district_geometries (83 districts · simplified GeoJSON)
  v_panama_indicators view (LLM-visible only)
  audit_runs · robustness_reports · priority_scores  ← worker output
  RLS: anon read-only on tables; service_role on workers
         ▲
         │ service-role key (Railway env)
[Railway worker — apps/worker]
  Cron: 0 3 * * * UTC, plus manual triggers
  Per cell (664 total):
    1. 4 deterministic SQL scores (data_completeness, sample_size,
       MAP-vs-OSM friction, WorldPop-vs-Census pop)
    2. LLM Auditor agent (Groq) → narrative + caveats + composite
    3. Upsert robustness_reports
  Then: SQL aggregation → priority_scores
  Concurrency=4, batch-flushes every 50 cells
```

**Multi-model workflow:** Claude Code as primary driver across all four streams. Codex was actually engaged this version (not just mentioned) — it diagnosed a Railway/Nixpacks deploy issue we'd been spinning on, identified that the build root needed a `package.json` with `engines.node` and `packageManager` fields for Nixpacks's Node provider to activate. The fix landed in two file changes.

## Cohort feedback addressed

Each piece of cohort feedback maps to a concrete shipped change:

1. **"Confusing on first glance"** → landing H1 sharpened to a question (*"How accessible are schools in Panama?"*), one-paragraph capability description, click-to-Ask routing.
2. **"Bot doesn't handle out-of-scope"** → `/api/ask` is now a 3-kind router. Out-of-scope responses include a `scopeHint` referencing seeded prompts; UI renders them with a soft style and clickable retry suggestions.
3. **"Right panel cramped"** → bot and rankings live in separate Insight/Ask tabs with bigger button styling and notification-dot for off-tab answers.
4. **"Ranked districts as a list weak"** → on the Insight landing, the ranking is now a vertical bar chart with absolute-children-underserved as the metric, then upgraded to the Priority panel (post-worker) with a per-row plain-English explanation of why each district ranks where it does.
5. **"Districts from query should show information on map"** → ranked chat results now apply rank-encoded fill-opacity (selected/highlighted at 0.95, others dimmed to 0.18-0.30) plus white-on-black numbered badges (1–5) on each polygon centroid. Multipolygon districts (coastal/archipelago) get one badge on their largest piece.
6. **"Hover on districts"** → MapLibre `mousemove` handler shows a popup with district name, province, and "X% within 30 min walk." Throttled to avoid spam. Properly differentiates no-data districts.
7. **"LLM should navigate the platform"** → navigation kind in the API contract: actions like `select_district`, `set_transport_mode`, `set_education_level`, `focus_panel_tab`. AppShell dispatches all four. Typing *"Show me San Miguelito"* selects the district, switches to Insight, fitBounds-zooms the map.

## Robustness Auditor (the v3 keystone, pulled forward)

Shubham's first feedback was *"think about how you'll use agents for each part of the analysis and how to explain the robustness of recommendations."* The static "credits roll" RobustnessCard from v1 is now replaced with a per-cell scored profile:

- **4 deterministic numeric dimensions**, each 0–100, computed in SQL:
  - `data_completeness` — % of population with usable travel-time data
  - `sample_size` — log-scaled population (small populations are noisier)
  - `friction_agreement` — `100 − |pct_le30(MAP) − pct_le30(OSM)|`
  - `pop_agreement` — `100 − |pct_le30(WorldPop) − pct_le30(Census)|`
- **One LLM call per cell** writes a one-sentence narrative for non-technical readers, picks 1–3 specific caveats grounded in the actual numbers, and returns a composite score.
- **664 cells** × ~700 tokens × Groq Llama-3.3-70B at concurrency 4 ≈ 10–15 min per full audit. Worker is run-to-completion, exits cleanly, scheduled daily via Railway cron.

The frontend's RobustnessCard fetches the matching report for the selected (cod_dist, age_group, transport_mode) and renders a 4-bar dimensional breakdown with the weakest dimension highlighted, plus the LLM narrative, caveats, and audit timestamp.

## Priority scorer

Builds on robustness output. Per cell:
```
raw  = log_norm(children_underserved) × access_gap × (robustness / 100)
score = raw normalized to 0–100 within (age_group, transport_mode) partition
```

The robustness factor pulls down districts whose underlying numbers are uncertain — so we don't recommend building a school based on a number we can't trust. Frontend shows the top 5 with a per-row plain-English interpretation that names the dominant driver: *"Largest underserved population in this list (12,400 high schoolers), with high confidence in the data."*

## What works in v2

- **Three response kinds** in `/api/ask`: data (validated SQL), navigation (typed actions), out_of_scope (scope hint with prompt suggestions)
- **Tabbed Insight/Ask panel** with notification-dot when an answer arrives off-tab
- **Map hover** with district name + access %; **map zoom-to-fit** on selection; **dim-others highlight** when chat returns ranked results; **numbered rank labels** on top-N polygons
- **Insight landing** with national headline %, total-underserved stakes count, and a 5-row priority list (driven by the worker) or fallback underserved-bars
- **Scored RobustnessCard** with 4 dimension bars + LLM narrative + caveats per (district × age × mode)
- **`?tab=ask` and `?ask=<prompt>`** URL params on `/platform` for landing-page deep links
- **Overview button** on the map (top-right under the +/− zoom controls), visible whenever selection or chat highlights are active
- **Friendly rate-limit error** ("Daily LLM quota reached. Resets in 3m 55s.") parsed from Groq 429 responses

## Architectural decisions worth flagging

- **Service-role key on Railway only.** Never `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`. Frontend uses anon + RLS reads.
- **Worker runs once and exits.** `restartPolicyType: NEVER` in `railway.json` — default would loop forever.
- **Idempotent upserts.** `panama_district_indicators` writes via `(cod_dist, age_group, transport_mode)` PK. Re-running the audit is safe.
- **Framework auto-detection traps.** Several iterations of Railway/Nixpacks issues — fixed by adding a root `package.json` with `engines.node=22` and `packageManager=pnpm@10.33.2` so Nixpacks's Node provider activates correctly.

## Known limitations and what's deferred to v3

- **First full audit not yet completed in production.** We hit the Groq daily 100K token limit during local smoke testing; the deployed worker is wired but the full 664-cell run will fire on the next cron tick after the daily reset. UI gracefully shows "not yet computed" for unaudited cells.
- **Panama only.** Multi-country (Honduras, then 2-3 more LAC countries with rural/urban + socioeconomic data) is the v3 target — same worker pattern applied as a country-onboarding pipeline.
- **Robustness Auditor uses JSON-mode prompting, not real OpenAI tool calling.** Upgrade to function-calling with tools like `lookup_neighbor_districts`, `lookup_alternative_scenario` is v3 polish.
- **No auth yet.** Multi-tier access (anon read, operator role for the audit dashboard) is queued for v3.
- **No `ask_cache` Supabase table yet.** v2 cache is in-memory and resets on Vercel cold start. v3 adds shared persistent cache.
