# EduAccess LAC — Deliverables Plan (v1 ? v4)

> Course: Design, Build, Ship · MPCS 51238 · Spring 2026
> Project arc: v1 (Week 6) ? v2 (Week 7) ? v3 (Week 8) ? v4 (Week 9 fair)
> Inspiration: [mapai.net](https://www.mapai.net/) — chat-with-spatial-data, but for LAC education ministers
> Data backbone: [`IDB/accessibility_platform`](../IDB/accessibility_platform) (532k schools, 21 countries, Panama pilot fully computed)

---

## Guiding strategy

**Start small end-to-end, then layer.** The class spec (`Project v1.pdf`) says exactly this, and the Week 4 architecture pattern (one repo, multiple services, shared DB) is the target shape we converge on.

**Do not block the app on the pipeline.** Panama already has full indicators from your pilot. v1 ships *Panama only* with what's already computed. v2 adds the pipeline as a Railway worker. v3 adds agents. v4 polishes and adds countries.

**Address Shubham's feedback structurally, not cosmetically.** His note — *"this will turn into a data exercise … think about how you'll use agents for each part of the analysis and how to explain the robustness of recommendations"* — is the spine of v2 and v3. We are not building a chat-with-CSV. We are building an **agentic data system** where each pipeline step is an inspectable, explainable agent and every recommendation carries a robustness profile.

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

## v1 — Week 6 · "Prove the idea works" (Panama only)

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
- The pipeline itself running in the cloud — for v1 we **export Panama indicators as a one-shot SQL seed** and import to Supabase. No Railway yet.
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
- 1.0h — Panama indicators export + Supabase seeding + view definition
- 1.5h — Next.js skeleton, MapLibre choropleth, click ? panel
- 1.5h — `/api/ask` route + Gemini integration + SQL validator
- 1.0h — Robustness card + onboarding examples
- 1.0h — Vercel deploy + smoke test + tweak
- 1.0h — Polish, README, agent summary, recording
- 0.5h — Buffer

---

## v2 — Week 7 · "It's a system, not an app" (pipeline as worker)

**Theme:** Apply Week 4. The Phase B pipeline becomes a **Railway worker** that processes countries on demand, writes to Supabase, and streams progress via Realtime. Add **Honduras** (geocoding done) so we have two countries.

**What's IN scope**
- New service `apps/pipeline-worker` (Node.js shim that invokes the Python pipeline via subprocess, or a pure-Python worker on Railway — pick one based on Railway language support; Python on Railway works fine).
- Worker reads a `pipeline_jobs` table in Supabase: `{country, step, status, progress_pct, started_at, finished_at, log_tail}`. Frontend has a hidden `/admin/pipeline` page (no auth for v2, hidden URL) that subscribes via Realtime and shows live progress for steps 07–10 per country.
- Service role key on Railway, anon key with RLS on Vercel. Make this distinction explicit in `CLAUDE.md`.
- Honduras added end-to-end. Country switcher in the UI.
- Indicator schema upgraded from `indicators_panama` to `indicators_adm2` (the multi-country shape from your README).
- **First explicit agent in the analysis:** a *Geocoding QA agent* runs as part of the worker. For each country, it samples N geocoded schools, summarizes ArcGIS score distribution, flags discrepancies, and writes a `geocoding_qa_report` row that the frontend surfaces in the robustness card. Use Claude Haiku via API.
- Upsert pattern (Week 4) used for `indicators_adm2` — same row keys (`adm2_pcode`, `education_level`) across re-runs.

**What's OUT**
- More countries beyond PAN + HND.
- Public auth.
- Recommendation agent (lands in v3).

**Architecture**
```
[ESPN-style external sources]      [Browser]
   WorldPop, MAP, OSM, IDB              ?
        ?                               ?
        ?                       [Vercel: web + API]
[Railway worker]  ???????????   [Supabase: tables + Realtime + RLS]
   - 07 population zonal               ?
   - 08 friction surfaces              ?
   - 09 FMM travel time                ?
   - 10 compute indicators             ?
   - geocoding_qa_agent ???????????????? (writes qa_reports)
```

**Submission v2**: GitHub + Vercel + Railway log screenshot + a 90s video showing a country going from "queued" ? "computing 07/08/09/10" ? "done" ? frontend updates live, then asking the bot a Honduras question.

**Time budget: 7.5h** — heavy on the worker (you've never deployed Python to Railway before; budget 3h for that alone).

---

## v3 — Week 8 · "Agents for each part of the analysis" (Shubham's feedback, paid in full)

**Theme:** Make the *analysis* agentic and the *recommendations* explainable. This is also where the project starts to look like MapAI but with a defensible policy angle.

**Three agents added** (each is a Vercel API route + a typed prompt + a small toolset, not chat-bots; they return structured JSON):

1. **Robustness Auditor**
   - Input: `adm2_pcode`, `education_level`.
   - Tools: SQL queries over indicators_adm2, school_base, geocoding_qa_reports, population provenance.
   - Output: `{score: 0–100, dimensions: {data_completeness, geocoder_confidence, sample_size, friction_source_agreement, poverty_data_recency}, narrative: string, caveats: []}`.
   - Surfaced in the panel — replaces the simple v1/v2 robustness card.

2. **Policy Recommendation Agent**
   - Input: a municipality.
   - Tools: SQL, the Robustness Auditor, a small library of intervention archetypes (build a primary school, build a secondary school, transport subsidy, hybrid), each with a one-paragraph rationale template.
   - Output: ranked recommendations with: expected impact (rough, e.g., "would bring ~3,800 children within 30 min walk"), evidence trail (which indicators support it), confidence level (from the Auditor), and counter-arguments ("but motorized access is already 92% — road, not school, may be the bottleneck").
   - **No recommendation ships without a robustness score attached.** This is the answer to Shubham.

3. **Friction Sensitivity Agent**
   - Input: country.
   - Compares MAP vs OSM friction surfaces. Flags municipalities where the two sources disagree by >X%.
   - Output: a `friction_disagreement` overlay layer on the map + an annotation in affected municipality panels.

**Other v3 work**
- Add Colombia (in-progress geocoding) and one more country (pick based on which finishes 05 first; Argentina or Mexico are good candidates given their geocoder scores).
- Spanish UI (Next.js i18n, just one extra locale — Portuguese in v4 if time).
- "Compare two municipalities" view.
- Test suite: pytest for pipeline asserts already in your IDB repo + Playwright MCP for the frontend (smoke test the chat happy path and a click-and-panel-opens path).

**Submission v3**: same as before + a written one-pager (`AGENTS.md`-style) describing the three agents, their tools, and how they interact. Graders should see the analysis pipeline is now agentic.

---

## v4 — Week 9 · "Project fair" (polish, story, scale)

**Theme:** Make it presentable to a minister. Apply Week 5's UI/UX principles seriously. Use Figma MCP.

**What's IN**
- **Figma MCP design pass** (Week 5 slides 12–14). Generate a polished design system in Figma ? ask Claude/Codex to rebuild the frontend against it. Hierarchy, space, one accent, alignment grid, consistent button system, every state drawn (default/hover/loading/empty/error/success), inline errors, mobile-first 375px breakpoint.
- **Export reports.** PDF or Excel summary for a selected municipality, with the robustness profile and recommendations embedded — the literal artifact a minister attaches to a funding proposal.
- **Portuguese locale.**
- **More countries** if pipeline allows: aim for 5–7 total. If pipeline lags, ship 4 well-done countries rather than 7 broken ones.
- **Live demo readiness.** Pre-loaded talking track. The 60-second demo from v1 now has a 3-minute extended cut for the project fair.
- **First-run experience** (Week 5 principle 27): a 4-step guided tour the first time someone lands.
- **Error states & empty states** (principles 11, 20, 21).
- **Accessibility** (principle 25): WCAG AA contrast, semantic HTML, alt text on all icons, color never the only signal for `exclusion_severity`.

**What's OUT**
- Auth (still not needed; this is public data).
- "Add a hypothetical school" simulation (was a stretch goal; punt unless v3 is on time).

**Submission v4**: Project fair demo + final repo + final video walkthrough + one-page summary describing the system, the architecture, the agents, and what robustness means in this app. Have answers ready for: "How do you know your recommendations are right?" — point to the Robustness Auditor.

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
