# CLAUDE.md

> Context file for Claude Code. Read this before doing anything in this repo.

## What you're working on

This is **EduAccess LAC**, a Next.js + Supabase + (eventually) Railway-worker system for the Design, Build, Ship course at UChicago. It is a geo-platform that helps Latin American education ministers see where to build schools, with an AI chat assistant that generates SQL against a constrained indicator schema.

**Today's mission depends on which version we're shipping.** Check the headline below.

---

## Current version: **v4 (Week 9) — Colombia + the Policy Recommender agent**

v1 (Week 6), v2 (Week 7), and v3 (Week 8) are shipped. v3 delivered the deterministic robustness explainer, a security pass, and the inequality-in-motion simulation — all Panama-only. v4 goes multi-country and ships the agent that finishes the TA's feedback:

- **Policy Recommendation Agent.** Per-district intervention ranking (build primary / build secondary / transport subsidy / hybrid). Two tiers: a **deterministic** ranking (impact estimate + archetype scores + robustness band — pure numeric logic, no LLM) and a **narrative** tier — one cached, versioned LLM call reusing the Groq Llama 3.3 70b already in the worker. No new model, no cost, never bulk per-district. No recommendation ships without a robustness band attached.
- **Colombia online.** Country #2 is Colombia. New multi-country schema `indicators_adm2` (`country_iso`, `urban_rural`, `ses_band`), a worker country-onboarding pipeline (`pipeline_jobs` + `/admin` Realtime view), a country switcher, and a cross-country comparison view (band labels only — scores are not comparable across methodologies). Schema is built to absorb CRI/ECU/PER as their data finishes.
- **Two-tier Ask.** `llama-3.1-8b-instant` for classify + a prompt-injection/relevance guard; `llama-3.3-70b` for SQL synthesis only. This is a cost/quota move — Ask's security stays the SQL validator + rate limiter + constrained view.
- **Design + accessibility.** Figma MCP design pass and a first-run + WCAG AA accessibility pass.

**v4 build order (dependency-driven):**
1. Verify the v3 robustness schema migration is live in Supabase — hard blocker.
2. Migrate to the multi-country `indicators_adm2` schema.
3. Onboard Colombia through the worker pipeline.
4. Build the Recommender against the multi-country shape.
5. Two-tier Ask, then the design + accessibility pass.

**v4 cuts (do NOT build these now):**
- Export PDF reports — stretch goal, cut first if time runs short
- Spanish locale (i18n) — stretch goal
- Auth — out of scope (public data)
- Phase B GIS pipeline for new countries — out (proxy indicators instead)
- Husky pre-commit hook — defer (CI is the actual gate)
- Sentry / structured monitoring — defer

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
