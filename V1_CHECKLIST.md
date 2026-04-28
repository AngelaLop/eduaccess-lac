# V1 Execution Checklist � Due Tomorrow

> Goal: deployed Vercel URL where a classmate can click a Panamanian municipality and ask the bot one of five seeded questions, and get an answer pinned to the map. Panama only. ~7.5 hours of work.

---

## 0 � Setup (30 min)

- [ ] **Repo init.** Decide path: keep at `c:\Users\lopez\github\Final_project` *or* rename to `eduaccess-lac`. Run `git init`, add a sensible `.gitignore` (Node + Next.js + `.env.local`).
- [ ] Create new GitHub repo (public). Push initial commit with the proposal + plan.
- [ ] Create new **Supabase project** (free tier, region `us-east-2` for Vercel proximity).
- [ ] Create new **Vercel project**, link to GitHub repo, set root to `apps/web`.
- [ ] Connect Supabase MCP to Claude Code (`claude mcp add --transport http supabase https://mcp.supabase.com/mcp`).
- [ ] Drop a `CLAUDE.md` and an `AGENTS.md` at the repo root with project description + tech stack + "v1 scope = Panama only".

---

## 1 � Panama indicators export (60 min)

**Source data is already in great shape.** All Panama pilot indicators live as 32 long-format CSVs at:
`c:\Users\lopez\github\IDB\accessibility_platform\data\PAN_pilot\results\district_tables\`

Every CSV shares this schema:
`cod_dist, nomb_dist, nomb_prov, sid, label, pop_source, friction, age_group, pop_total, pop_le15, pop_le30, pop_le60, pop_gt60, pop_nodata, pct_le15, pct_le30, pct_le60`

The 32 files cover the full cross-product of:
- `pop_source`: `census` | `worldpop`
- friction surface: `MAP` (default) | `OSM` (`osm` token in filename)
- `friction` (transport mode): `motorized` | `walking`
- `age_group`: `all` | `primary` | `secondary` | `highschool`

Strategy: load **all 32 into one long table** and let a Postgres view filter to the canonical scenario for v1. Other scenarios stay in the table, hidden from the LLM, ready for v3 (Friction Sensitivity agent) without re-importing.

**Canonical scenario for v1:** `pop_source='worldpop'` (scales to all 21 countries) + `friction_source='map'` (Weiss et al. 2020, globally validated). Walking is the more demanding indicator, used as the default map color.

- [ ] Write a one-shot ingest script `data/seed/panama/load_indicators.py` that:
  1. Globs all 32 CSVs in `district_tables/`.
  2. Concatenates them and adds a `friction_source` column derived from the filename (`'osm'` if filename contains `_osm_`, else `'map'`).
  3. Writes a single `panama_district_indicators.parquet` (or pushes directly to Supabase via MCP).
- [ ] **Panama district polygons** are at `c:\Users\lopez\github\IDB\accessibility_platform\data\OSM\gis_osm\panama_districts.geojson` (5.46 MB, confirmed). Properties include `cod_dist`, `nomb_dist`, `nomb_prov` � joins cleanly with the indicator table on `cod_dist`. Drop the noisy properties (`cod_obj`, `ley`, `ley_modi`, `gace`, `gace_modi`, `uso`, `Shape_Leng`, `Shape_Area`) when copying.
- [ ] Simplify and shrink: `pnpm dlx mapshaper@latest "c:\Users\lopez\github\IDB\accessibility_platform\data\OSM\gis_osm\panama_districts.geojson" -filter-fields cod_dist,nomb_dist,nomb_prov -simplify 10% keep-shapes -o "data/seed/panama/panama_districts.simplified.geojson" force`. Target < 500 KB output.
- [ ] Push `panama_district_indicators` (Parquet ? Supabase) and `panama_districts.geojson` (load as GeoJSON into a JSONB column) into Supabase using the Supabase MCP.

**v1 OMISSIONS (deliberate, do not chase tomorrow):**
- `n_schools` / `n_public` / `n_private` � not in `district_tables`. Drop from v1; add in v2.
- `poverty_rate` / `rwi_mean` � not in `district_tables`. Drop from v1; add in v2.
- `geocoder_score_median` and other geocoding QA � drop from v1. Use `pop_nodata / pop_total` as v1 robustness proxy instead.

### SQL to run in Supabase (paste into the SQL editor)

```sql
-- All 32 scenarios for Panama districts. ~2,500 rows total.
create table panama_district_indicators (
  cod_dist text not null,                    -- Panama district code, 4-char zero-padded
  nomb_dist text,                            -- District name
  nomb_prov text,                            -- Province name
  sid text not null,                         -- Scenario id (A1..D12)
  label text,                                -- Human-readable scenario label
  pop_source text not null check (pop_source in ('census','worldpop')),
  friction_source text not null check (friction_source in ('map','osm')),
  friction text not null check (friction in ('motorized','walking')),     -- transport mode
  age_group text not null check (age_group in ('all','primary','secondary','highschool')),
  pop_total int,
  pop_le15 int,
  pop_le30 int,
  pop_le60 int,
  pop_gt60 int,
  pop_nodata int,
  pct_le15 numeric,
  pct_le30 numeric,
  pct_le60 numeric,
  primary key (cod_dist, sid)
);

