# EduAccess LAC — v3 Summary

**Built:** 2026-05-11 | **Live:** https://eduaccess-lac.vercel.app | **Course:** Design, Build, Ship (MPCS 51238)

## What we built

v3 is two complementary blocks: an **architectural pivot of the robustness layer** and a **security pass** triggered by the Week 7 class brief. The pivot was the more interesting work — it kills the per-cell LLM loop that defined v2 and replaces it with a deterministic rule-based explainer that runs in milliseconds, is free, and produces the same text for the same inputs. The LLM stays in the worker for exactly one job per refresh per country: a ~120-word country audit brief that summarizes where the data is strong, where it is weak, and what a director should and should not conclude. The security pass closed the most exposed real gap (no per-IP rate limit on the public `/api/ask` route) and put a CI gate on the repo. A separate audit subagent produced a 7-layer security report; one CRITICAL finding it surfaced was hand-verified as a false positive and is documented as such in `SECURITY_AUDIT.md`.

## Why the v2 LLM-per-cell loop had to go

Two things landed in the days after v2 shipped. First, hands-on debugging confirmed what we suspected: Groq's free tier cannot fit a full 664-cell audit in one day on the 70B model (TPD ceiling), and the 8B model's TPM bucket forced concurrency=1 + retry-after pacing, which turned a "nightly" job into a 2-hour wall-time run. Second, a Codex second-pass review pushed past the surface problem and named the deeper one: *narrating every cell with AI was never the right requirement*. The TA's feedback was about explaining the **robustness of recommendations**, not paraphrasing the same four numeric scores 664 times. Deterministic text is more honest, scientifically defensible, free, always-available, and idempotent. The LLM is reserved for the one artifact where prose actually adds value — one paragraph per country, surfaced at the top of the landing.

## Block A — Robustness architecture pivot

| Piece | Where | What it does |
|---|---|---|
| Schema migration | `data/seed/panama/v3_robustness_schema.sql` | Adds `narrative_source`, `facts_version`, `prompt_version`, `model`, `input_hash` to `robustness_reports`; creates `country_audit_briefs` table |
| Deterministic explainer | `apps/worker/src/explainer.ts` | Rule-based templates over the 4 numeric scores → headline + weakest-dimension sentence + 1-3 specific caveats. Pure function. Free. |
| Worker rewiring | `apps/worker/src/audit.ts` | Drops the per-cell LLM loop and the concurrency primitive; iterates synchronously, stamps `narrative_source='deterministic'` + versioning columns. Country brief is best-effort (errors do not fail the run). |
| Country audit brief | `apps/worker/src/country-brief.ts` | One LLM call per refresh per country. Aggregates the run's robustness scores into a compact stats payload, asks for a single 90-130 word paragraph in plain prose. Inserts into `country_audit_briefs` stamped with model + versions + audit_run_id. |
| Landing surface | `apps/web/app/components/CountryAuditBrief.tsx` | Renders the latest brief at the top of the Insight landing, with a "How we computed this" disclosure listing model, prompt_version, facts_version, generated date. |
| RobustnessCard footer | `apps/web/app/components/RobustnessCard.tsx` | Updated to say "text generated from the scores by a rule-based explainer (no LLM on this cell)" — honesty about provenance. |

The versioning columns are not decorative: when scoring weights or text templates change, `facts_version` / `prompt_version` bump. When v4's lazy `/api/audit-cell` route lands and polishes a cell with LLM prose, that row will carry `narrative_source='llm'` plus the model + versions that wrote it. Cached LLM text can be invalidated against current versions to prevent prose-drifts-from-numbers — the worst failure mode of cached AI output.

## Block B — Security pass

The class brief's theme for Week 7 was security. We ran the `security_review.md` 7-layer audit prompt as an Explore subagent against the repo. The agent produced a structured report. Before acting on its findings I hand-verified the top-severity items, which is what every audit-runner should do.

**One CRITICAL false positive caught and documented.** The audit report claimed live Supabase service-role and Groq keys were committed to the repo in `apps/web/.env.local` and `apps/worker/.env`. Verified false: `git ls-files | grep env` shows only `apps/worker/.env.example` (placeholder), `git log --all --diff-filter=A` confirms no `.env` was ever added, and `.gitignore` covers all the right paths. The subagent read those files on the local disk despite its prompt explicitly forbidding it, then conflated "exists locally" with "committed to repo." Lesson banked, audit report filed with the correction inline.

**Verified findings that were addressed in this session:**

