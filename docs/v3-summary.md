# EduAccess LAC — v3 Summary

**Built:** 2026-05-11 to 2026-05-12 | **Live:** https://eduaccess-lac.vercel.app | **Course:** Design, Build, Ship (MPCS 51238)

## What v3 is

Three threads landed this version: an **architectural pivot of the robustness layer**, a **security pass** triggered by the Week 7 brief, and an **inequality-in-motion simulation** that turns the platform's static `% within 30 min` answer into a 20-second story about who reaches a school and who doesn't. A mid-session SQL-validator fix, a landing-page redesign that surfaces the simulation as a fast answer to the headline question, and a docs reorganization closed out the v2-feedback loop. All work is on `main`, deployed to Vercel and Railway, with passing CI on every commit.

## Block A — Robustness architecture pivot

The v2 worker ran one LLM call per cell × 664 cells per refresh and lost a race with Groq's free-tier daily quota. The pivot kills the per-cell LLM loop and replaces it with a deterministic rule-based explainer; the LLM is reserved for exactly one job per refresh per country — a ~120-word country audit brief. The deeper insight, sharpened by a Codex second-pass review: *narrating every cell with AI was never the right requirement*. The TA's feedback was about explaining the **robustness of recommendations**, not generating per-row prose. Deterministic text is more honest, free, idempotent, and always available; the LLM is reserved for the one paragraph where prose actually adds value.

| Piece | Where | What it does |
|---|---|---|
| Schema migration | `data/seed/panama/v3_robustness_schema.sql` | Adds `narrative_source`, `facts_version`, `prompt_version`, `model`, `input_hash` to `robustness_reports`; creates `country_audit_briefs` table |
| Deterministic explainer | `apps/worker/src/explainer.ts` | Rule-based templates over the 4 numeric scores → headline + weakest-dimension sentence + 1-3 specific caveats. Pure function. Free. |
| Worker rewiring | `apps/worker/src/audit.ts` | Drops the per-cell LLM loop and the concurrency primitive; iterates synchronously and stamps `narrative_source='deterministic'` + versioning columns. Country brief is best-effort. |
| Country audit brief | `apps/worker/src/country-brief.ts` | One LLM call per refresh per country (~2K tokens). Aggregates the run's robustness scores and asks for a single 90-130 word paragraph. Inserts into `country_audit_briefs` stamped with model + versions + audit_run_id. |
| Landing surface | `apps/web/app/components/CountryAuditBrief.tsx` | Renders the latest brief at the top of the Insight landing with a "How we computed this" disclosure listing model, prompt_version, facts_version, generated date. |
| RobustnessCard footer | `apps/web/app/components/RobustnessCard.tsx` | Says explicitly that the per-cell text is rule-based, not LLM-written. Honest provenance. |

**Result on Railway:** the v2 worker took ~2 hours of wall time when it could finish at all. The v3 deterministic worker finished in **8 seconds** on the first cron tick after deploy, including the country audit brief call. Confirmed via the Cron Runs tab — green dot at 5/12 8:17 AM after a long sequence of red failures on the v2 code.

## Block B — Security pass

The class brief's theme was security. The pass ran the `docs/security_review.md` 7-layer audit prompt as an Explore subagent against the repo. Findings were hand-verified before any code changed.

**One CRITICAL false positive caught and documented.** The audit report claimed live Supabase service-role and Groq keys were committed in `.env.local` and `apps/worker/.env`. Verified false: `git ls-files | grep env` showed only `apps/worker/.env.example`, `git log --all --diff-filter=A` confirmed no `.env` ever in history, and `.gitignore` covers everything that matters. The subagent had read the files on the local disk despite explicit instruction not to, then conflated "exists locally" with "committed to repo." The correction is filed inline at the top of `docs/SECURITY_AUDIT.md`. Lesson banked: when a subagent surfaces a CRITICAL finding, verify it before acting.

**Verified findings addressed:**

