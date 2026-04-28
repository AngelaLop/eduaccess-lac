# CLAUDE.md

> Context file for Claude Code. Read this before doing anything in this repo.

## What you're working on

This is **EduAccess LAC**, a Next.js + Supabase + (eventually) Railway-worker system for the Design, Build, Ship course at UChicago. It is a geo-platform that helps Latin American education ministers see where to build schools, with an AI chat assistant that generates SQL against a constrained indicator schema.

**Today's mission depends on which version we're shipping.** Check the headline below.

---

## Current version: **v1 (Week 6) � Panama only, no Railway**

For v1 we are NOT building the pipeline in the cloud. The Phase B indicators for Panama are already computed in `c:\Users\lopez\github\IDB\accessibility_platform` (the IDB repo, separate, not part of this project). We export Panama indicators as a CSV, seed Supabase, and build the app on top.

**v1 scope (do not exceed):**
- Next.js 14 app at `apps/web`, deployed to Vercel
- MapLibre choropleth of Panama ADM2 (~80 polygons), colored by `pct_within_30min_walk` for upper secondary
- Click a polygon ? indicator side panel with hero metric + secondary metrics + robustness card
- `/api/ask` text-to-SQL endpoint using **Groq + Llama 3.3 70B** via the OpenAI-compatible API at `https://api.groq.com/openai/v1`. (Gemini was blocked by uchicago Google account policy; Anthropic now requires a payment method. Groq is genuinely free and faster than both.) Model: `llama-3.3-70b-versatile`. Env var: `GROQ_API_KEY`.
- 5 seeded prompts as buttons above the chat input
- Public, no auth

**v1 cuts (do NOT build these now):**
- Railway worker � comes in v2
- More countries beyond Panama � comes in v2/v3
- Robustness Auditor agent � v1 has a static robustness card only
- Policy Recommender agent � v3
- i18n, exports, comparative views � v4
- Figma polish � v4

The execution checklist is in `V1_CHECKLIST.md`. Follow it. If you find yourself doing something not on it, stop and ask.

---

## Architecture rules (across all versions)

1. **Service role key on Railway only.** Never `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`. Frontend uses the anon key + RLS.
2. **The LLM never sees raw tables.** It only sees the curated view `v_panama_indicators` (v1), later `v_indicators_adm2` (v2+). Each column has a comment in the prompt.
3. **The LLM never executes arbitrary SQL.** Validate first: must start with `SELECT`, must reference only the allowed view, must include `LIMIT`, no `;`, no `pg_*` functions, no DDL/DML. Run `EXPLAIN` before the actual query.
4. **Show the SQL to the user.** Transparency beats magic. Collapsible "Show SQL" section under every chat answer.
5. **Robustness over confidence.** Every indicator on screen must answer "how much do we trust this?" � even if v1's answer is just `data_completeness`, `n_schools_with_gps`, and `geocoder_score_median`. This is non-negotiable; it's the answer to the TA feedback.
6. **Upsert for indicator writes** (v2+). `onConflict: 'adm2_pcode,education_level'`.
7. **Monorepo layout:** `apps/web`, `apps/pipeline-worker` (v2+), `packages/shared`, `data/seed/<country>`.

---

## Multi-model workflow

- **Claude Code (you)** is the primary driver for application code, UI, schema, and integration.
- **Codex** is used for a second-pass review specifically on `apps/web/lib/sql-validator.ts` and the prompt engineering in `apps/web/app/api/ask/route.ts`. Treat Codex's review like a code reviewer � incorporate suggestions but don't blindly accept rewrites.

---

## Data conventions (inherited from the IDB repo, do not invent new ones)

- `adm2_pcode` is the join key for everything municipality-level. It is a string. Never an integer.
- `education_level` is one of `'primary' | 'lower_secondary' | 'upper_secondary'`.
- Travel times are in **minutes**. Percentages are 0�100, not 0�1.
- `exclusion_severity` is one of `'optimal' | 'adequate' | 'significant' | 'severe'` (cutoffs at 95 / 80 / 50 of `pct_within_30min_motor`).
- See `c:\Users\lopez\github\IDB\accessibility_platform\definitions.md` for full indicator definitions.

---

## What "done" looks like for v1

A classmate opens the Vercel URL on their phone, sees Panama colored by upper-secondary walking access, taps a dark-red municipality, sees the robustness card explaining the data behind the number, taps a seeded prompt like "Top 5 worst-served municipalities", and watches the answer appear with the 5 polygons highlighted gold. All in under 30 seconds, no instructions.

If a classmate has to read instructions to use it, v1 has failed.

---

## Files of note

- `PROJECT_PROPOSAL.md` � original proposal
- `Feedback_1.md` � TA feedback (Shubham): "think about how you'll use agents for each part of the analysis and how to explain the robustness of recommendations." This is the spine of v3.
- `DELIVERABLES_PLAN.md` � v1�v4 arc
- `V1_CHECKLIST.md` � what to actually do for v1
- `AGENTS.md` � same context for Codex / other agents
