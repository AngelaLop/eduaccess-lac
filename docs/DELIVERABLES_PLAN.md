# EduAccess LAC — Deliverables Plan (v1 → v4)

> Course: Design, Build, Ship — MPCS 51238 — Spring 2026
> Project arc: v1 (Week 6) → v2 (Week 7) → v3 (Week 8) → v4 (Week 9 fair)
> Inspiration: [mapai.net](https://www.mapai.net/) — chat-with-spatial-data, but for LAC education ministers
> Data backbone: [`IDB/accessibility_platform`](../IDB/accessibility_platform) (532k schools, 21 countries, Panama pilot fully computed)

---

## Guiding strategy

**Start small end-to-end, then layer.** The class spec (`Project v1.pdf`) says exactly this, and the Week 4 architecture pattern (one repo, multiple services, shared DB) is the target shape we converge on.

**Do not block the app on the pipeline.** Panama already has full indicators from the pilot. v1 shipped *Panama only* with what was already computed. v2 added the pipeline as a Railway worker. v3 added agents + a security pass. v4 polishes and adds countries.

**Address Shubham's feedback structurally, not cosmetically.** His note — *"this will turn into a data exercise — think about how you'll use agents for each part of the analysis and how to explain the robustness of recommendations"* — is the spine of v2, v3, and v4. We are not building a chat-with-CSV. We are building an **agentic data system** where each pipeline step is an inspectable, explainable agent and every recommendation carries a robustness profile.

**Deterministic-first, LLM only where prose adds value.** The hardest lesson of v2/v3: narrating every cell with an LLM was never the right requirement. Numbers and rankings are computed deterministically (free, idempotent, versionable, defensible to a minister); an LLM is reserved for the few paragraphs where prose genuinely adds value. Fix architecture before swapping vendors.

**Compute-menu mapping** (Week 5 architecture benchmark):

| Layer | Used for |
|---|---|
| Client (browser) | MapLibre rendering, indicator panels, chat UI |
| API route (Vercel) | Text-to-SQL agent, recommendation agent, request validation |
| DB (Supabase) | Indicator tables, school_base, audit trails, RLS, Realtime |
| Worker (Railway) | Per-country onboarding pipeline, robustness scoring, geocoding QA |
| Realtime | Pipeline progress, "agent is thinking" streams to the /admin dashboard |
| MCP servers | Supabase (DB), Playwright (UI tests), Figma (design), Railway (ops) |

---

## v1 — Week 6 — SHIPPED 2026-04-28 — "Prove the idea works" (Panama only)

**Deliverable goal:** A deployed, shareable Vercel URL where a classmate opens the link, clicks a Panamanian municipality, and asks the bot a question that returns an answer pinned to the map.

**What landed**
- Next.js 14 app on Vercel (`apps/web`).
- MapLibre GL JS choropleth of Panama's ADM2 municipalities (~80 polygons), colored by `pct_within_30min_walk` for upper secondary (the indicator most varied across Panama in the pilot).
- Indicator side panel on click: `pct_within_15/30/60min_walk`, `pct_within_30min_motor`, `n_schools`, `pop_school_age`, `school_per_1000_pop`, `poverty_rate`, `exclusion_severity`.
- **Robustness card** on every panel (the Shubham feedback in v1 form): `data_completeness`, `n_schools_with_gps`, `n_schools_geocoded`, `geocoder_score_median`. Tooltip: "How much do we trust this number?"
- Text-to-SQL chat constrained to a single view `v_panama_indicators` with documented columns. Validates the SQL, runs it, displays both the table and a map highlight.
- Onboarding: pinned starter prompts, default zoomed-in view on Panama with one example pre-answered.
- Public, no auth.

**Out of scope (cut ruthlessly for v1):** multi-country, the cloud pipeline (Panama indicators exported as a one-shot SQL seed), authentication, comparative views, exports, i18n, mobile polish, agents beyond the SQL one, pretty UI.

**Architecture (one platform, shared DB)**
```
[Browser] -- MapLibre + chat --> [Vercel API route /api/ask]
                                       |
                                       +-- LLM (text -> SQL)
                                       +-- Supabase (read-only view v_panama_indicators)
```

**Risk + mitigation (proven out in v1)**
- LLM hallucinates SQL -> constrain to one view, whitelist columns, validate + `EXPLAIN`, show the generated SQL before running. On validation failure, show the error; do not auto-retry blindly.
- Map data too heavy -> simplify Panama ADM2 polygons before upload. Target < 500 KB GeoJSON.

---

## v2 — Week 7 — SHIPPED 2026-05-05

**What landed:**
- Three parallel streams (A: tabbed Insight/Ask + scope card + out_of_scope render; B: `/api/ask` rewritten as a 3-kind router with district name resolution + action validation; C: map hover popups + ranked-highlight numbered labels + Insight landing visualization) merged in order.
- **Worker as a real second service** — `apps/worker` on Railway. Robustness Auditor agent (4 deterministic dimensions + LLM-written narrative per cell) and Priority Scorer (children × access gap × confidence). Cron `0 3 * * *` UTC.
- Frontend RobustnessCard now reads from `robustness_reports`; Insight landing's PriorityPanel reads from `priority_scores` with a per-row plain-English "why" line.
- Cohort feedback fully addressed (7/7 items).

**Lessons that informed v3+:**
- Multi-iteration Railway/Nixpacks fight — fixed by adding a root `package.json` with `engines.node` + `packageManager`.
- **Free Groq is structurally wrong for a per-cell bulk audit.** 70B's daily token ceiling can't cover a full 664-cell run; 8B's per-minute cap forces concurrency=1 + retry pacing into a ~2-hour wall time. The fix is *architectural*, not a model swap — see v3.
- Charts in chat bubbles felt wrong — visualization belongs on the standing Insight panel.

---

## v3 — Week 8 — SHIPPED 2026-05-12

**Planned vs shipped — corrected record.** The original plan slated v3 for the second country. It was re-scoped mid-week to the *robustness architecture pivot + security pass* the Week 7 brief demanded, plus an inequality-in-motion simulation. Second-country work moved to v4. This section is the corrected history; `v3-summary.md` has the full detail.

**What landed:**
- **Robustness architecture pivot.** The v2 worker ran one LLM call per cell × 664 cells per refresh and lost a race with Groq's free-tier quota. v3 kills the per-cell LLM loop: a deterministic rule-based explainer (`apps/worker/src/explainer.ts`) writes a headline + 1–3 specific caveats from the 4 numeric scores — zero tokens, zero retries, idempotent. The only LLM call left in the worker is one ~120-word country audit brief per refresh (`apps/worker/src/country-brief.ts`). Worker wall time dropped from ~2h (when it finished at all) to 8s on Railway.
- **Versioning + stale-text invalidation.** `robustness_reports` gained `narrative_source`, `facts_version`, `prompt_version`, `model`, `input_hash`; new `country_audit_briefs` table. When versions drift, cached LLM text invalidates back to the deterministic text — prose can never silently drift from the numbers.
- **Security pass** (the Week 7 brief's theme): per-IP rate limiter on `/api/ask` (30 req / 15 min, runs before JSON parsing), GitHub Actions CI (typecheck both apps + gitleaks on every push/PR), `.env.example` files, agent deny list in `CLAUDE.md`. One CRITICAL false positive (a subagent claimed committed live keys) caught, hand-verified false, and documented at the top of `SECURITY_AUDIT.md`.
- **Inequality-in-motion simulation.** A Simulate tab compresses 60 simulated minutes into a 20-second story: the main choropleth heats up through `pct_le15/30/60` while three kid tracks (Hardest / Typical / Easiest district) show who reaches a school and who is still stuck partway across at minute 60.
- **Docs reorg** into `/docs` (closes a v2-feedback item) and a **SQL-validator fix** for single-row aggregates (`SUM(...)` with no `GROUP BY` no longer wrongly rejected for a missing `LIMIT`).

**Robustness explanation strategy (the design that carries into v4).** Three tiers, by producer:

| Tier | Producer | When | Coverage | Cost |
|---|---|---|---|---|
| Numeric scores | Pure SQL in worker | Every refresh | All cells | Free |
| **Deterministic explanation text** | Rule-based template in worker | Every refresh | All cells | Free |
| LLM narrative polish | On-demand via API on user click | User click | Whatever a human opens | bounded by attention |
| **LLM country audit brief** | Worker, once per refresh | Post-refresh | One paragraph per country | ~2K tokens/country |

**The deterministic explanation is the authoritative display.** LLM polish is *additive*, never the only explanation. The same tiering is reused by the v4 Recommender agent.

**Cross-country score semantics** (the rule v4 inherits): a 72/100 robustness score in Panama (travel-time-based) does not mean the same as 72/100 in a country scored on proxy distance + SES. Within a single country, show the numeric score with methodology in a tooltip; in any cross-country comparison, show band labels (Low / Moderate / High) only, with a "scores not directly comparable across methodologies" footnote.

---

## v4 — Week 9 — Project fair: Colombia + the Recommender agent

**Theme:** multi-country reach + the agent that finishes Shubham's feedback. Colombia is the proof country; the schema and worker pipeline are built to absorb Costa Rica, Ecuador, and Peru as their data finishes — school-level data for PEN and COL is ready now; CRI, ECU, and PER are in progress.

**Audience for the demo shifts:** the LAC-minister story works better with a comparison view across countries than with one-country-deep.

### Headline deliverable 1 — Policy Recommendation Agent

Per-district, ranks intervention archetypes: **build primary**, **build secondary**, **transport subsidy**, **hybrid**. Two tiers, mirroring the v3 robustness layer exactly:

- **Ranking tier — deterministic.** Pure numeric logic over indicators + `robustness_reports`: expected-impact estimate, per-archetype scores, and the robustness band. No LLM. Free, idempotent, versionable, and defensible to a minister — you can show the formula.
- **Narrative tier — one LLM call.** Writes the evidence trail prose + counter-arguments for a district. Cached and versioned exactly like the country brief (`prompt_version`, `facts_version`, `model`, `input_hash`). **Reuses the Groq Llama 3.3 70b already wired into the worker** — no new model, no new vendor, no new key, no cost. Generated on-demand (user click) or prewarmed for top-N priority districts; never bulk per-district (Colombia alone has ~1,100 municipalities — bulk narration would repeat the v2 mistake).

**No recommendation ships without a robustness band attached.** This is Shubham's feedback formally closed.

### Headline deliverable 2 — Colombia online (multi-country)

- New schema `indicators_adm2` — multi-country shape, columns include `country_iso`, `urban_rural`, `ses_band`. Designed once to hold all 21 LAC countries; Colombia is the first non-Panama tenant.
- Worker grows a **country-onboarding pipeline**: a `pipeline_jobs` table with status; the frontend `/admin` page subscribes via Realtime to watch a run go `queued -> ingesting -> scoring -> explaining -> brief -> done` live. This is the demo moment for the worker pattern.
- **Country switcher** in the UI top bar. Default stays Panama; a click loads Colombia.
- The Robustness Auditor adapts to the "schools but no travel-time" reality. The narrative is explicit: *"This score is based on school density and straight-line distance, not travel time."* Honesty about scope is itself a robustness move.
- **Cross-country comparison view:** pick two districts (across countries OK), see their indicators side by side. Per the v3 rule, comparison shows band labels only with the non-comparability footnote.

**Indicators computed cheaply per district** (no Phase B GIS re-run): schools per 1,000 school-age population, public/private mix, % districts with zero schools, straight-line distance to nearest school, spatial concentration score, rural/urban classification (WorldPop density + admin area), socioeconomic proxy (Meta Relative Wealth Index, openly available).

### Supporting work

- **Two-tier Ask pipeline.** `llama-3.1-8b-instant` handles classification + a prompt-injection / relevance guard; `llama-3.3-70b` fires only when SQL synthesis is actually needed. This relieves the Groq TPM/TPD pressure carried since v2 and gives a natural home for an injection-guard stage. Note: the cascade is a cost/quota/latency optimization — Ask's actual security remains the SQL validator (whitelist), the per-IP rate limiter, Zod, `EXPLAIN`, and the constrained view. The guard stage is the security-adjacent gain, not the cascade itself.
- **Figma MCP design pass.** Week 5 UI/UX principles seriously: hierarchy, space, one accent, alignment grid, consistent button system, every state drawn (default/hover/loading/empty/error/success), mobile-first.
- **First-run experience + accessibility pass.** WCAG AA contrast, semantic HTML, onboarding for a cold visitor.

### Stretch (cut first if time runs short)

- **Export reports** — async PDF per district (worker generates, returns a Supabase Storage URL) with the robustness profile + recommendation.
- **Spanish locale** — Next.js i18n.

### Still out of scope

- Auth — public data, doesn't need it.
- Phase B GIS pipeline for new countries — proxy indicators are good enough and the UI is honest about it.
- More than one new country *built deep* — Colombia is done well; CRI/ECU/PER ingest through the same pipeline as their data lands, but are not the demo's focus.

### Build order (dependency-driven)

1. **Verify the v3 robustness schema migration is actually live in Supabase** (`country_audit_briefs` + the five `robustness_reports` columns). Hard blocker — everything below assumes it.
2. Migrate to the multi-country `indicators_adm2` schema.
3. Onboard Colombia through the worker pipeline (build `pipeline_jobs` + `/admin` Realtime view alongside).
4. Build the Recommender against the now-multi-country shape, so it works for Panama and Colombia from day one.
5. Two-tier Ask pipeline.
6. Figma design pass + first-run / accessibility pass last, over the finished surface.

**Submission v4:** Project fair demo + final video + one-page summary. The video shows a country onboarding live in `/admin`, Colombia appearing with its audit brief, and a district recommendation with its robustness band. Be ready for *"How do you know your recommendations are right?"* — the Robustness Auditor + per-recommendation confidence band is the answer.

---

## Cross-cutting decisions (decide once, write down, stop debating)

| Decision | Choice | Reason |
|---|---|---|
| Frontend framework | Next.js App Router | Coursework, i18n built in |
| Map library | MapLibre GL JS | Free, choropleth-capable |
| Map basemap | Maptiler free tier or Carto Voyager | No Mapbox token cost |
| DB | Supabase | Course-standard; Postgres + RLS + Realtime |
| Worker | Railway, Nixpacks build, `restartPolicyType = NEVER` | Exits cleanly after each audit |
| LLM (chat / Ask) | Two-tier Groq gpt-oss: `openai/gpt-oss-20b` guard + classify, `openai/gpt-oss-120b` SQL synth | Free tier; small model relieves quota + hosts the injection guard |
| LLM (agents — country brief, recommender narrative) | Groq Llama 3.3 70b | Free, already wired; rankings/scores are deterministic so the LLM only writes bounded, cached, versioned prose |
| Robustness + recommender ranking | Deterministic (pure SQL / numeric logic) | Free, idempotent, versionable, defensible to a minister |
| Service role key | Railway + Vercel server functions only, never `NEXT_PUBLIC_` | Week 4 rule |
| Tests | pytest (existing) + Playwright MCP smoke | Cheap, high signal |
| Multi-model | Claude Code primary, Codex second-opinion reviewer on the SQL validator + Ask prompt | Week 4 multi-model fluency |
| MCP servers connected | Supabase, Playwright, Railway, Figma (v4) | All free, all official |

---

## Answering Shubham, in one paragraph (steal this for the v4 README)

EduAccess LAC turns six months of pipeline work into a tool a non-technical director can open in two minutes. The data exercise is the project, and we don't pretend it isn't: every indicator on screen carries a **robustness profile** computed by a dedicated auditor agent (data completeness, sample size, friction-source agreement, population-source agreement), and no policy recommendation ships without that profile attached. Each analysis step — robustness scoring, the country audit brief, the Ask router, the Policy Recommender — runs as an inspectable agent that writes audit rows to Supabase, so the frontend can show not just *what* the answer is but *how confident* we are and *why*. Where friction surfaces disagree, the map says so. Where a country has schools but no travel-time data, the narrative says the score rests on density and straight-line distance instead. The chat-with-data assistant (text-to-SQL on a constrained view) is the front door, but the spine is the agentic, observable pipeline behind it.