create table panama_district_geometries (
  cod_dist text primary key,
  nomb_dist text,
  nomb_prov text,
  geometry jsonb not null
);

-- The view the LLM is allowed to see. v1 default scenario: WorldPop + MAP + walking.
-- The other 31 scenarios stay in the underlying table, hidden, for v3 Friction Sensitivity.
create view v_panama_indicators as
select
  i.cod_dist,
  i.nomb_dist,
  i.nomb_prov,
  i.age_group,
  i.pop_total,
  i.pop_le15,
  i.pop_le30,
  i.pop_le60,
  i.pop_nodata,
  i.pct_le15,
  i.pct_le30,
  i.pct_le60,
  case when i.pop_total > 0
       then round(100.0 * (i.pop_total - i.pop_nodata) / i.pop_total, 1)
       else 0 end as data_completeness_pct
from panama_district_indicators i
where i.pop_source = 'worldpop'
  and i.friction_source = 'map'
  and i.friction = 'walking';

-- RLS: the anon key can read these tables and the view, nothing else.
alter table panama_district_indicators enable row level security;
alter table panama_district_geometries enable row level security;
create policy "public read" on panama_district_indicators for select using (true);
create policy "public read" on panama_district_geometries for select using (true);
```

### Column glossary for the LLM prompt (paste into /api/ask system prompt)

```
v_panama_indicators: one row per Panama district x age_group, for the canonical
v1 scenario (WorldPop population + MAP friction surface + walking transport mode).

cod_dist            Panama district code (4-char zero-padded string), join key
nomb_dist           District name
nomb_prov           Province name
age_group           One of: 'all' (all school-age), 'primary' (6-11),
                            'secondary' (12-14), 'highschool' (15-17)
pop_total           Population in this age group
pop_le15            Population within 15 minutes walking of nearest school
pop_le30            Population within 30 minutes walking
pop_le60            Population within 60 minutes walking
pop_nodata          Population with no travel-time data (outside friction surface)
pct_le15            % within 15 minutes walking (0-100)
pct_le30            % within 30 minutes walking (0-100)
pct_le60            % within 60 minutes walking (0-100)
data_completeness_pct   % of population with usable travel-time data, 0-100
```

---

## 2 � Next.js skeleton + map (90 min)

- [ ] `pnpm dlx create-next-app@latest apps/web --typescript --tailwind --app --no-src-dir`
- [ ] Install: `pnpm add maplibre-gl @supabase/supabase-js openai zod` (the `openai` SDK is used to call Groq's OpenAI-compatible endpoint). Add `pnpm-workspace.yaml` at the root for the monorepo.
- [ ] Env vars (`apps/web/.env.local`):
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `GROQ_API_KEY` (server-only)
  - `GROQ_MODEL=llama-3.3-70b-versatile`
- [ ] `app/page.tsx`: full-bleed map (left 65%) + side panel (right 35%) on desktop; stacked on mobile.
- [ ] Map component:
  - Center on Panama (~`[-80.0, 8.5]`, zoom 6.5).
  - Load `panama_districts.simplified.geojson` from Supabase or shipped as a static asset under `public/` (faster on first paint).
  - Choropleth fill expression on `pct_le30` filtered to `age_group='highschool'`. Use a 5-step ramp: green -> yellow -> orange -> red -> darkred. Don't pick a rainbow (Week 5 principle 4).
  - Click handler -> set selected `cod_dist` -> fetch indicator rows for that district (one per age_group) -> render panel.
- [ ] Panel layout:
  - Title: `nomb_dist`, `nomb_prov`
  - Age-group toggle: All / Primary / Secondary / High school (defaults to High school - it's the most varied)
  - Hero metric: "X% of [age group] within 30 min walk of a school"
  - Secondary grid: `pct_le15`, `pct_le60`, `pop_total`, `pop_le30`
  - Robustness card at the bottom (see below)
- [ ] Default seeded answer rendered on first load: pre-compute the answer to "Top 5 districts with worst high-school walking access" client-side, highlight those polygons with a gold border, show the list in the panel.

### Robustness card (the v1 answer to Shubham)

```tsx
// Inline in the panel. v1 uses pop_nodata as the completeness proxy and
// transparently links to the methodology paper.
<section className="mt-6 rounded-md border border-neutral-200 p-4 text-sm">
  <h3 className="font-semibold">How much can we trust this?</h3>
  <ul className="mt-2 space-y-1 text-neutral-700">
    <li>Data completeness: <strong>{data_completeness_pct}%</strong>
        <span className="text-xs text-neutral-500"> ({pop_nodata.toLocaleString()} of {pop_total.toLocaleString()} people lack travel-time data)</span></li>
    <li>Population source: <strong>WorldPop 2023</strong> (1 km raster, age-binned)</li>
    <li>Friction surface: <strong>MAP (Weiss et al. 2020)</strong> - globally validated</li>
    <li>Travel-time model: Fast Marching Method on 1 km grid</li>
  </ul>
  <p className="mt-2 text-xs text-neutral-500">
    Source: IDB Accessibility Platform, Panama pilot (3,617 schools, MPCS thesis 2026).
    A full Robustness Auditor agent that scores every indicator on five
    dimensions ships in v3.
  </p>
