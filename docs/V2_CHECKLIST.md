# V2 Execution Checklist — Due Week 7

> Goal: ship v2 by iterating v1 with cohort feedback, using parallel agents in git worktrees as the technical theme. Panama only, no Railway. ~7.5 hours of work.
>
> Brief (`Design, Build, Ship - Week 6 - Project v2.pdf`): _"Iterate v1 with cohort feedback. Try parallelization. Take what you learned in Week 6 — parallel agents, git branches and worktrees, environments."_

---

## Cohort feedback being addressed

1. Confusing on first glance — user can't tell what the platform is.
2. The LLM bot doesn't handle out-of-scope questions; should guide users to its actual scope.
3. Right panel feels cramped — bot and rankings should live in different toggles.
4. Ranking of worst districts as a list is weak — try a bar graph.
5. Districts returned by a query should appear on the map _with the queried information_, not just a generic highlight.
6. Need hover tooltips on districts.
7. Should be able to navigate the platform from the LLM (set toggles, focus a district).

These collapse into three independent workstreams. Each runs in its own git worktree, on its own branch, with its own dev server.

---

## Streams at a glance

| Stream | Owns | Addresses | Branch | Worktree path | Hours |
|---|---|---|---|---|---|
| A — Framing & layout | Tabbed right panel, scope/help card, first-run hint | 1, 3 | `v2/stream-a-layout` | `..\Final_project-stream-a` | 1.5 |
| B — LLM as interface agent | `/api/ask` response shape, tool routing, scope guard, action dispatcher | 2, 7 | `v2/stream-b-agent` | `..\Final_project-stream-b` | 2.5 |
| C — Map & viz | Hover popups, rank-encoded highlights, bar chart for rankings | 4, 5, 6 | `v2/stream-c-viz` | `..\Final_project-stream-c` | 2.0 |
| Integration + deploy + summary | Merge order, smoke test, `v2-summary.md`, video | — | `main` | `Final_project` | 1.0 |
| Buffer | — | — | — | — | 0.5 |

Total: 7.5h.

---

## 0 — Setup (30 min)

### 0.1 — Lock the integration contract before forking (this is the load-bearing step)

All three streams touch `AppShell.tsx` and the chat round-trip. To avoid a merge fight at the end, decide the cross-stream contract _now_ and write it into a stub before creating worktrees. The contract is the new shape of the `/api/ask` JSON response:

```ts
// apps/web/lib/types.ts — add this type
export type AskAction =
  | { type: 'select_district'; cod_dist: string }
  | { type: 'set_transport_mode'; mode: TransportMode }
  | { type: 'set_education_level'; level: AgeGroup }
  | { type: 'focus_panel_tab'; tab: 'insight' | 'ask' };

export type AskResponseKind = 'data' | 'navigation' | 'out_of_scope';

export interface AskResponse {
  kind: AskResponseKind;
  // 'data' kind
  sql?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  highlightCodDist?: string[];
  // 'data' subkind: when the result is naturally ranked, the API tags it
  resultShape?: 'ranking' | 'filter' | 'comparison' | 'aggregate';
  // 'navigation' kind
  actions?: AskAction[];
  // all kinds
  narrative?: string;
  // 'out_of_scope' kind
  scopeHint?: string; // human-readable "here's what I CAN do"
}
```

- [ ] Commit this type stub on `main` first, push, so all three worktrees branch from a tree that already has it.
- [ ] **Stream B owns producing this shape** server-side.
- [ ] **Stream A** consumes `kind`, `narrative`, and `scopeHint` (renders out-of-scope guidance, switches tabs on `focus_panel_tab` actions).
- [ ] **Stream C** consumes `resultShape === 'ranking'` (renders bar chart) and `highlightCodDist` ordered by rank (encodes color/label).

### 0.2 — Worktree + branch creation (PowerShell)

```powershell
# from C:\Users\lopez\github\Final_project on main
git worktree add -b v2/stream-a-layout ..\Final_project-stream-a
git worktree add -b v2/stream-b-agent  ..\Final_project-stream-b
git worktree add -b v2/stream-c-viz    ..\Final_project-stream-c
git worktree list
```

