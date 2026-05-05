# EduAccess LAC — Robustness Auditor Worker

Long-running worker that scores every Panama district × age_group × transport_mode
cell on four robustness dimensions and writes the results to Supabase.

## What it produces

Three tables (created by `data/seed/panama/v2_worker_schema.sql`):

- **`audit_runs`** — one row per worker run. Tracks lifecycle (`running` →
  `done` / `failed`) and cell counts.
- **`robustness_reports`** — one row per (district × age_group × transport_mode).
  Four numeric scores + LLM-written narrative + caveats. Frontend reads from this
  table when a district is selected.
- **`priority_scores`** — derived ranking of "where to invest next" per cell,
  combining children underserved × access gap × robustness. Frontend reads this
  for the Insight tab top-priority list.

## Local dev

```bash
# from repo root
cd apps/worker
cp .env.example .env       # then fill in keys
pnpm install

# smoke test: 5 cells, no LLM, no writes
AUDIT_CELL_LIMIT=5 AUDIT_DRY_RUN=true pnpm start

# smoke test: 5 cells with LLM + writes
AUDIT_CELL_LIMIT=5 pnpm start

# full run (~664 cells, ~10-15 minutes)
pnpm start
```

Env vars (see `.env.example`):
- `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`)
- `SUPABASE_SERVICE_ROLE_KEY`
- `GROQ_API_KEY`
- `GROQ_MODEL` (optional, defaults to `llama-3.3-70b-versatile`)
- `AUDIT_CONCURRENCY` (optional, default `4`)
- `AUDIT_CELL_LIMIT` (optional, smoke testing)
- `AUDIT_DRY_RUN` (optional, skip LLM + writes)
- `AUDIT_TRIGGER_SOURCE` (optional, `'cron'` | `'manual'`)

## Railway deploy

This package is a Node service that runs once per invocation and exits. Deploy
it as a Railway **cron job** (or "service with cron") so Railway runs it on a
schedule.

1. **New service from this monorepo**
   - Connect your GitHub repo to Railway
   - Set "Root Directory" to `apps/worker`
   - Build: Nixpacks auto-detects Node; no Dockerfile needed
   - Start command: `pnpm start`

2. **Set env vars** in the Railway service "Variables" tab (the same ones
   listed above; do NOT include the prefix `NEXT_PUBLIC_`)

3. **Configure cron** — Railway → service → Settings → Cron Schedule:
   ```
   0 3 * * *
   ```
   That runs daily at 03:00 UTC. Adjust as needed.

4. **First run** — trigger manually from the Railway dashboard ("Deploy" or
   "Run Now"), then watch the logs for `[audit] done in Ns` and the
   `audit_run id=<uuid>` line.

## How it works

```
                                 ┌─────────────────┐
                                 │  Supabase DB    │
                                 │                 │
                                 │ panama_district_│  read
                                 │   indicators    │ ◄────┐
                                 │                 │      │
                                 │ audit_runs      │ ◄────┤
                                 │ robustness_     │      │
                                 │   reports       │ ◄────┤  upsert
                                 │ priority_scores │      │
                                 └─────────────────┘      │
                                                          │
                                 ┌─────────────────┐      │
                                 │  Worker (this)  │ ─────┘
                                 │                 │
                                 │ scores.ts       │  pure SQL → 4 dims
                                 │ auditor-agent.ts│  Groq → narrative
                                 │ priority.ts     │  pure SQL → priority
                                 │ audit.ts        │  orchestration
                                 └─────────────────┘
```

The four robustness dimensions:

| Dimension | What it measures | Source |
|---|---|---|
| `data_completeness` | `(pop_total - pop_nodata) / pop_total` | direct from indicators |
| `sample_size` | `log10(pop_total + 1) * 25`, capped 0-100 | direct |
| `friction_agreement` | `100 - abs(pct_le30(MAP) - pct_le30(OSM))` | join across friction sources |
| `pop_agreement` | `100 - abs(pct_le30(WorldPop) - pct_le30(Census))` | join across pop sources |

Composite is a weighted average (`scores.ts: WEIGHTS`); the LLM may shift it
±10 based on context but typically returns the composite as-is.

## Concurrency + rate limiting

- Default concurrency: **4 in-flight LLM calls** at once. Stays well under
  Groq's free-tier requests-per-minute and avoids 429s.
- A full 664-cell audit at concurrency 4 takes ~10-12 minutes and consumes
  ~80K Groq tokens (well under the daily 100K free-tier cap, but tight —
  consider running on `llama-3.1-8b-instant` for higher TPD).

## Cost shape

Free tier today:
- Supabase: free for the data sizes we're using
- Groq: free, with 100K TPD on the 70B model. One full audit ≈ 80K tokens.
- Railway: $5/month free credit; this worker's cron pattern uses pennies of
  it.

## What this worker does NOT do

- It does not run the IDB Phase B pipeline (zonal stats, friction, FMM).
  Those pre-computed indicators live in the IDB repo and were imported into
  Supabase as `panama_district_indicators` during v1.
- It does not enforce auth or rate limit user requests — it only writes
  computed reports for the frontend to read. The frontend's anon key has
  RLS read-only access to these tables.
