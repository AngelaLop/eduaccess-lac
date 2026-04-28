# EduAccess LAC

> An interactive geo-platform with an AI assistant that helps Latin American education ministers make evidence-based decisions about where to build schools.

**Course:** Design, Build, Ship — MPCS 51238 — Spring 2026
**Author:** Angela López Sánchez (`AngelaLop`)
**Status:** v1 shipped (Week 6, 2026-04-28)

---

## Live URL

**[https://eduaccess-lac.vercel.app](https://eduaccess-lac.vercel.app)**

---

## What this is

A platform that turns six months of pipeline work on the [IDB Accessibility Platform](https://github.com/AngelaLop/accessibility_platform) (532k schools across 21 LAC countries) into a tool a non-technical Ministry of Education director can open in 30 seconds.

Click a district. See how many high schoolers live more than 30 minutes from a school and how much to trust that number. Ask the chat "rank the worst-served districts" — it generates SQL, runs it, and highlights the results on the map.

---

## What works in v1

- Panama choropleth map colored by high-school walking access (83 districts)
- Click any district → indicator panel with hero metric, secondary stats, age-group toggle
- Robustness card on every panel: data completeness %, population source, friction surface, methodology
- Top 5 worst-access districts highlighted gold on load (no interaction required)
- AI chat: ask plain-English questions → validated SQL → table + map highlights
- 5 seeded prompts for zero-friction first use
- Collapsible "Show SQL" on every chat answer (transparency)

## What's coming in v2–v4

| Version | Theme |
|---|---|
| v2 (Week 7) | Phase B pipeline as Railway worker; Honduras added; Realtime progress |
| v3 (Week 8) | Robustness Auditor agent + Policy Recommender agent + Friction Sensitivity agent |
| v4 (Week 9) | Figma polish, PDF exports, Spanish/Portuguese locale, first-run tour |

---

## Architecture (v1)

```
[Browser]
  MapLibre choropleth + chat UI
         ↓
[Vercel API route /api/ask]
  Groq Llama-3.3-70B (text→SQL)
  sql-validator.ts (whitelist checks)
  run_sql() Postgres function
         ↓
[Supabase]
  panama_district_indicators (2,656 rows, 32 scenarios)
  panama_district_geometries (83 districts)
  v_panama_indicators view (WorldPop + MAP + walking, LLM-visible only)
  RLS: anon key read-only
```

---

## Tech stack

- **Frontend:** Next.js 16 (App Router), TypeScript, Tailwind v4, MapLibre GL JS v5
- **Database:** Supabase Postgres (RLS, anon key on frontend, service role on API)
- **LLM:** Groq + Llama 3.3 70B via OpenAI-compatible SDK
- **Data:** IDB Accessibility Platform Panama pilot (WorldPop 2023, MAP friction surface, Fast Marching Method)
- **Multi-model:** Claude Code (primary), Codex (second-pass review on sql-validator.ts and /api/ask)

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
```

---

## Project documents

- [`DELIVERABLES_PLAN.md`](./DELIVERABLES_PLAN.md) — v1–v4 arc
- [`V1_CHECKLIST.md`](./V1_CHECKLIST.md) — v1 execution checklist
- [`CLAUDE.md`](./CLAUDE.md) — context file for Claude Code
- [`AGENTS.md`](./AGENTS.md) — context file for Codex / other agents
- [`data/seed/panama/schema.sql`](./data/seed/panama/schema.sql) — Supabase schema
- [`Feedback_1.md`](./Feedback_1.md) — TA feedback that shaped the robustness card

---

## License

MIT. Data sources retain their original licenses (WorldPop, OSM, MAP friction surface, IDB data).
