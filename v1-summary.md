# EduAccess LAC — v1 Summary

**Built:** 2026-04-28 | **Live:** https://eduaccess-lac.vercel.app | **Course:** Design, Build, Ship (MPCS 51238)

## What we built

EduAccess LAC v1 is a deployed, public geo-platform that lets a non-technical user open a URL, see Panama colored by school accessibility, toggle between walking and motorized access, tap a district, and ask the AI assistant a plain-English question — all in under 30 seconds.

## Architecture

```
[Browser]
  Landing page (/) + Platform (/platform)
  MapLibre choropleth + side panel (transport/level toggles, legend, chat)
         ↓
[Vercel API route /api/ask]
  Groq Llama-3.3-70B (text→SQL, json_object mode)
  sql-validator.ts (7 named checks: allowlist + blacklist + structural)
  run_sql() Postgres function (SECURITY DEFINER, service_role only)
         ↓
[Supabase Postgres]
  panama_district_indicators (2,656 rows, 32 scenarios: 2 pop × 2 friction × 2 mode × 4 age)
  panama_district_geometries (83 districts, 471 KB simplified GeoJSON)
  v_panama_indicators view (WorldPop + MAP + walking — LLM-visible only)
  RLS: anon key read-only on tables; service role only for run_sql
```

**Multi-model workflow:** Claude Code (primary driver, application code + UI + schema) + Codex (second-pass security review on `sql-validator.ts` and `/api/ask/route.ts`).

## What works in v1

- **Panama choropleth** colored by % of students within 30 min walk, for the selected education level
- **Transport mode toggle**: Walking (MAP friction surface, Weiss et al. 2020) and Motorized (OSM road network) — each using its physically correct friction layer
- **Education level toggle**: All / Primary / Secondary / High school — map and panel update together
- **Grey districts** for areas with no travel-time data (visually distinct, explained in legend)
- **Click any district** → indicator panel with hero metric, secondary stats grid, age-group tab bar
- **Robustness card** on every district: data completeness %, population source, friction surface, travel-time methodology — answers "how much can we trust this?"
- **AI chat**: 5 seeded prompts → validated SQL → results table + map highlights (gold borders)
- **Collapsible "Show SQL"** on every chat answer (transparency)
- **Landing page** with typing carousel; platform lives at `/platform`
- **All controls always visible** in sticky header (never scroll away during district detail)

## SQL security model

The SQL validator (`lib/sql-validator.ts`) enforces 7 independent checks before any query reaches Postgres:

| Check | What it guards |
|---|---|
| `checkNoSemicolon` | Multi-statement injection |
| `checkStartsWithSelect` | DDL/DML at query start |
| `checkAllowedView` | Double-quoted identifiers, no-FROM queries, comma joins, any relation other than the allowed view |
| `checkHasLimit` | Top-level LIMIT ≤ 50 (ignores subquery LIMITs) |
| `checkNoDangerousFunctions` | Blacklist: pg_*, dblink, lo_*, set_config, current_setting, DDL/DML/DCL keywords |
| `checkFunctionAllowlist` | Every function call must be in an approved set (COUNT, SUM, AVG, ROUND, etc.) |
| String-literal-aware `stripComments` | Comment-injection that hides malicious SQL |

The LLM gets two attempts; the second receives the validation error as feedback. The Postgres `run_sql` function is SECURITY DEFINER and callable only by the service_role key, which never reaches the browser.

## Known limitations

- Panama only; Honduras and other countries require v2 (Railway pipeline worker)
- Robustness card is static text; a scored Robustness Auditor agent ships in v3
- No school-count or poverty-rate indicators (not in district-level source tables; v2)
- AI chat answers questions about the canonical walking scenario only (the `v_panama_indicators` view); transport-mode-specific chat queries come in v2
- Map geometry simplified to 3% tolerance (471 KB); island districts may show slightly imprecise borders
