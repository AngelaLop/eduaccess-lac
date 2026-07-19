# EduAccess LAC

> An interactive geo-platform with an AI assistant that helps Latin American education ministers make evidence-based decisions about where to build schools.

**Course:** Design, Build, Ship — MPCS 51238 — Spring 2026
**Author:** Angela López Sánchez (`AngelaLop`)
**Status:** v4 shipped (Week 9, 2026-05-19)

---

## Live URL

**[https://eduaccess-lac.vercel.app](https://eduaccess-lac.vercel.app)**

---

## What this is

A platform that turns six months of pipeline work on the [IDB Accessibility Platform](https://github.com/AngelaLop/accessibility_platform) (532k schools across 21 LAC countries) into a tool a non-technical Ministry of Education director can open in 30 seconds.

Click a district. See how many high schoolers live more than 30 minutes from a school and how much to trust that number. Ask the chat "rank the worst-served districts" — it generates SQL, runs it, and highlights the results on the map.

---

## What works

- **Five countries.** The platform opens on a map of Latin America and covers Panama, Colombia, Costa Rica, Ecuador and Peru — click any one to drop into its district view.
- **Insight panel.** Click a district → hero metric, travel-time bands, a 3-dimension robustness card, and the national Policy Recommender ranking.
- **Equity lens.** Urban/rural and wealth-quintile access gaps — per country (the "Access gaps" card) and across countries (the LAC map's Area gap / Wealth gap views).
- **AI chat.** Plain-English questions → a two-tier LLM cascade → validated SQL → a table plus gold map highlights, with a collapsible "Show SQL" on every answer.
- **Inequality in motion.** A 20-second simulation: the choropleth heats up over 60 simulated minutes while three sampled districts race a child to a school.
- **Robustness everywhere.** Every number carries a trust signal; no recommendation ships without a confidence band.

## Version history

| Version | Shipped | Theme |
|---|---|---|
| v1 | Week 6 | Panama pilot — choropleth, robustness card, AI chat |
| v2 | Week 7 | Robustness Auditor — a cron worker on Railway |
| v3 | Week 8 | Deterministic robustness explainer, security pass, inequality simulation |
| v4 | Week 9 | Multi-country — five LAC countries; Policy Recommender, equity lens, two-tier Ask |

Per-version retrospectives live in [`docs/`](./docs) (`v1-summary.md` → `v4-summary.md`).

---

## Architecture

Three deployables — a Next.js frontend on Vercel, a cron worker on Railway, and a
Supabase Postgres database — plus Groq-hosted Llama models for the AI chat.

```
[Browser]  marketing landing → LAC regional map → per-country workspace
    │              MapLibre choropleth + Insight / Ask / Simulate panels
    ▼
[Vercel — /api/ask]  two-tier LLM cascade
    Stage 1  llama-3.1-8b   classify + prompt-injection guard
    Stage 2  llama-3.3-70b  text → SQL (data questions only)
    sql-validator.ts  →  run_sql() Postgres function
    ▼
[Supabase]  accessibility_indicators (FMM + OSRM routing, multi-country)
    v_indicators_adm2 + v_equity  — the only views the LLM can see
    robustness_reports · priority_scores · country_audit_briefs (worker-derived)
    RLS: anon read-only on the frontend, service role on the API + worker
    ▲
[Railway — apps/worker]  cron: rebuilds robustness + priority per country
```

**Full detail — system diagrams, the chat request flow, the database schema, and
the security model — is in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).**

---

## Tech stack

- **Frontend:** Next.js 16 (App Router), TypeScript, Tailwind v4, MapLibre GL JS v5
- **Database:** Supabase Postgres (RLS, anon key on frontend, service role on API + worker)
- **Worker:** Node + TypeScript on Railway (cron)
- **LLM:** Groq-hosted Llama — 3.1 8B (classify + guard) and 3.3 70B (text→SQL), called through the `openai` npm SDK pointed at Groq's OpenAI-compatible API
- **Data:** IDB Accessibility Platform — FMM + OSRM travel times, WorldPop population, across the covered LAC countries

---

## Local development

```bash
cd apps/web
pnpm install
pnpm dev
```

`apps/web/.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
GROQ_API_KEY=
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_GUARD_MODEL=llama-3.1-8b-instant
```

---

## Project documents

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — system architecture (v4)
- [`docs/DELIVERABLES_PLAN.md`](./docs/DELIVERABLES_PLAN.md) — the v1 → v4 arc
- [`docs/PROJECT_PROPOSAL.md`](./docs/PROJECT_PROPOSAL.md) — original proposal
- Per-version summaries — [`v1`](./docs/v1-summary.md) · [`v2`](./docs/v2-summary.md) · [`v3`](./docs/v3-summary.md) · [`v4`](./docs/v4-summary.md)
- [`docs/SECURITY_AUDIT.md`](./docs/SECURITY_AUDIT.md) — security audit findings
- [`docs/Feedback_1.md`](./docs/Feedback_1.md) — TA feedback that shaped the robustness work
- [`data/seed/`](./data/seed) — Supabase schema + migrations

---

## License

MIT. Data sources retain their original licenses (WorldPop, OSM, MAP friction surface, IDB data).
