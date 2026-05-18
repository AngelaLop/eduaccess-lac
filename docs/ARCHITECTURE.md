# Architecture — EduAccess LAC

> How the app fits together: a Next.js frontend, a constrained AI chat, a Supabase
> database, and a Railway cron worker. This is the v3 picture (Panama-only).

## System overview

```mermaid
graph TD
    User([Minister / classmate])

    subgraph Vercel["Vercel — apps/web (Next.js 16)"]
        Landing[Landing page<br/>hero + seeded prompts]
        Shell[AppShell<br/>client state hub]
        Map[PanamaMap<br/>MapLibre choropleth]
        Panel[IndicatorPanel +<br/>RobustnessCard]
        Ask["/api/ask route<br/>LLM router + SQL executor"]
    end

    subgraph Railway["Railway — apps/worker (cron)"]
        Audit[audit.ts<br/>orchestrator]
        Scores[scores.ts<br/>4 numeric scorers]
        Explain[explainer.ts<br/>deterministic narrative]
        Priority[priority.ts<br/>investment ranking]
        Brief[country-brief.ts<br/>1 LLM call / refresh]
    end

    subgraph Supabase["Supabase (Postgres + RLS)"]
        Indic[(panama_district_indicators<br/>+ geometries)]
        View[[v_panama_indicators<br/>LLM-visible view]]
        Robust[(robustness_reports)]
        Prio[(priority_scores)]
        Cbrief[(country_audit_briefs)]
        RPC{{run_sql function}}
    end

    Groq[[Groq LLM<br/>llama-3.3-70b-versatile]]

    User --> Landing --> Shell
    Shell <--> Map
    Shell <--> Panel
    Shell -- question --> Ask

    Ask -- classify + write SQL --> Groq
    Ask -- validated SQL --> RPC
    RPC --> View
    View --> Indic

    Panel -- read --> Robust
    Panel -- read --> Cbrief
    Map -- read geometries --> Indic

    Audit --> Scores --> Explain
    Audit --> Priority
    Audit --> Brief
    Brief -- 1 call --> Groq
    Audit -- read scenarios --> Indic
    Explain -- upsert --> Robust
    Priority -- upsert --> Prio
    Brief -- insert --> Cbrief
```

The frontend uses the **anon key** (read-only, RLS-enforced). Only `/api/ask` and the
worker hold the **service-role key** — never shipped to the browser.

## The chat request flow (`/api/ask`)

A user question becomes a map highlight without the LLM ever touching raw tables or
running arbitrary SQL.

```mermaid
sequenceDiagram
    participant U as Browser (AppShell)
    participant A as /api/ask route
    participant L as Groq LLM
    participant V as sql-validator.ts
    participant S as Supabase (run_sql)

    U->>A: POST { question }
    A->>A: Rate limit (30 / 15min per IP)
    A->>A: Response cache lookup
    alt cache hit
        A-->>U: cached AskResponse
    else cache miss
        A->>L: classify → data | navigation | out_of_scope
        L-->>A: { kind, sql?, narrative }
        opt kind == data
            A->>V: validate SQL
            alt invalid
                A->>L: retry with failure reason
                L-->>A: corrected SQL
                A->>V: re-validate
            end
            A->>S: run_sql(validated SELECT)
            S-->>A: rows as JSON
        end
        A-->>U: AskResponse (rows + highlightCodDist + narrative)
    end
    U->>U: highlight polygons, append chat message
```

**SQL validator gates** (`apps/web/lib/sql-validator.ts`): no semicolons, must start
with `SELECT`, references only `v_panama_indicators`, `LIMIT ≤ 50` (or a single-row
aggregate), no `pg_*` / `information_schema` / DDL / DML, and only allowlisted
functions. The view itself pins one canonical scenario (WorldPop + MAP + walking).

## The worker audit flow (Railway cron)

Each run rebuilds the robustness layer for all 664 cells (83 districts × 4 age groups
× 2 transport modes).

