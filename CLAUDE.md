# CLAUDE.md

> Context file for Claude Code. Read this before doing anything in this repo.

## What you're working on

This is **EduAccess LAC**, a Next.js + Supabase + (eventually) Railway-worker system for the Design, Build, Ship course at UChicago. It is a geo-platform that helps Latin American education ministers see where to build schools, with an AI chat assistant that generates SQL against a constrained indicator schema.

**Today's mission depends on which version we're shipping.** Check the headline below.

---

## Current version: **v3 (Week 7) — security + deterministic robustness explainer**

v1 (Week 6) and v2 (Week 7, post-mortem on the per-cell LLM loop) are shipped. v3 keeps Panama-only scope but rebuilds the robustness layer:

- **Deterministic explainer** (`apps/worker/src/explainer.ts`) writes one short sentence + 1-3 specific caveats for every cell from the 4 numeric scores. Zero tokens, zero retries, identical text for identical inputs.
- **One LLM call per refresh per country** is the only LLM step left in the worker — a ~120-word country audit brief written by `apps/worker/src/country-brief.ts` and surfaced at the top of the Insight landing.
- **Versioning columns** on `robustness_reports`: `narrative_source`, `facts_version`, `prompt_version`, `model`, `input_hash`. Future LLM-polished narratives invalidate against these.
- **Security pass** completed: per-IP rate limiter on `/api/ask`, GitHub Actions CI (typecheck + gitleaks), agent deny list (below). See `SECURITY_AUDIT.md` for the full audit + corrections.

**v3 cuts (do NOT build these now):**
- Lazy `/api/audit-cell` LLM polish — v4
- Worker prewarm for top-N priority cells — v4
- Second country (rural/urban + SES) — v4 if v3 lands clean
- Policy Recommender agent — v4
- Husky pre-commit hook — defer (CI is the actual gate)
- Sentry / structured monitoring — v4

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

- `README.md` — short repo overview, stays at root
- `AGENTS.md` — same context for Codex / other agents, stays at root
- `docs/PROJECT_PROPOSAL.md` — original proposal
- `docs/Feedback_1.md` — TA feedback (Shubham): "think about how you'll use agents for each part of the analysis and how to explain the robustness of recommendations." Spine of v3.
- `docs/DELIVERABLES_PLAN.md` — v1→v4 arc (v3 rationale is the "Robustness explanation strategy" section)
- `docs/SECURITY_AUDIT.md` — v3 security audit findings + corrections
- `docs/security_review.md` — the audit prompt the v3 audit ran against
- `docs/V1_CHECKLIST.md`, `docs/V2_CHECKLIST.md` — per-version execution checklists
- `docs/v1-summary.md`, `docs/v2-summary.md`, `docs/v3-summary.md` — model-generated post-version summaries

---

## Security: agent deny list

Claude Code and any other agents working on this project MUST NOT:

1. **Read or modify `.env`, `.env.local`, `.env.*.local`.** These hold live API keys. Use `.env.example` files for placeholders instead.
2. **Commit any `*.png` at the repo root.** `keys*.png` is gitignored as a safety net for credential screenshots; do not bypass it.
3. **Modify `package.json` or `pnpm-lock.yaml`** without explicit user approval. Lockfile changes must go through `pnpm add` / `pnpm remove`.
4. **Modify `vercel.json`, `railway.json`, `nixpacks.toml`, or `.github/workflows/`** without confirming the change with the user first — these affect production deploys.
5. **Run destructive git operations** (`git push --force`, `git reset --hard`, `git checkout -- .`, branch deletion) without explicit user approval.
6. **Log full user questions verbatim** from `/api/ask` to any persistent artifact. Logging digests + length is fine.
7. **Skip pre-commit hooks** (`--no-verify`) or commit signing flags unless the user explicitly asks for it.
