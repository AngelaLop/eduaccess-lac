# EduAccess LAC

> An interactive geo-platform with an AI assistant that helps Latin American education ministers make evidence-based decisions about where to build schools and allocate infrastructure budgets.

**Course:** Design, Build, Ship · MPCS 51238 · Spring 2026
**Author:** Angela L?pez S?nchez (`AngelaLop`)
**Repo name:** `eduaccess-lac` (local working folder may be `Final_project/`)
**Status:** v1 in flight (Week 6, due 2026-04-28)

---

## What this is

A platform that turns six months of pipeline work on the [IDB Accessibility Platform](https://github.com/AngelaLop/accessibility_platform) (532k schools across 21 LAC countries) into a tool a non-technical Ministry of Education director can open and use to justify where to build the next school.

You click a municipality. You see how many high schoolers live more than 30 minutes from a school, what the poverty rate is, and how much we trust those numbers. You ask the chat "rank the worst-served municipalities for upper-secondary access" — it generates SQL, runs it, and highlights them on the map.

Inspired by [mapai.net](https://www.mapai.net/), but with a defensible policy angle: every recommendation comes with a robustness profile.

---

## Live URL

_v1 not yet deployed. Will land at `https://eduaccess-lac.vercel.app` (or similar) by end of Week 6._

---

## Versions

| Version | Week | Theme | Scope |
|---|---|---|---|
| v1 | 6 | Prove the idea | Panama only, deployed Vercel app, map + indicator panel + text-to-SQL chat + robustness card |
| v2 | 7 | It's a system | Phase B pipeline runs as Railway worker; Honduras added; Realtime progress |
| v3 | 8 | Agentic analysis | Robustness Auditor + Policy Recommender + Friction Sensitivity agents; +2 countries; ES locale |
| v4 | 9 | Project fair | Figma MCP polish; PDF exports; PT locale; first-run flow; A11y AA |

Full plan: [`DELIVERABLES_PLAN.md`](./DELIVERABLES_PLAN.md). v1 execution sheet: [`V1_CHECKLIST.md`](./V1_CHECKLIST.md).

---

## Architecture (target, end of v4)

```
External sources                   Browser
WorldPop, MAP, OSM,                  ?
IDB Poverty Maps                     ?
       ?              ???> Vercel (Next.js + API routes)
       ?              ?      - MapLibre choropleth
[Railway worker]      ?      - Text-to-SQL agent
  - 07 population     ?      - Robustness Auditor
  - 08 friction       ?      - Policy Recommender
  - 09 FMM            ?
  - 10 indicators     ?
  - geocoding QA ? Supabase (Postgres + Realtime + RLS)
                       ?
                       ?
                  Frontend reads via anon key + RLS
                  Worker writes via service role key
```

For v1, only the Vercel + Supabase legs exist. The pipeline is run offline against the IDB repo and exported as a one-shot CSV seed.

---

## Tech stack

- **Frontend:** Next.js 14 (App Router), TypeScript, Tailwind, MapLibre GL JS
- **Backend:** Vercel API routes, Supabase Postgres
- **LLM (chat):** Gemini 2.5 Flash (free tier) ? Claude Haiku 4.5 fallback
- **LLM (agents, v3+):** Claude Haiku 4.5
- **Worker (v2+):** Railway, Python (subprocess invokes the IDB pipeline)
- **MCP servers:** Supabase, Playwright (v3+), Figma (v4), Railway (v2+)
- **Multi-model workflow:** Claude Code primary; Codex for second-pass review on the SQL validator

---

## Local development

```bash
# v1 will live at apps/web
cd apps/web
pnpm install
pnpm dev
```

Env vars needed (`apps/web/.env.local`):

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
GEMINI_API_KEY=             # server-only
ANTHROPIC_API_KEY=          # server-only fallback
```

---

## Project documents

- [`PROJECT_PROPOSAL.md`](./PROJECT_PROPOSAL.md) — original proposal submitted Week 5
- [`Feedback_1.md`](./Feedback_1.md) — TA feedback on the proposal
- [`DELIVERABLES_PLAN.md`](./DELIVERABLES_PLAN.md) — v1–v4 plan
- [`V1_CHECKLIST.md`](./V1_CHECKLIST.md) — concrete v1 execution checklist
- [`CLAUDE.md`](./CLAUDE.md) — context file for Claude Code
- [`AGENTS.md`](./AGENTS.md) — open-standard context file for Codex / other agents

---

## License

MIT. Data sources retain their original licenses (WorldPop, OSM, MAP, IDB Poverty Maps, Meta RWI, OCHA boundaries).