```mermaid
graph LR
    Start([Cron trigger]) --> Open[Open audit_runs row]
    Open --> Load[Load 32 scenarios<br/>~2,656 rows]
    Load --> Bundle[Group into 664 cells<br/>canonical + comparison variants]
    Bundle --> Loop{For each cell}
    Loop --> Sc[computeScores<br/>completeness, sample,<br/>friction, pop agreement]
    Sc --> Ex[explainCell<br/>headline + 1-3 caveats<br/>NO LLM]
    Ex --> Buf[Buffer row]
    Buf -->|every 100| Up[(upsert robustness_reports)]
    Loop -->|done| Pr[computeAndWritePriorities]
    Pr --> Prw[(upsert priority_scores)]
    Prw --> Cb[writeCountryAuditBrief<br/>1 LLM call → 120-word brief]
    Cb --> Cbw[(insert country_audit_briefs)]
    Cbw --> Close([Close run: done / failed])
```

The per-cell explainer is **deterministic** — same scores always produce the same
sentence, zero tokens, zero retries. The only LLM call in the worker is the single
country audit brief per refresh.

## Robustness scoring

Every number on screen answers "how much do we trust this?" via four scores combined
into a composite:

| Dimension | Meaning | Weight |
|---|---|---|
| `data_completeness` | % of population with usable travel-time data | 0.30 |
| `sample_size` | population magnitude — small N swings wildly | 0.20 |
| `friction_agreement` | do MAP and OSM friction surfaces agree? | 0.30 |
| `pop_agreement` | do WorldPop and Census populations agree? | 0.20 |

The weakest dimension drives which caveats the explainer emits.

## Data flow end to end

```mermaid
graph TD
    IDB[IDB Accessibility Platform<br/>pre-computed travel times] --> Seed[data/seed/panama<br/>parquet + GeoJSON]
    Seed --> Indic[(panama_district_indicators<br/>32 scenarios)]
    Seed --> Geo[(panama_district_geometries)]
    Indic --> View[[v_panama_indicators]]
    Indic --> Worker[Worker audit]
    Worker --> Robust[(robustness_reports)]
    Worker --> Brief[(country_audit_briefs)]
    View --> Chat[Chat answer]
    Geo --> MapColor[Map choropleth]
    Robust --> Card[Robustness card]
    Chat --> Screen([What the user sees])
    MapColor --> Screen
    Card --> Screen
    Brief --> Screen
```

## Components & responsibilities

| Layer | File | Role |
|---|---|---|
| Frontend | `apps/web/app/page.tsx` | Landing page — hero + seeded prompts |
| Frontend | `apps/web/.../AppShell.tsx` | Client state hub: indicators, chat, selection |
| Frontend | `apps/web/.../PanamaMap.tsx` | MapLibre choropleth + polygon highlight |
| Frontend | `apps/web/.../RobustnessCard.tsx` | 4-dimension trust scores + narrative |
| API | `apps/web/app/api/ask/route.ts` | LLM router, SQL validation, query execution |
| API | `apps/web/lib/sql-validator.ts` | Whitelist validator for LLM-generated SQL |
| API | `apps/web/lib/rate-limit.ts` | Per-IP sliding-window throttle |
| Worker | `apps/worker/src/audit.ts` | Run orchestration + batch writes |
| Worker | `apps/worker/src/scores.ts` | Four deterministic numeric scorers |
| Worker | `apps/worker/src/explainer.ts` | Rule-based narrative + caveats |
| Worker | `apps/worker/src/priority.ts` | Investment-priority ranking |
| Worker | `apps/worker/src/country-brief.ts` | Single LLM call → country audit brief |
| Data | `data/seed/panama/*.sql` | Schema, views, RLS, `run_sql` function |

## Deployment

- **Vercel** hosts `apps/web` — push to GitHub triggers `next build`.
- **Railway** runs `apps/worker` on a cron schedule (Nixpacks build,
  `restartPolicyType = NEVER` so it exits cleanly after each audit).
- **Supabase** is the shared Postgres database; the service-role key lives only on
  Vercel server functions and Railway, never in the browser bundle.
