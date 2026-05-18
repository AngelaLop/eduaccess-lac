# EduAccess LAC — Robustness Auditor Worker

Worker that scores every district × education_level × transport_mode cell of
each country on three robustness dimensions and writes the results to Supabase.
v4: multi-country (Panama + Colombia, more as their data lands).

## What it produces

Tables created by `data/seed/v2_worker_schema.sql`, `v3_robustness_schema.sql`,
and `v4_multicountry_schema.sql`:

- **`audit_runs`** — one row per worker run per country. Lifecycle
  (`running` → `done` / `failed`) + cell counts.
- **`robustness_reports`** — one row per (country × district × education_level
  × transport_mode). Three numeric scores + a deterministic narrative +
  caveats + versioning columns. The frontend RobustnessCard reads this.
- **`priority_scores`** — derived "where to invest next" ranking per cell.
- **`country_audit_briefs`** — one LLM-written paragraph per country per run.

## How it works

The worker reads cells from the curated view `v_indicators_adm2`. Each cell is
scored by **pure deterministic functions** (`scores.ts`) and explained by a
**rule-based template** (`explainer.ts`) — no per-cell LLM call. The only LLM
call is one country audit brief per country per run (`country-brief.ts`).

```
v_indicators_adm2 ──► scores.ts ──► explainer.ts ──► robustness_reports
                          │                      ──► priority.ts ──► priority_scores
                          └──────────────────────► country-brief.ts ─► country_audit_briefs
                                                       (1 LLM call/country)
```

### The three robustness dimensions

| Dimension | What it measures |
|---|---|
| `data_completeness` | the FMM accessibility value is present and population is positive |
| `sample_size` | `log10(pop_total + 1) * 25`, capped 0-100 |
| `method_agreement` | `100 - abs(pct_le30(FMM) - pct_le30(OSRM))` — two independent routing engines |

Composite is a weighted average (`scores.ts: WEIGHTS` — completeness 0.35,
sample 0.25, method 0.40). `data_completeness` saturates near 100 for normal
cells in the unified dataset; the discriminating signal is sample size + method
agreement (see the comment in `scores.ts`).

## Local dev

```bash
cd apps/worker
cp .env.example .env       # then fill in keys
pnpm install

# smoke test: 20 cells/country, no LLM, no writes
AUDIT_CELL_LIMIT=20 AUDIT_DRY_RUN=true pnpm start

# one country only
AUDIT_COUNTRY=COL pnpm start

# full run (all countries in the data)
pnpm start
```

Env vars (see `.env.example`):
- `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`)
- `SUPABASE_SERVICE_ROLE_KEY`
- `GROQ_API_KEY`
- `GROQ_MODEL` (optional, defaults to `llama-3.3-70b-versatile`)
- `AUDIT_COUNTRY` (optional, limit the run to one `country_iso`)
- `AUDIT_CELL_LIMIT` (optional, smoke testing — N cells per country)
- `AUDIT_DRY_RUN` (optional, skip LLM + writes)
- `AUDIT_SKIP_BRIEF` (optional, skip the country brief)
- `AUDIT_TRIGGER_SOURCE` (optional, `'cron'` | `'manual'`)

## Railway deploy

A Node service that runs once per invocation and exits — deploy as a Railway
cron job. Root Directory `apps/worker`, Nixpacks build, start `pnpm start`.
Set the env vars above (no `NEXT_PUBLIC_` prefix). Trigger story is data- or
rubric-version change, not a daily cron.

## What this worker does NOT do

- It does not run the IDB Phase B pipeline (zonal stats, friction, FMM/OSRM
  routing). Those pre-computed indicators live in the IDB repo and are loaded
  into Supabase as `accessibility_indicators` by `data/seed/load_accessibility.py`.
- It does not enforce auth or rate-limit user requests — it only writes
  computed reports for the frontend to read via the anon key (RLS read-only).