</section>
```

---

## 3 � Chat ? text-to-SQL (90 min)

- [ ] `app/api/ask/route.ts` - POST `{ question: string }` -> returns `{ sql, columns, rows, highlightCodDist: string[], narrative }`.
- [ ] Set up a Groq client using the OpenAI SDK pointed at Groq's endpoint:
  ```ts
  import OpenAI from "openai";
  const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  });
  // Then: groq.chat.completions.create({ model: process.env.GROQ_MODEL, ... })
  ```
- [ ] Build a **schema prompt** that contains:
  - The `v_panama_indicators` view definition with one-line comments per column (paste the column glossary from section 1).
  - 3-5 worked examples (question -> SQL).
  - Hard rules: "only SELECT, only `v_panama_indicators`, must include `LIMIT`, must return `cod_dist` for map highlights, no DDL/DML/`;`/`pg_*`."
  - Use `response_format: { type: "json_object" }` so Llama returns `{ "sql": "...", "narrative": "..." }` not freeform text.
- [ ] **SQL validator** (`apps/web/lib/sql-validator.ts`) before executing:
  - Must start with `SELECT` (case-insensitive, after trimming whitespace and comments).
  - Must reference `v_panama_indicators`. No other table or view name allowed.
  - Must contain `LIMIT` with N <= 50.
  - No `;` (prevents stacked statements).
  - No `pg_*` functions, no `information_schema`, no `\copy`, no `--` comments that hide payload.
  - Run `EXPLAIN <sql>` against Supabase first; if it errors, return the error to the user.
  - **This file is what Codex will second-pass review.** Write it with clear named checks and unit-testable functions.
- [ ] If Llama returns invalid SQL twice in a row, surface the error to the user and stop (no third retry, no silent failure).
- [ ] Frontend: chat input below the panel. Show: the question -> the generated SQL (collapsed by default, "Show SQL" toggle) -> the result rows -> a sentence narrative. The map auto-highlights the rows' `cod_dist` set in gold.
- [ ] **Five seeded prompts** as buttons above the input (Week 5 principle 27, first-run guidance):
  1. "Top 5 districts with the worst walking access for high schoolers"
  2. "Which districts have over 1,000 high schoolers more than 30 minutes from a school?"
  3. "Show districts where over 20% of school-age population lacks travel-time data"
  4. "Compare primary vs high school walking access in the districts of Panama province"
  5. "Rank provinces by their average % of population within 15 minutes of a school"

---

## 4 � Polish + deploy (60 min)

- [ ] Title bar: "EduAccess LAC � Panama (preview)". Subtle, single accent color.
- [ ] Empty/loading/error states for the chat (Week 5 principle 11). Skeleton on the map while geometries load.
- [ ] Footer: "Data source: IDB Accessibility Platform � v1 preview � last updated <date>" + a link to the IDB repo.
- [ ] WCAG AA pass: 4.5:1 minimum on all body text. Run axe in browser devtools.
- [ ] Push to GitHub. Watch Vercel auto-deploy. Add the deployed URL to `README.md`.
- [ ] Smoke test the deployed URL on mobile (375px) and desktop. Click 3 municipalities, ask 2 questions, verify highlights on map.

---

## 5 � Submission package (30 min)

- [ ] `README.md` at repo root with: one-line description, screenshot, deployed URL, "what works in v1 / what's coming in v2", how to run locally.
- [ ] `v1-summary.md`: ask Claude Code at the end of the session: *"Write a 200-word summary of what we built today, the architecture, and known limitations."* Commit it.
- [ ] 30-second screen recording (Loom or QuickTime). Show: load ? click a red municipality ? ask a seeded question ? answer + map highlight. No voiceover needed.
- [ ] Two screenshots: default landing view, chat answer view.
- [ ] Submit to Google Classroom: GitHub URL + Vercel URL + summary + screenshots + recording.

---

## 6 � Nice-to-haves only if time remains

- [ ] Hover tooltip on map polygons (just adm2 name + the hero metric).
- [ ] A "Why this color?" link in the legend that opens a tiny modal explaining the choropleth scale.
- [ ] Keyboard shortcut `/` to focus the chat input (Week 5 principle 24).

---

## Cuts I will make if I'm running over

1. Drop the chat narrative sentence � just show the table.
2. Drop the secondary motorized indicators � keep walking only.
3. Drop the gold-border highlight animation � just change the polygon fill.
4. Drop the 5th seeded prompt.
5. Skip the screen recording � submit screenshots only.

The deploy is non-negotiable. Everything else is.