- **HIGH — No per-IP rate limit on `/api/ask`.** The public unauthenticated route could be looped until the day's Groq quota was drained. Fixed with an in-memory sliding-window limiter (`apps/web/lib/rate-limit.ts`) at 30 requests / 15 minutes per IP. Limiter runs *before* JSON parsing so a flooder doesn't get free work. Returns 429 with a `Retry-After` header.
- **HIGH — No CI gate.** Added `.github/workflows/ci.yml` running `pnpm typecheck` on both apps + a gitleaks secret scan on every push and PR. CI has been green on every commit since the v3 work landed. Latest gitleaks output: `✅ No leaks detected`.
- **LOW — Missing `apps/web/.env.example`.** Added.
- **LOW — No agent deny list.** Added an explicit section in `CLAUDE.md` covering `.env*` reads, lockfile + deploy config writes, destructive git ops, and verbatim logging of user questions.

**Deferred to v4 (acknowledged in the audit report):** Sentry / structured monitoring, tightening `.claude/settings.local.json` wildcards, Husky pre-commit (CI is the actual gate).

## Bonus: SQL validator fix for single-row aggregates

Mid-session catch from live use. The validator rejected `SELECT SUM(pop_total) FROM v_panama_indicators` for missing `LIMIT`, even though aggregates without `GROUP BY` always return one row. Llama 3.3 70B intermittently drops `LIMIT` on aggregate queries, and the retry path didn't recover. Fixed in `apps/web/lib/sql-validator.ts` — when SQL has an aggregate (`COUNT/SUM/AVG/MIN/MAX`) in the top-level SELECT, no top-level `GROUP BY`, and no window function (`OVER`), the LIMIT requirement is skipped. Multi-row queries still require LIMIT. No widening of the attack surface.

## Inequality in motion — the simulation

The most-iterated piece of v3. Goal: a visual that answers the headline question *"How accessible are schools in Panama?"* with a 20-second story instead of a static `% within 30 min` number. Three iterations before it landed:

1. **Dark-modal particle simulation** — 800 dots on a black overlay. Killed: too noisy, lost the geography, didn't fit the platform's visual language.
2. **Map-as-dots inside a Simulate tab** — better integration but still dot-soup; the inequality story drowned in motion.
3. **Final: choropleth heats up + 3 kid tracks (B + C of the UX brainstorm).** The main map's choropleth fill is rebound to a time-varying expression — at simMin=30 the colors equal the static `pct_le30` you see on Insight, in between they interpolate through pct_le15 / pct_le30 / pct_le60. The same map vocabulary unfolds through time. In the side panel, three kid tracks (Hardest / Typical / Easiest districts) show one child each walking along a horizontal track to a school icon; each kid's position equals their district's cumulative %-reached at the current simulated minute. At minute 60, the Hardest kid is still partway across the track — the inequality made visceral.

Additional refinements after first hands-on use:
- Bars only appeared to animate at the end of the run. Root cause: CSS `transition-[width] duration-100` was swallowing per-frame updates. Removed the transitions; each frame now renders its exact computed position. Doubled the simulation duration from 10s to 20s so the smaller-movement bars (Hardest district might only travel ~5%) become readable.
- "X% reach a school within 30 min" subtitle under each track was the *static* `pct_le30` value, mistakenly read as a live number. Removed; the per-track live % at the top-right corner is now unambiguous, plus one clear block-level explanation: *"The number on each track is the share of {age group} in that district who have reached a school by the current simulated minute."*
- Clock and Play button were separated vertically by the kid tracks block, forcing the user to scroll to pause. Merged into a single compact HUD row at the top of the panel: clock readout on the left, active transport control on the right. They share a single bordered block — pause without scrolling.

**Files:** `apps/web/app/components/SimulationPanel.tsx` (side panel UI: HUD + kid tracks + stats), `apps/web/app/components/PanamaMap.tsx` (the time-varying choropleth fill expression), `apps/web/app/components/AppShell.tsx` (single `requestAnimationFrame` loop driving simMin state, leaving the Simulate tab cancels and resets cleanly), `apps/web/lib/types.ts` (PanelTab union widened to include `'simulation'`).

## Landing page redesign

The v2 landing had a typewriter rotating Ask prompts as the single CTA — strong, but it told only the "Ask" story when the platform now had three pillars (Insight / Ask / Simulate). The iteration went through three options:

1. **Three-verb stack replacing the typewriter** — proposed by a UX subagent; objectively answered the discoverability question but the user pushed back ("I really liked the typing animation"). Reverted.
2. **Typewriter + bordered "Watch" card below** — kept the typewriter; the card competed visually with the typewriter for hierarchy.
3. **Final: typewriter + a single low-key inline link** at footer weight, copy polished to read as a fast answer to the headline question: *"▶ Watch how many kids walk to school in 60 minutes — in 20 seconds"*. Click lands directly on `/platform?tab=simulation`.

