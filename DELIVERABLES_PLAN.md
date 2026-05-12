# EduAccess LAC � Deliverables Plan (v1 ? v4)

> Course: Design, Build, Ship � MPCS 51238 � Spring 2026
> Project arc: v1 (Week 6) ? v2 (Week 7) ? v3 (Week 8) ? v4 (Week 9 fair)
> Inspiration: [mapai.net](https://www.mapai.net/) � chat-with-spatial-data, but for LAC education ministers
> Data backbone: [`IDB/accessibility_platform`](../IDB/accessibility_platform) (532k schools, 21 countries, Panama pilot fully computed)

---

## Guiding strategy

**Start small end-to-end, then layer.** The class spec (`Project v1.pdf`) says exactly this, and the Week 4 architecture pattern (one repo, multiple services, shared DB) is the target shape we converge on.

**Do not block the app on the pipeline.** Panama already has full indicators from your pilot. v1 ships *Panama only* with what's already computed. v2 adds the pipeline as a Railway worker. v3 adds agents. v4 polishes and adds countries.

**Address Shubham's feedback structurally, not cosmetically.** His note � *"this will turn into a data exercise � think about how you'll use agents for each part of the analysis and how to explain the robustness of recommendations"* � is the spine of v2 and v3. We are not building a chat-with-CSV. We are building an **agentic data system** where each pipeline step is an inspectable, explainable agent and every recommendation carries a robustness profile.

**Compute-menu mapping** (Week 5 architecture benchmark):

| Layer | Used for |
|---|---|
| Client (browser) | MapLibre rendering, indicator panels, chat UI |
| API route (Vercel) | Text-to-SQL agent, recommendation agent, request validation |
| DB (Supabase) | Indicator tables, school_base, audit trails, RLS, Realtime |
| Worker (Railway) | Phase B pipeline runs per country (07/08/09/10), geocoding QA |
| Realtime | Pipeline progress, "agent is thinking" streams to dev dashboard |
| MCP servers | Supabase (DB), Playwright (UI tests), Figma (design), Railway (ops) |

---

## v1 � Week 6 � "Prove the idea works" (Panama only)

**Deliverable goal:** A deployed, shareable Vercel URL where a classmate can open the link, click a Panamanian municipality, and ask the bot a question that returns an answer pinned to the map.

**What's IN scope**
- Next.js 14 app on Vercel (`apps/web`).
- MapLibre GL JS choropleth of Panama's ADM2 municipalities (~80 polygons), colored by `pct_within_30min_walk` for upper secondary (the indicator most varied across Panama in your pilot).
- Indicator side panel on click: `pct_within_15/30/60min_walk`, `pct_within_30min_motor`, `n_schools`, `pop_school_age`, `school_per_1000_pop`, `poverty_rate`, `exclusion_severity`.
- **Robustness card** on every panel (this is the Shubham feedback in v1 form): `data_completeness`, `n_schools_with_gps`, `n_schools_geocoded`, `geocoder_score_median`. Tooltip: "How much do we trust this number?" One line per source.
- Text-to-SQL chat (Gemini 2.5 Flash, Claude Haiku 4.5 fallback). Constrained to a single view `v_panama_indicators` with documented columns. Validates the SQL, runs it, displays both the table and a map highlight.
- Onboarding: pinned starter prompts ("Top 5 municipalities with worst upper-secondary access", "Where is poverty highest among low-access areas?"), and a default zoomed-in view on Panama with one example pre-answered.
- Public, no auth.

**What's OUT of scope (cut ruthlessly)**
- Multi-country (Honduras and Colombia wait until v2/v3).
- The pipeline itself running in the cloud � for v1 we **export Panama indicators as a one-shot SQL seed** and import to Supabase. No Railway yet.
- Authentication, comparative views, exports, i18n, mobile polish, "agents" beyond the SQL one.
- Pretty UI. Use Tailwind defaults + the Week 5 principles (one accent color, one primary action, neutral base, hierarchy via type scale). Figma MCP polish lands in v4.

**Architecture (one platform, shared DB)**
```
[Browser] ?? MapLibre + chat ??> [Vercel API route /api/ask]
                                       ?
                                       ?? Gemini 2.5 Flash (text?SQL)
                                       ?? Supabase (read-only view v_panama_indicators)
```

**Data flow for v1**
1. From `IDB/accessibility_platform`, export Panama indicators (already computed in the pilot) to a single Parquet/CSV.
2. Load into Supabase as `indicators_panama` + a `geometries_panama` GeoJSON column (or join via `adm2_pcode`).
3. Create `v_panama_indicators` view with documented columns the LLM is allowed to see. **The LLM never sees raw tables.**
4. Frontend reads the view directly with the anon key (RLS = read-only on the view).

**Risk + mitigation**
- LLM hallucinates SQL ? constrain to one view, whitelist columns, validate with `pg_typeof` + `EXPLAIN`, show the generated SQL to the user before running. If validation fails, show the error to the user, don't auto-retry.
- Map data too heavy ? simplify Panama ADM2 polygons with `mapshaper -simplify 10%` before upload. Target < 500 KB GeoJSON.

**Demo script (60 seconds)**
1. Land on the page ? Panama, choropleth visible, one example answer pinned.
2. Click a dark-red municipality ? panel opens, robustness card shows confidence.
3. Type "rank top 5 muni with worst walking access for high schoolers" ? answer appears as a list + the 5 polygons get a gold border on the map.
4. Show the generated SQL underneath the answer (transparency).

**Submission package (Tuesday)**
- GitHub repo URL (public, monorepo: `apps/web`, `data/seed/panama`, `CLAUDE.md`, `AGENTS.md`).
- Vercel URL.
- Agent-generated summary (`v1-summary.md` written by Claude Code at end of session).
- 30s screen recording.
- Two screenshots: default view + chat answer.

**Time budget: 7.5h**
- 1.0h � Panama indicators export + Supabase seeding + view definition
- 1.5h � Next.js skeleton, MapLibre choropleth, click ? panel
- 1.5h � `/api/ask` route + Gemini integration + SQL validator
- 1.0h � Robustness card + onboarding examples
- 1.0h � Vercel deploy + smoke test + tweak
- 1.0h � Polish, README, agent summary, recording
- 0.5h � Buffer

---

## v2 — Week 7 — SHIPPED 2026-05-05

**What landed:**
- Three parallel streams (A: tabbed Insight/Ask + scope card + out_of_scope render; B: `/api/ask` rewritten as a 3-kind router with district name resolution + action validation; C: map hover popups + ranked-highlight numbered labels + Insight landing visualization) merged in order.
- **Worker as a real second service** — `apps/worker` on Railway. Robustness Auditor agent (4 deterministic dimensions + LLM-written narrative per cell) and Priority Scorer (children × access gap × confidence). Cron `0 3 * * *` UTC.
- Frontend RobustnessCard now reads from `robustness_reports`; Insight landing's PriorityPanel reads from `priority_scores` with a per-row plain-English "why" line.
- Cohort feedback fully addressed (7/7 items).

**Lessons that informed v3+:**
- Multi-iteration Railway/Nixpacks fight — fixed by adding root `package.json` with `engines.node` + `packageManager`. Codex caught this. Future deploys will be smoother.
- **Free Groq is structurally wrong for a per-cell bulk audit.** 70B's 100K TPD ceiling can't cover a full 664-cell run; 8B has the daily headroom but its 6K TPM cap means concurrency=1 + retry-after pacing → ~2-hour wall time per run. Confirmed by hands-on debug 2026-05-06 (multi-attempt run on local laptop). The fix is *architectural*, not a model swap — see v3 below.
- Charts in chat bubbles felt wrong — visualization belongs on the standing Insight panel.

**Pending after submission:** First full 664-cell audit. As of 2026-05-06: a deferred Railway service got reconfigured at some point (now points at `apps/web`, crashing) — the worker is no longer running on a cron there. Audit currently being completed by a one-shot local run on 8B before the architectural pivot lands in v3.

---

## v3 — Week 8 — "Second country with rural/urban + socioeconomic dimensions"

**Theme:** Multi-country reach with new analytical dimensions. Reuse the v2 worker as a country-onboarding pipeline.

**Audience for the demo shifts:** the LAC minister story works better with a comparison view than with one-country-deep.

**Data we already have (no Phase B re-run needed):**
- School-level data for all 21 LAC countries: counts, public/private split, coordinates, adm1/adm2 boundaries.
- WorldPop for population per district (free, raster).

**Indicators we can compute cheaply per district from this data:**
- Schools per 1000 school-age population
- Public/private mix
- % districts with zero schools
- Straight-line distance to nearest school (district centroid → nearest school)
- Spatial concentration / clustering score
- **Rural/urban classification** per district (using WorldPop density + admin area, or external classification)
- **Socioeconomic status proxy** per district (RWI from Meta — Relative Wealth Index — is openly available; or a national poverty layer if the country publishes one)

**What's IN scope**
- Pick **one second country** with the cleanest data + clearest urban/rural divide (likely Honduras or Costa Rica). Don't try for 3 countries — focus on doing one well.
- Worker grows a country-onboarding pipeline: `pipeline_jobs` table with status, frontend `/admin` page subscribes via Realtime to watch the run live (this is the demo moment for the worker pattern).
- New schema: `indicators_adm2` (multi-country shape, columns include `country_iso`, `urban_rural`, `ses_band`).
- **Country switcher** in the UI top-bar. Default still Panama; a click loads the second country.
- The Robustness Auditor adapts: its 4 dimensions extend to handle the new "we have schools but no travel-time" reality. Be explicit in the narrative: *"This score is based on school density and straight-line distance, not travel time."* Honesty about scope is itself a robustness move.
- Comparison view: pick two districts (across countries OK) and see their indicators side-by-side.

**What's OUT**
- Phase B pipeline for the second country (heavy GIS, lives in IDB repo, would consume v3 entirely).
- More than one new country.
- Auth (queued for v4 if the project ever goes beyond a class demo).
- Policy Recommender agent (was originally v3 — push to v4 if v3 is full).

**Architecture additions**
```
[Railway worker — apps/worker]
  Job queue (pipeline_jobs table)
  Per-country jobs:
    - ingest_schools         (read CSV/Parquet → schools table with country_iso)
    - compute_indicators     (zonal stats, density, distance, urban_rural, ses)
    - score_robustness       (PURE-SQL numeric scores per cell)
    - explain_robustness     (DETERMINISTIC text per cell from numeric scores — no LLM)
    - audit_brief            (ONE LLM call per country: a paragraph audit brief)
    - prewarm_top_n          (LLM polishes narratives for ≤30 priority/outlier cells)
  Concurrency 1 per-country, multiple countries can run in parallel
  Realtime: frontend /admin watches pipeline_jobs status updates live
  Trigger: on data-version change OR rubric-version change. NOT a daily cron by default.
```

**Robustness explanation strategy (the v2-lessons + Codex-review pivot)**

Hands-on debugging in week 7 confirmed that LLM-narrating every cell is structurally wrong on free tier (TPM bucket throttles 8B; TPD ceiling kills 70B). A second-pass review with Codex sharpened the deeper insight: *narrate every cell nightly* was never the right requirement. The TA's feedback was about explaining the **robustness of recommendations**, not generating per-row AI blurbs. v3 reframes the explanation layer in three tiers:

| Tier | Producer | When | Coverage | Cost |
|---|---|---|---|---|
| Numeric scores | Pure SQL in worker | Every refresh | All cells | Free |
| **Deterministic explanation text** | Rule-based template in worker | Every refresh | All cells | Free |
| LLM narrative polish | On-demand via `/api/audit-cell` | User click | Whatever a human opens | ~1K tokens/click |
| LLM prewarm narratives | Worker, after numeric scores land | Post-refresh | ≤30 cells per country (top priorities + biggest source disagreements + demo-path cells) | ~30K tokens/country |
| **LLM country audit brief** | Worker, once per refresh | Post-refresh | One paragraph per country | ~2K tokens/country |

**The deterministic explanation is the authoritative display.** LLM polish is *additive*, not the only explanation. A minister reading "Confidence is moderate; the weakest signal is friction-source agreement (MAP vs OSM differ by 18 points)" gets a more honest, scientifically-defensible answer than a paraphrased AI sentence. The country audit brief is the high-leverage agentic artifact — one paragraph that summarizes "where this country's data is strong, where it is weak, what to trust and what not to" — much better demo material than 664 single-cell narratives.

**Versioning + stale-text invalidation**

`robustness_reports` gains five columns:
- `facts_version` — bumped when scoring weights or thresholds change
- `prompt_version` — bumped when the LLM system prompt changes
- `model` — the model that produced any cached LLM narrative
- `input_hash` — content hash of the underlying numeric inputs for the cell
- `generated_at`

When any of those drift from current, the cached LLM narrative is invalidated and falls back to the deterministic text until something re-prompts it. This prevents prose-drifts-from-numbers, the worst failure mode of cached AI text.

**Cross-country score semantics**

A 72/100 robustness score in Panama (travel-time-based) does not mean the same as 72/100 in Country B (proxy-distance + SES-based). v3's display rule:
- **Within a single country:** show the numeric score with methodology disclosed in a tooltip.
- **In any cross-country comparison view:** show band labels (Low / Moderate / High) only, with a "scores not directly comparable across methodologies" footnote.

This is itself a robustness move — honesty about scope.

**Provider strategy: deferred, on purpose**

Worker is LLM-free except for the brief + prewarm calls (≤32 LLM calls per country per refresh, on a non-daily trigger). On-demand polish is bounded by user attention. Total LLM volume sits comfortably inside Groq free even at v3's cell count. The earlier Cloudflare Workers AI / Ollama / Groq Dev provider stack is **deferred** until there's evidence of actual need. Fix architecture first, vendor second.

**Submission v3:** GitHub + Vercel + a video showing **a country onboarding live** in the admin UI (queued → ingesting → scoring → explaining → audit-brief → prewarm → done) and the new country immediately visible with a country audit brief on the landing page. Bonus: click a never-before-touched district, watch the LLM polish a narrative and cache it back with the right `prompt_version` stamp.

**Time budget: 7.5h** — heaviest on schema migration to multi-country shape and the deterministic-explainer + country-brief code (the latter is a single LLM call template, not a refactor). Railway path well-understood. Worker is *simpler* than v2 (no per-cell LLM loop), so net development effort is lower than the v2 worker, despite covering more capability.

---

## v4 — Week 9 — Project fair: polish + scale + the Recommender agent

**Theme:** Make it presentable to a minister, and ship the missing v3 agent.

**What's IN**
- **Policy Recommendation Agent** (originally v3). Per-district: ranks intervention archetypes (build primary, build secondary, transport subsidy, hybrid) with expected impact estimate, evidence trail, confidence from the Robustness Auditor, and counter-arguments. **No recommendation ships without robustness attached.** This is Shubham's feedback finished.
- **Figma MCP design pass.** Apply Week 5 UI/UX principles seriously: hierarchy, space, one accent, alignment grid, consistent button system, every state drawn (default/hover/loading/empty/error/success), mobile-first.
- **Export reports.** PDF for a selected district with the robustness profile + recommendation. Worker generates async, returns a Supabase Storage URL.
- **Add 1-2 more countries** if v3's onboarding pipeline is solid. Aim for **3-4 countries total**, well-done, not 7 half-done.
- **Spanish locale** (Next.js i18n).
- **First-run experience** + accessibility pass (WCAG AA contrast, semantic HTML).
- **Project-fair demo readiness:** 3-minute extended cut of the v1 demo, talking track pre-loaded.

**What's OUT (still)**
- Auth — public data, doesn't need it.
- Phase B pipeline for new countries — proxies are good enough and honest about it.

**Submission v4:** Project fair demo + final video + one-page summary. Be ready for the question *"How do you know your recommendations are right?"* — the Robustness Auditor + per-recommendation confidence is the answer.

---

## Cross-cutting decisions (decide once, write down, stop debating)

| Decision | Choice | Reason |
|---|---|---|
| Frontend framework | Next.js 14 App Router | Coursework, i18n built in |
| Map library | MapLibre GL JS | Free, choropleth-capable, you already chose it |
| Map basemap | Maptiler free tier or Carto Voyager | No Mapbox token cost |
| DB | Supabase | Course-standard |
| Worker | Railway, Python image | Pipeline is Python; subprocess shim is a tax we don't need |
| LLM (chat) | Gemini 2.5 Flash ? Claude Haiku 4.5 fallback | Free tier first, paid only on quality dip |
| LLM (agents) | Claude Haiku 4.5 | Tool-use reliability matters more than chat fluency |
| Repo shape | Monorepo: `apps/web`, `apps/pipeline-worker`, `packages/shared`, `data/seed`, `CLAUDE.md`, `AGENTS.md` | Week 4 pattern |
| Service role key | Railway only, never in `NEXT_PUBLIC_` | Week 4 rule |
| Tests | pytest (existing) + Playwright MCP smoke (v3+) | Cheap, high signal |
| Multi-model | Claude Code as primary, Codex as second-opinion reviewer for tricky agents | Week 4 multi-model fluency |
| MCP servers connected | Supabase, Playwright, Figma (v4), Railway (v2+) | All free, all official |

---

## Answering Shubham, in one paragraph (steal this for the v4 README)

EduAccess LAC turns six months of pipeline work into a tool a non-technical director can open in two minutes. The data exercise is the project, but we don't pretend it isn't: every indicator on screen carries a **robustness profile** computed by a dedicated auditor agent (data completeness, geocoder confidence, sample size, friction-source agreement, poverty-data recency), and no policy recommendation ships without that profile attached. Each Phase B pipeline step (population zonal, friction surfaces, FMM travel time, indicator computation) runs as an inspectable Railway worker that writes audit rows to Supabase, so the frontend can show not just *what* the answer is but *how confident* we are and *why*. Where the MAP and OSM friction surfaces disagree, the map says so. Where the geocoder is below ground-truth threshold, the panel says so. The chat-with-data assistant (text-to-SQL on a constrained view) is the front door, but the spine is the agentic, observable pipeline behind it.

---

## What I need from you to keep moving

1. **Repo location.** Right now `Final_project/` is inside your home directory but `git status` shows you are sitting in a parent repo at `C:/Users/lopez/`. We should `git init` `Final_project/` itself (or move it under `github/`) and create a clean GitHub remote. Pick: `github.com/<you>/eduaccess-lac` or similar.
2. **Confirm v1 cut.** Are you OK shipping Panama-only tomorrow with no Railway worker? (I strongly recommend yes.)
3. **Codex or Claude Code** as the day-of driver tomorrow? You have both. Suggestion: Claude Code for app code, Codex for a second-pass review on the SQL validator.
4. **Supabase project.** New one for this app, separate from any IDB work. Free tier is fine.
