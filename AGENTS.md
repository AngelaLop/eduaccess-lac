# AGENTS.md

> Open-standard context file (Linux Foundation). Read by Codex, Copilot CLI, Gemini CLI, Cursor, and Claude Code. Mirrors `CLAUDE.md`.

## Project: EduAccess LAC

A Next.js + Supabase + Railway-worker system that helps Latin American education ministers see where to build schools. AI chat assistant generates SQL against a constrained indicator schema. Inspired by [mapai.net](https://www.mapai.net/).

**Built on top of:** the IDB Accessibility Platform pipeline at `c:\Users\lopez\github\IDB\accessibility_platform` (532k schools across 21 LAC countries; Panama pilot already computed end-to-end).

---

## Current version: v1 (Week 6) — Panama only, no Railway worker

For v1 we are NOT running the pipeline in the cloud. Panama indicators are exported from the IDB repo as a one-shot CSV seed, loaded into Supabase, and the app reads them.

**v1 scope (hard cap):** Next.js app on Vercel · MapLibre choropleth of Panama ADM2 · indicator side panel · text-to-SQL chat (Gemini 2.5 Flash with Claude Haiku 4.5 fallback) · 5 seeded prompts · static robustness card. Public, no auth.

**v1 anti-scope:** Railway worker, more countries, full Robustness Auditor agent, policy recommender, exports, i18n, Figma polish. These land in v2/v3/v4.

The execution checklist is in `V1_CHECKLIST.md`. Stay on it.

---

## Architecture rules

1. Service role key on Railway only (when v2 lands). Never `NEXT_PUBLIC_*` for service role. Frontend uses anon key + RLS.
2. LLM only sees the curated view `v_panama_indicators` (v1). Each column commented in the prompt.
3. LLM never executes arbitrary SQL. Validator: SELECT only, allowed view only, must include LIMIT, no `;`, no `pg_*`, no DDL/DML. `EXPLAIN` first.
4. Generated SQL is shown to the user (collapsible). Transparency over magic.
5. Every indicator on screen carries a robustness signal — v1 is `data_completeness`, `n_schools_with_gps`, `geocoder_score_median`. Non-negotiable; it's the answer to TA feedback (Shubham, Apr 22).
6. Upsert for indicator writes (v2+) on `(adm2_pcode, education_level)`.
7. Monorepo: `apps/web`, `apps/pipeline-worker` (v2+), `packages/shared`, `data/seed/<country>`.

---

## Multi-model workflow

- **Claude Code:** primary driver for app code, UI, schema, integration.
- **Codex (you, if invoked):** second-pass reviewer for `apps/web/lib/sql-validator.ts` and the prompt at `apps/web/app/api/ask/route.ts`. Treat as code review: identify issues, propose targeted edits, do not silently rewrite the whole file. If Claude Code wrote the file in a recent commit, anchor your review to that commit.

When acting as second-pass reviewer, output should be a structured review:

```
## Issues found
1. <severity>: <file:line> — <description>
   suggested fix: <patch or sentence>

## Looks good
- <thing>
```

---

## Data conventions (inherited from IDB repo — do not reinvent)

- `adm2_pcode` is a string. Always. It is the join key.
- `education_level` ? {`primary`, `lower_secondary`, `upper_secondary`}.
- Times in **minutes**. Percentages 0–100.
- `exclusion_severity` ? {`optimal` (>95), `adequate` (80–95), `significant` (50–80), `severe` (<50)}, computed from `pct_within_30min_motor`.
- See `c:\Users\lopez\github\IDB\accessibility_platform\definitions.md` for full definitions.

---

## Build & run

```bash
# Repo root will hold the monorepo. v1's only app is apps/web.
cd apps/web
pnpm install
pnpm dev
# build for Vercel
pnpm build
```

Required env vars (`apps/web/.env.local`):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `GEMINI_API_KEY` (server-only)
- `ANTHROPIC_API_KEY` (server-only fallback)

---

## Project documents

- `PROJECT_PROPOSAL.md` — original proposal
- `Feedback_1.md` — TA feedback (Shubham, Apr 22)
- `DELIVERABLES_PLAN.md` — v1–v4 plan
- `V1_CHECKLIST.md` — v1 execution checklist
- `CLAUDE.md` — same context as this file, for Claude Code