The `AppShell` URL bootstrap was widened to honor `?tab=simulation` and `?tab=insight` (previously only `?tab=ask` and `?ask=…` were supported). The `LandingPromptCarousel.tsx` typewriter component is preserved as-was for the prompt rotation.

## Closing the TA v2-feedback loop

Shubham's v2 feedback (`docs/Feedback_1.md`) flagged two specific items:

1. **"A /docs folder would do you a favor."** The repo root had 11 markdown files (and v3 added more). Done: this version moved `DELIVERABLES_PLAN.md`, `PROJECT_PROPOSAL.md`, `Feedback_1.md`, `V1_CHECKLIST.md`, `V2_CHECKLIST.md`, `v1-summary.md`, `v2-summary.md`, `v3-summary.md`, `SECURITY_AUDIT.md`, and `security_review.md` into `docs/`. `README.md`, `CLAUDE.md`, and `AGENTS.md` stay at root (convention — agents look for them there). `CLAUDE.md`'s "Files of note" section was updated to point at the new paths.
2. **"Make sure the audit is actually firing before final review."** Was about the broken v2 Railway cron. The v3 deterministic worker just ran successfully on Railway in 8 seconds with `country_audit_briefs` written.

The v1 feedback (*"agents for each part of the analysis, and explain robustness of recommendations"*) is the architectural spine of v3 itself: Robustness Auditor (deterministic + LLM brief tiers), Priority Scorer, Ask router (3-kind classifier), Country Audit Brief writer — each is an inspectable step. The RobustnessCard's 4 dimensions plus the deterministic narrative plus the country brief is the full robustness-explanation surface.

## What's NOT in v3 (on purpose)

- Second country (rural/urban + SES) — v4.
- Lazy `/api/audit-cell` LLM polish on user click — v4. The versioning columns added in this migration are the foundation for it.
- Worker prewarm of top-N priority cells — v4.
- Policy Recommender agent — v4.
- Husky pre-commit hook — CI is the actual gate.
- Sentry / structured monitoring — v4.

## Architecture (delta from v2)

```
[Browser]
  Landing now leads with the typewriter + low-key Watch link.
  Platform has three tabs: Insight · Ask · Simulate.
  Simulate compresses 60 simulated minutes into a 20-second
  choropleth heat-up plus 3 kid tracks; clock + controls share one HUD.
  /api/ask is per-IP rate-limited (30 req / 15 min) and accepts
  single-row aggregate SQL without LIMIT.
         ▲                                ▲
         │ anon key (RLS read)            │ POST {question}
         │                                │
[Supabase Postgres]                [Vercel API route /api/ask]
  + country_audit_briefs           rate limiter → Zod → Groq → SQL validator
  + robustness_reports columns:
      narrative_source             [Railway worker — apps/worker]
      facts_version                  Trigger: data or rubric change
      prompt_version                 Per cell (664):
      model                            1. 4 deterministic SQL scores
      input_hash                       2. Deterministic explainer → narrative
                                       3. Stamp versioning columns
                                     Per country (1):
                                       1. Aggregate stats from this run
                                       2. ONE LLM call → 90-130 word brief
                                       3. Insert into country_audit_briefs

[CI: .github/workflows/ci.yml]
  Typecheck web + worker · gitleaks · runs on push to main + every PR
  Status: green on every commit since v3 landed
```

## Demo readiness

Landing → click *"Watch how many kids walk to school in 60 minutes — in 20 seconds"* → Simulate tab opens directly → Play → 20 seconds later, the choropleth has heated up to the same colors users see on Insight, and one of the three kids is visibly stuck partway across their track. That's the inequality moment. Switch to Insight, click a district, read the deterministic RobustnessCard narrative + see the country audit brief at the top. Switch to Ask, fire a seeded prompt (or try a quota-friendly aggregate question like *"what is the total school age population?"*) and see the SQL collapsible below the answer.

Every number on screen has provenance, every recommendation has a confidence band, and every LLM-written paragraph is stamped with its model and prompt version. The TA's v1 feedback is answered structurally, not cosmetically.