- [ ] Confirm three worktrees exist and each starts from the same commit on `main`.
- [ ] In each worktree, install deps once: `pnpm install --frozen-lockfile`.
- [ ] Pick non-conflicting dev ports: A on 3001, B on 3002, C on 3003. Run `pnpm --filter web dev -p 300X` in each.
- [ ] Each worktree gets its own `.env.local` copy (Vercel envs work the same; Supabase free tier handles 3 concurrent dev clients fine).

### 0.3 — Spawn the agents

Open three Claude Code sessions, one per worktree. Hand each one the corresponding `Stream X` section of this file as the brief. They run in parallel — no inter-session coordination needed because the contract in 0.1 is the only shared surface.

---

## Stream A — Framing & layout (1.5h, worktree A)

**Goal:** A first-time visitor understands what this platform is and what they can do, in 5 seconds. The right panel stops fighting itself.

### A.1 — Tabbed right panel (45 min)

Today: header (controls + legend) → scrollable indicator content → chat fixed at bottom (max 45vh). The panel is too dense; chat and rankings compete.

Replace the lower half of `apps/web/app/components/AppShell.tsx` with a tab strip controlling which panel is visible:

- [ ] Add tab state: `const [panelTab, setPanelTab] = useState<'insight' | 'ask'>('insight');`
- [ ] Render a 2-button tab strip directly above the content area, using the same pill style as the transport/level toggles for visual consistency.
- [ ] **Insight tab**: shows `<IndicatorPanel ... />` only. Full vertical space available. The "Top 5 worst" list lives here when no district is selected.
- [ ] **Ask tab**: shows the chat (seeded prompts, message list, input form). Full vertical space.
- [ ] When the API returns an `AskAction` of type `focus_panel_tab`, switch tabs accordingly. (e.g., "show me San Miguelito" → action `select_district` + `focus_panel_tab: 'insight'`.)
- [ ] When a chat answer arrives, briefly badge the Ask tab if the user has switched away (small dot, no notification spam).

### A.2 — Scope & first-run hint (30 min)

The fix for "I don't know what this is" is the same fix for "the bot doesn't tell me what it can do" — show scope explicitly, in the right place, once.

- [ ] In the **Ask tab**, when `messages.length === 0`, render a `<ScopeCard />` above the seeded prompts:
  - One sentence: _"Ask about school walking and motorized access across Panama's 83 districts and 10 provinces, for 4 student age groups."_
  - Three bullets describing what kinds of questions work: ranking, filtering, comparing.
  - One muted line: _"Outside Panama or non-access questions: I'll tell you and suggest a related question I can answer."_ (Stream B will produce that response server-side; this UI just primes the user.)
- [ ] In the **Insight tab**, when no district is selected and there's no active chat highlight, render a one-line hint at the top: _"Click any district on the map, or ask a question."_
- [ ] On the landing page (`apps/web/app/page.tsx`), tighten the value prop. Current copy is good; add one more line beneath the H1: _"Click a district. Ask a question. See the data behind every recommendation."_ — concrete verbs, removes the ambiguity classmates flagged.

### A.3 — Out-of-scope render path (15 min)

Stream B will return `{ kind: 'out_of_scope', narrative, scopeHint }`. Stream A wires the UI:

- [ ] In `ChatBubble`, branch on `msg.kind === 'out_of_scope'`: render a softer style (neutral background, no SQL toggle, no table). Show `narrative` then `scopeHint` with example seeded prompts the user can click to retry.

### A.4 — Smoke test (locally on port 3001)

- [ ] Cold load → tab strip visible, Ask tab shows scope card, Insight tab shows top-5 hint.
- [ ] Click a district → tab does not auto-switch (let the user choose); `selectedDist` updates as before.
- [ ] Mobile viewport (375px) — tab strip stays usable, content underneath fills.