- **HIGH — No per-IP rate limit on `/api/ask`.** A public, unauthenticated route that fans requests out to Groq's free tier can be looped by anyone with the URL until the daily token quota is exhausted, breaking the demo for the cohort. Fixed with an in-memory sliding-window limiter (`apps/web/lib/rate-limit.ts`) at 30 requests / 15 minutes per IP. Limiter runs *before* JSON parsing so a flooder doesn't get free work on every hit. Returns 429 with a `Retry-After` header.
- **HIGH — No CI gate.** Added `.github/workflows/ci.yml` running typecheck on both `apps/web` and `apps/worker` and a gitleaks secret scan on every push to `main` and every PR.
- **LOW — Missing `apps/web/.env.example`.** Added with placeholders for all five required vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY`, `GROQ_MODEL`).
- **LOW — No agent deny list.** Added an explicit deny-list section to `CLAUDE.md` covering `.env*` reads, lockfile + deploy config writes, destructive git ops, and verbatim logging of user questions.

**Findings deferred to v4:**

- **MEDIUM — No structured monitoring (Sentry / Axiom).** Recognized; out of v3's 7.5h budget. Documented in `SECURITY_AUDIT.md` as a known gap.
- **MEDIUM — Permissive `.claude/settings.local.json` wildcards.** `.claude/` is itself gitignored so this only affects the local developer's agent permissions, not collaborators. Tightening the wildcards is a maintenance task, not a security incident.
- **HIGH-but-deferred — No Husky pre-commit hook.** CI is the actual gate. Husky is a nice-to-have local guardrail; the GitHub Actions workflow already prevents bad code from reaching `main`.

The full audit report — with the false-positive correction prefixed and verified findings severity-ranked — is in `SECURITY_AUDIT.md`. It is the submission artifact for the Week 7 audit pass.

## What's NOT in v3 (on purpose)

- **Second country.** Planned for v4. v3 stayed Panama-only so the architectural pivot landed cleanly.
- **Lazy `/api/audit-cell` LLM polish.** Designed for v4. The versioning columns added in this migration are the foundation for it.
- **Worker prewarm of top-N priority cells.** Same — v4.
- **Policy Recommender agent.** v4.

## Files of note

- `apps/worker/src/explainer.ts` — the new deterministic explainer
- `apps/worker/src/country-brief.ts` — the one LLM step left in the worker
- `apps/web/app/components/CountryAuditBrief.tsx` — the landing surface
- `apps/web/lib/rate-limit.ts` — the per-IP limiter
- `.github/workflows/ci.yml` — the CI gate
- `data/seed/panama/v3_robustness_schema.sql` — the migration
- `SECURITY_AUDIT.md` — the audit findings + corrections
- `CLAUDE.md` — updated to v3 + agent deny list

## Architecture (delta from v2)

```
[Browser]
  Insight landing now leads with the Country Audit Brief (one paragraph)
  RobustnessCard footer says "text generated by a rule-based explainer"
  /api/ask is rate-limited per IP, 30 requests / 15 min
         ▲                                ▲
         │ anon key (RLS read)            │ POST {question}
         │                                │
[Supabase Postgres]                [Vercel API route /api/ask]
  + country_audit_briefs           rate limiter → Zod → Groq → SQL validator
  + robustness_reports columns:
      narrative_source             [Railway worker — apps/worker]
      facts_version                  Trigger: data or rubric change (NOT a daily cron)
      prompt_version                 Per cell (664):
      model                            1. 4 deterministic SQL scores (unchanged)
      input_hash                       2. Deterministic explainer → narrative + caveats
                                       3. Stamp narrative_source='deterministic' +
                                          facts_version + prompt_version + input_hash
                                     Per country (1):
                                       1. Aggregate stats from this run's robustness_reports
                                       2. ONE LLM call (Groq) → 90-130 word paragraph
                                       3. Insert into country_audit_briefs

[CI: .github/workflows/ci.yml]
  Typecheck web + worker · gitleaks · runs on push to main + every PR
```

## Time budget

7.5h split roughly: 30 min context restoration and planning, 45 min security audit subagent (run in parallel with Block A) + hand-verification of findings, 2.5h Block A (migration + explainer + worker rewire + country brief + landing component), 2.5h Block B (rate limiter + CI + .env.example + deny list + writing up `SECURITY_AUDIT.md` with the false-positive correction), 1h summary writing and final check.

## Demo readiness

For v3 the demo path is shorter than v2's: open the platform, the Insight landing shows the country audit brief at the top — one paragraph that names the country's data strengths and structural weaknesses. Click a district, the RobustnessCard explains *that cell* with a deterministic sentence keyed to the weakest of its four dimensions. Open the SQL on any chat answer to see the validator gate. Try to spam the chat endpoint and the 429 kicks in. The robustness layer is now defensible to a minister: every number on screen has provenance, and the provenance is honest about whether prose was AI-written or rule-based.