**Cuts if running over**: drop A.3 (Stream B's out-of-scope still renders as a regular error bubble — ugly but works); drop the Ask-tab dot badge.

---

## Stream B — LLM as interface agent (2.5h, worktree B)

**Goal:** Replace text-to-SQL-only with a router that picks one of three response modes (data / navigation / out_of_scope) and produces the `AskResponse` shape. The LLM stops being a SQL pipe and becomes the platform's interface.

### B.1 — Rewrite the system prompt as a router (60 min)

- [ ] In `apps/web/app/api/ask/route.ts`, replace the existing `SCHEMA_PROMPT` with a router prompt that asks the LLM to first classify the question, then produce the matching response:

  ```
  Classify the user's question into ONE of:
    1. "data"        → it can be answered by a SQL query on v_panama_indicators
    2. "navigation"  → it asks to focus a district, switch transport mode, or
                       switch education level, with no data to compute
    3. "out_of_scope"→ outside Panama districts, outside school-access topic,
                       or outside the columns available

  Respond as JSON with shape:
    { "kind": "...", "sql": "...", "narrative": "...",
      "actions": [...], "scopeHint": "...", "resultShape": "..." }
  Only the fields relevant to the chosen kind need values.
  ```

- [ ] Embed the column glossary (currently in the prompt) inside the `data` branch only.
- [ ] Add a `resultShape` instruction inside the `data` branch: _"If the question asks for a top-N or bottom-N or ranks something, set resultShape to 'ranking'. If it asks for districts matching a condition, 'filter'. If it compares two groups side-by-side, 'comparison'. If it returns one row of aggregates, 'aggregate'."_
- [ ] Add 3 worked examples for `navigation` (e.g., "show me San Miguelito" → `select_district` action; "switch to motorized" → `set_transport_mode` action).
- [ ] Add 3 worked examples for `out_of_scope` (e.g., "what about Honduras?" → scopeHint that names the seeded prompts available; "what about hospital access?" → same shape).

### B.2 — Branch the route handler (60 min)

- [ ] Refactor the route to dispatch on `kind`:
  - `data` → existing path (validate SQL via `validateSQL`, run `run_sql` rpc, return rows + `resultShape`).
  - `navigation` → skip SQL entirely. If the action references a district, validate `cod_dist` exists by hitting `panama_district_geometries` (cheap); reject silently if not. Return `actions` array.
  - `out_of_scope` → return as-is, no DB call.
- [ ] **`navigation` validation rules** (must add):
  - `cod_dist` must be 4 chars and present in the geometries table.
  - `mode` must be `'walking' | 'motorized'`.
  - `level` must be one of the four `AgeGroup` values.
  - Reject any unknown action `type` instead of forwarding it to the client.
- [ ] On out_of_scope, the `scopeHint` must be ≤ 280 chars and reference at least one of the seeded prompts. Trim/post-process server-side rather than trusting the LLM.

### B.3 — Resolve district names to codes (30 min)

When the user says "San Miguelito" the LLM doesn't know `cod_dist` codes. Two options:

- **Option 1 (cheap):** include a flat list of `(cod_dist, nomb_dist, nomb_prov)` triples in the navigation system prompt. ~83 rows × ~40 chars = ~3.5KB; well within a single Llama 3.3 prompt.
- **Option 2 (correct):** server-side fuzzy match after the LLM returns a name. More work; do later.

- [ ] Go with Option 1 for v2. Generate the triples at build time from Supabase or hard-code from the seed data, embedded once in the prompt.

### B.4 — Update the validator only if needed (15 min)

- [ ] `lib/sql-validator.ts` should still run only on `kind: 'data'`. No change required, but verify the route doesn't accidentally validate empty SQL on the other branches.

### B.5 — Smoke test (port 3002)

For each of these prompts, hit `/api/ask` (use the live UI in worktree B against its own API):

- [ ] "Top 5 districts with worst high-school walking access" → `kind: 'data'`, `resultShape: 'ranking'`, 5 rows.
- [ ] "Show me San Miguelito" → `kind: 'navigation'`, action `select_district` with the right `cod_dist`.
- [ ] "Switch to motorized" → `kind: 'navigation'`, action `set_transport_mode`.
- [ ] "What about Honduras?" → `kind: 'out_of_scope'`, scopeHint references Panama and at least one seeded prompt.
- [ ] "Compare primary vs high school in Panama province" → `kind: 'data'`, `resultShape: 'comparison'`.
- [ ] "What's 2 + 2?" → `kind: 'out_of_scope'`.

**Cuts if running over**: drop B.3 by also accepting the LLM's natural-language `district_name` and doing exact-match server-side (fewer prompts work, but the failure mode is a clean out_of_scope-style "I didn't recognize that district"); drop the comparison `resultShape` and let it fall through to a default table render.

---

## Stream C — Map & viz (2.0h, worktree C)

**Goal:** the map answers questions visually, not just by highlighting. Hover works. Ranking results show up as a bar chart.

### C.1 — Hover popup on districts (30 min)

- [ ] In `apps/web/app/components/PanamaMap.tsx`, attach a `mousemove` handler to `districts-fill`:
  - Read `cod_dist` from the hovered feature.
  - Look up the corresponding indicator row in `indicators[code][activeAgeGroup]`.
  - Show a `maplibregl.Popup` with: `nomb_dist`, `nomb_prov`, and `pct_le30` formatted as `XX% within 30 min walk`. If `data_completeness_pct === 0`, show "No travel-time data" instead.
- [ ] Single popup instance reused on `mousemove`; remove on `mouseleave`. No popup spam.
- [ ] Position: `closeButton: false`, `closeOnClick: false`, offset 8px above cursor.
- [ ] Throttle the lookup to once per ~50ms (`requestAnimationFrame` or a simple `lastUpdateAt` check) — MapLibre fires `mousemove` very fast.

### C.2 — Rank-encoded chat highlight (45 min)

Today: any `chatHighlights` set draws gold borders, identical for all districts in the array. Cohort feedback wants the **information** on the map.

- [ ] Stream B now sends `highlightCodDist` ordered by rank (#1 first). When `resultShape === 'ranking'`, change the highlight rendering:
  - Replace the single `districts-highlight` line layer's filter approach with a per-district paint expression.
  - Pass the ranking from `AppShell.tsx` to `PanamaMap` as a new prop `rankedHighlights: { cod_dist: string; rank: number }[] | null`.
  - In `mergedGeoJSON`, write `rank_in_result` (1–5) into each feature's properties for matching districts, `null` otherwise.
- [ ] Add a new symbol layer that renders the rank number as a label centered on the polygon, only where `rank_in_result` is set. Use `text-field: ['get', 'rank_in_result']`, white text on a small dark halo.
- [ ] Update the existing border highlight to encode rank by line color (5-step scale, #1 = darkest), not a single gold tone.
- [ ] When the user clicks any other district, clear `rankedHighlights` (same as the current `chatHighlights = []` clear).
- [ ] Keep the legacy gold-border path for `resultShape !== 'ranking'` so filter/comparison queries still highlight uniformly.

### C.3 — Bar chart for ranking results (30 min)

- [ ] Add `recharts` to `apps/web/package.json` (small, no peer dep issues with Next 14): `pnpm --filter web add recharts`.
- [ ] Create `apps/web/app/components/RankBarChart.tsx`:
  - Props: `{ rows: Record<string, unknown>[]; valueColumn: string; labelColumn: string }`.
  - Renders a horizontal `<BarChart>` with district names on the Y axis (sorted), the value on the X.
  - Bar color matches the same rank scale used on the map (so the chart and map agree visually).
  - Falls back to a table if `rows.length === 0` or `valueColumn` is missing.
- [ ] In `AppShell.tsx`'s `ChatBubble`, when `msg.resultShape === 'ranking'`:
  - Pick `valueColumn` from `msg.columns` by heuristic: prefer `pct_le30`, then `pct_le15`, then any column matching `/^pct_/`, then any numeric column that isn't `cod_dist`/`pop_*`.
  - Pick `labelColumn`: prefer `nomb_dist`, fall back to `nomb_prov` for province-level rankings.
  - Render the chart **above** the existing table (don't remove the table — it's the data source of truth).
- [ ] If heuristics fail, render the table only (no chart, no error).

### C.4 — Smoke test (port 3003)

- [ ] Hover any district → popup with name + access %.
- [ ] Hover a no-data district → popup says "No travel-time data".
- [ ] Run a top-5 ranking prompt → bar chart appears, polygons numbered 1–5 on the map, color scale matches between chart and map.
- [ ] Run a filter prompt (e.g., "districts where >20% lacks data") → table shows, polygons highlighted with the legacy single-color border (no numbers).
- [ ] Click a different district → ranked highlights clear, popup behavior continues working.

**Cuts if running over**: drop C.3 entirely (keep the table only) — the cohort asked for the chart, but the hover and ranked-map-encoding alone are a meaningful answer to feedback items 5 and 6; drop the rank labels on the polygons (encode by border color only).

---

## 1 — Integration (45 min)

Merge order matters. The shared file is `AppShell.tsx`; merging in this order minimizes conflicts.

- [ ] Merge **Stream A** first (`v2/stream-a-layout` → `main`). It rewrites the panel layout and tab state — biggest structural change.
- [ ] Merge **Stream B** second (`v2/stream-b-agent` → `main`). Touches `route.ts` and adds an action dispatcher in `AppShell.tsx`. Resolve the `ask()` function conflict by keeping A's tab-state setters and adding B's `actions.forEach(dispatch)` block.
- [ ] Merge **Stream C** third (`v2/stream-c-viz` → `main`). Touches `PanamaMap.tsx` (independent of A/B) and `ChatBubble` JSX (lives inside AppShell). Resolve by keeping A's tab structure and B's response-shape parsing, adding C's chart render.
- [ ] After each merge: `pnpm --filter web build` to catch type errors before the next merge.
- [ ] Single end-to-end smoke test on port 3000 (main worktree):
  - Cold load → landing page → click "Open platform" → Insight tab default → top-5 visible.
  - Switch to Ask tab → scope card visible → click a seeded prompt → Insight tab badge appears → switch back, see numbered polygons + bar chart.
  - Type "show me San Miguelito" → district selects, panel switches to Insight automatically.
  - Type "switch to motorized" → mode toggle flips.
  - Type "what about Honduras?" → out-of-scope bubble with scopeHint.
  - Hover a district → popup shows.

---

## 2 — Deploy + submission (45 min)

- [ ] Push `main` to GitHub. Vercel auto-deploys.
- [ ] Test the deployed URL on mobile and desktop. Particularly verify the popup behavior — `mousemove` on touch devices needs a `touchstart` fallback (or just suppress the popup on mobile if it's unstable; not worth bleeding time).
- [ ] Update `apps/web/README.md` (and root `README.md`) with the v2 highlights: tabs, agent routing, hover, ranked viz.
- [ ] Write `v2-summary.md` (per the brief: _"Ask your agent to describe what you built this week"_). Ask Claude Code in the main worktree:
  > _"Write a 250-word summary of v2: cohort feedback addressed, the parallelization workflow we used (three worktrees), the agent routing change, and known limitations. Format like `v1-summary.md`."_
- [ ] 60-second screen recording: cold load → tab switch → ranked query (chart + numbered map) → navigation prompt ("show me San Miguelito") → out-of-scope prompt → hover.
- [ ] Two screenshots: ranked-query state (chart + numbered map), out-of-scope state (scope hint).
- [ ] Submit to Google Classroom: GitHub URL + Vercel URL + `v2-summary.md` + screenshots + recording.

---

## 3 — Worktree cleanup

- [ ] After merge: `git worktree remove ..\Final_project-stream-a` (and -b, -c).
- [ ] Delete branches: `git branch -d v2/stream-a-layout v2/stream-b-agent v2/stream-c-viz` (or keep them on the remote as a paper trail of the parallelization workflow — useful evidence for the brief's "show what you used" expectation).

---

## Cuts I will make if I'm running over (in order)

1. Drop the bar chart (Stream C.3) — keep the table; ranked map highlights still answer items 5 + 6.
2. Drop the ranked map labels (Stream C.2) — keep border-color encoding only.
3. Drop the navigation actions for transport/level (Stream B), keep only `select_district` — covers 80% of feedback item 7's value.
4. Drop the Ask-tab notification dot (Stream A.1).
5. Drop the screen recording — submit screenshots only.
6. Drop the comparison `resultShape` — falls back to default table render.

The deploy and the model-generated summary are non-negotiable (they're the brief's submission requirements). Everything else is.

---

## Things explicitly _not_ in v2 (to keep scope honest)

- **No Railway worker.** Pipeline-as-worker moves to v3.
- **No Honduras or other countries.** Country switcher moves to v3.
- **No scored Robustness Auditor agent.** v2's robustness card is still the static v1 version.
- **No schema migration to `indicators_adm2`.** Stays Panama-shaped until a second country is added in v3.
- **No auth, no exports, no i18n, no Figma polish.** All v4.

If a stream finishes early, do _not_ pull these forward — instead, polish the in-flight work (better hover styling, more navigation tool examples, accessibility pass on tabs).
