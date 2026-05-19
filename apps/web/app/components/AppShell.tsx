'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import IndicatorPanel from './IndicatorPanel';
import ScopeCard from './ScopeCard';
import type { RankedHighlight } from './CountryMap';
import type {
  AskAction,
  AskResponseKind,
  CountryIso,
  EducationLevel,
  IndicatorRow,
  IndicatorsByDist,
  PanelTab,
  ResultShape,
  TransportMode,
} from '@/lib/types';
import {
  COUNTRIES,
  COUNTRY_ISOS,
  EDUCATION_LEVELS,
  EDUCATION_LEVEL_SHORT_LABELS,
  TRANSPORT_LABELS,
} from '@/lib/types';

const CountryMap = dynamic(() => import('./CountryMap'), { ssr: false });
import SimulationPanel, { pickRepresentatives } from './SimulationPanel';

const SIM_DURATION_MS = 20_000;
const SIM_MINUTES = 60;

// ── constants ─────────────────────────────────────────────────────────────────

const SEEDED_PROMPTS = [
  'Top 5 districts with the worst walking access for upper-secondary students',
  'Districts with over 1,000 upper-secondary students more than 30 min from a school',
  'Compare primary vs upper-secondary walking access by province',
  'Rank provinces by average % within 15 min of a school',
] as const;

const LEGEND_STOPS = [
  '#7f1d1d', '#dc2626', '#f97316', '#eab308', '#16a34a',
] as const;

const NO_DATA_COLOR = '#d1d5db';

// Friendly headers for the chat result table — raw SQL column names → labels.
const COLUMN_LABELS: Record<string, string> = {
  pct_le15: '% within 15 min',
  pct_le30: '% within 30 min',
  pct_le60: '% within 60 min',
  pct_le30_osrm: '% within 30 min (OSRM)',
  pop_total: 'Students',
  children_underserved: 'Beyond 30 min',
  admin2_name: 'District',
  admin1_name: 'Province',
  admin2_pcode: 'Code',
  education_level: 'Level',
  mode: 'Transport',
  country_iso: 'Country',
};
function colLabel(c: string): string {
  return COLUMN_LABELS[c] ?? c.replace(/_/g, ' ');
}

// pop_total is a WorldPop estimate — a float. Show headcounts as whole numbers
// with thousands separators (children_underserved is a derived headcount too).
const HEADCOUNT_COLS = new Set(['pop_total', 'children_underserved']);
function formatCell(col: string, value: unknown): string {
  if (value == null) return '';
  if (HEADCOUNT_COLS.has(col)) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.round(n).toLocaleString();
  }
  // Raw codes ('secalta', 'walking') read poorly in a results table.
  if (col === 'education_level') {
    return EDUCATION_LEVEL_SHORT_LABELS[value as EducationLevel] ?? String(value);
  }
  if (col === 'mode') {
    return TRANSPORT_LABELS[value as TransportMode] ?? String(value);
  }
  return String(value);
}

// ── types ─────────────────────────────────────────────────────────────────────

// Aggregate stats for the Insight landing (no district selected).
export interface InsightStats {
  nationalPct: number;
  totalUnderserved: number;
  topUnderserved: Array<{ row: IndicatorRow; underserved: number }>;
  // admin2_pcode → name + province, for ALL districts — drives priority labels
  districtMeta: Record<string, { admin2_name: string; admin1_name: string }>;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  question?: string;
  error?: string;
  kind?: AskResponseKind;
  sql?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  highlightAdm2?: string[];
  resultShape?: ResultShape;
  narrative?: string;
  scopeHint?: string;
  actions?: AskAction[];
}

const EMPTY_INDICATORS: Record<TransportMode, IndicatorsByDist> = { walking: {}, motorized: {} };

const VIEW_COLS =
  'country_iso,admin2_pcode,admin2_name,admin1_name,education_level,mode,pct_le15,pct_le30,pct_le60,pop_total,pct_le30_osrm';

/** Underserved school-age population in a cell (pop beyond a 30-min trip). */
export function underservedOf(r: IndicatorRow): number {
  return Math.max(0, Math.round(r.pop_total * (1 - (r.pct_le30 ?? 0) / 100)));
}

// ── component ─────────────────────────────────────────────────────────────────

interface Props {
  country: CountryIso;
  /** deep-link initial tab / question — set once by PlatformEntry */
  initialTab?: PanelTab;
  initialAsk?: string;
  onCountryChange: (c: CountryIso) => void;
  onBackToLac: () => void;
}

export default function AppShell({
  country,
  initialTab,
  initialAsk,
  onCountryChange,
  onBackToLac,
}: Props) {
  const [indicatorsByTransport, setIndicatorsByTransport] =
    useState<Record<TransportMode, IndicatorsByDist>>(EMPTY_INDICATORS);
  const [selectedTransport, setSelectedTransport] = useState<TransportMode>('walking');
  const [selectedLevel, setSelectedLevel] = useState<EducationLevel>('secalta');
  const [selectedDist, setSelectedDist] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  const [chatHighlights, setChatHighlights] = useState<string[]>([]);
  const [rankedHighlights, setRankedHighlights] = useState<RankedHighlight[] | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>(initialTab ?? 'insight');
  const [askBadge, setAskBadge] = useState(false);
  const [simMin, setSimMin] = useState(0);
  const [simIsPlaying, setSimIsPlaying] = useState(false);
  const [simIsFinished, setSimIsFinished] = useState(false);
  const simAnimRef = useRef<number | null>(null);
  const simPlayStartRef = useRef<number | null>(null);
  const simElapsedAtPauseRef = useRef<number>(0);
  const simulationActive = panelTab === 'simulation';
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Load indicators whenever the country changes.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setSelectedDist(null);
    setChatHighlights([]);
    setRankedHighlights(null);

    (async () => {
      // Sequential paging until a short page is returned. Reliable — it does
      // not depend on a separate count query (a null count silently truncated
      // the load to one page and greyed out most districts).
      const PAGE = 1000;
      const grouped: Record<TransportMode, IndicatorsByDist> = { walking: {}, motorized: {} };
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('v_indicators_adm2')
          .select(VIEW_COLS)
          .eq('country_iso', country)
          // Total order over the full key — v_indicators_adm2 has 6 rows per
          // district (3 levels × 2 modes); ordering by admin2_pcode alone
          // leaves ties, which makes offset paging drop/duplicate rows.
          .order('admin2_pcode', { ascending: true })
          .order('education_level', { ascending: true })
          .order('mode', { ascending: true })
          .range(from, from + PAGE - 1);
        if (cancelled) return;
        if (error) {
          console.error('Failed to load indicators:', error);
          break;
        }
        const rows = (data as IndicatorRow[]) ?? [];
        for (const row of rows) {
          const mode = row.mode;
          if (mode !== 'walking' && mode !== 'motorized') continue;
          if (!grouped[mode][row.admin2_pcode]) grouped[mode][row.admin2_pcode] = {};
          grouped[mode][row.admin2_pcode][row.education_level] = row;
        }
        if (rows.length < PAGE) break;
        from += PAGE;
      }
      if (cancelled) return;
      setIndicatorsByTransport(grouped);
      setIsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [country]);

  const indicators = indicatorsByTransport[selectedTransport] ?? {};

  const insightStats = useMemo<InsightStats | null>(() => {
    const rows = Object.values(indicators)
      .map((d) => d[selectedLevel])
      .filter((r): r is IndicatorRow => r !== undefined)
      .filter((r) => r.pop_total > 0);
    const districtMeta: Record<string, { admin2_name: string; admin1_name: string }> = {};
    for (const [code, byLevel] of Object.entries(indicators)) {
      const sample = Object.values(byLevel).find((r): r is IndicatorRow => r !== undefined);
      if (sample) {
        districtMeta[code] = {
          admin2_name: sample.admin2_name,
          admin1_name: sample.admin1_name,
        };
      }
    }
    if (rows.length === 0) return null;
    const totalPop = rows.reduce((s, r) => s + r.pop_total, 0);
    const totalLe30 = rows.reduce((s, r) => s + r.pop_total * ((r.pct_le30 ?? 0) / 100), 0);
    const nationalPct = totalPop > 0 ? Math.round((totalLe30 / totalPop) * 100) : 0;
    const totalUnderserved = Math.round(totalPop - totalLe30);
    const topUnderserved = rows
      .map((r) => ({ row: r, underserved: underservedOf(r) }))
      .filter((x) => x.underserved > 0)
      .sort((a, b) => b.underserved - a.underserved)
      .slice(0, 5);
    return { nationalPct, totalUnderserved, topUnderserved, districtMeta };
  }, [indicators, selectedLevel]);

  const highlightedDists = chatHighlights;
  const distIndicators = selectedDist ? (indicators[selectedDist] ?? null) : null;

  // When the simulation finishes, surface the three sampled districts (the kid
  // tracks) on the map so the user can place them geographically.
  const simHighlights = useMemo(
    () =>
      simulationActive && simIsFinished
        ? pickRepresentatives(indicators, selectedLevel).map((r) => r.row.admin2_pcode)
        : [],
    [simulationActive, simIsFinished, indicators, selectedLevel]
  );

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (panelTab === 'ask') setAskBadge(false);
  }, [panelTab]);

  function dispatchAction(action: AskAction) {
    switch (action.type) {
      case 'set_country':
        onCountryChange(action.country);
        break;
      case 'select_district':
        setSelectedDist(action.admin2_pcode);
        setChatHighlights([]);
        break;
      case 'set_transport_mode':
        setSelectedTransport(action.mode);
        break;
      case 'set_education_level':
        setSelectedLevel(action.level);
        break;
      case 'focus_panel_tab':
        setPanelTab(action.tab);
        break;
    }
  }

  async function ask(q: string, opts: { country?: CountryIso; reask?: boolean } = {}) {
    if (!q.trim()) return;
    if (isAsking && !opts.reask) return;
    const askCountry = opts.country ?? country;
    setIsAsking(true);
    setQuestion('');
    if (!opts.reask) setMessages((m) => [...m, { role: 'user', question: q }]);

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          country: askCountry,
          level: selectedLevel,
          transport: selectedTransport,
        }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setMessages((m) => [...m, { role: 'assistant', error: data.error ?? 'Unknown error.' }]);
        return;
      }

      const actions: AskAction[] = Array.isArray(data.actions) ? data.actions : [];

      // Cross-country: a set_country action means "switch the map and re-run
      // the question there". Skip the navigation bubble; the re-ask answers.
      const switchAction = actions.find((a) => a.type === 'set_country');
      if (switchAction?.type === 'set_country' && !opts.reask) {
        onCountryChange(switchAction.country);
        // Await the re-ask so `isAsking` is cleared once, by the inner call's
        // finally — not mid-flight by this outer call's finally.
        await ask(q, { country: switchAction.country, reask: true });
        return;
      }

      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          kind: data.kind,
          sql: data.sql,
          columns: data.columns,
          rows: data.rows,
          highlightAdm2: data.highlightAdm2,
          resultShape: data.resultShape,
          narrative: data.narrative,
          scopeHint: data.scopeHint,
          actions: data.actions,
        },
      ]);
      if (data.highlightAdm2?.length) {
        const ordered: string[] = [];
        const seen = new Set<string>();
        for (const c of data.highlightAdm2 as string[]) {
          if (seen.has(c)) continue;
          seen.add(c);
          ordered.push(c);
        }
        if (ordered.length === 1) {
          // A single-district answer: select it so the map zooms in to the
          // district, not just tints it. Multi-row results stay highlighted.
          setSelectedDist(ordered[0]);
          setChatHighlights([]);
          setRankedHighlights(null);
        } else {
          setChatHighlights(ordered);
          setSelectedDist(null);
          if (data.resultShape === 'ranking') {
            setRankedHighlights(ordered.map((admin2_pcode, i) => ({ admin2_pcode, rank: i + 1 })));
          } else {
            setRankedHighlights(null);
          }
        }
      } else {
        setRankedHighlights(null);
      }
      for (const action of actions) dispatchAction(action);

      if (panelTab !== 'ask') setAskBadge(true);
    } catch {
      setMessages((m) => [...m, { role: 'assistant', error: 'Network error. Try again.' }]);
    } finally {
      setIsAsking(false);
    }
  }

  function selectDistrict(code: string) {
    setSelectedDist(code);
    setChatHighlights([]);
    setRankedHighlights(null);
    setPanelTab('insight');
  }

  // ── simulation animation loop ───────────────────────────────────────────
  function simulationTick() {
    if (simPlayStartRef.current === null) return;
    const realMs = performance.now() - simPlayStartRef.current + simElapsedAtPauseRef.current;
    const t = Math.min(SIM_MINUTES, (realMs / SIM_DURATION_MS) * SIM_MINUTES);
    setSimMin(t);
    if (t >= SIM_MINUTES) {
      setSimIsPlaying(false);
      setSimIsFinished(true);
      simPlayStartRef.current = null;
      simElapsedAtPauseRef.current = 0;
      simAnimRef.current = null;
      return;
    }
    simAnimRef.current = requestAnimationFrame(simulationTick);
  }

  function playSimulation() {
    if (simIsFinished) {
      simElapsedAtPauseRef.current = 0;
      setSimIsFinished(false);
      setSimMin(0);
    }
    simPlayStartRef.current = performance.now();
    setSimIsPlaying(true);
    simAnimRef.current = requestAnimationFrame(simulationTick);
  }

  function pauseSimulation() {
    if (simPlayStartRef.current !== null) {
      simElapsedAtPauseRef.current += performance.now() - simPlayStartRef.current;
      simPlayStartRef.current = null;
    }
    if (simAnimRef.current) cancelAnimationFrame(simAnimRef.current);
    simAnimRef.current = null;
    setSimIsPlaying(false);
  }

  function replaySimulation() {
    if (simAnimRef.current) cancelAnimationFrame(simAnimRef.current);
    simElapsedAtPauseRef.current = 0;
    simPlayStartRef.current = performance.now();
    setSimMin(0);
    setSimIsFinished(false);
    setSimIsPlaying(true);
    simAnimRef.current = requestAnimationFrame(simulationTick);
  }

  useEffect(() => {
    if (panelTab === 'simulation') return;
    if (simAnimRef.current) cancelAnimationFrame(simAnimRef.current);
    simAnimRef.current = null;
    simPlayStartRef.current = null;
    simElapsedAtPauseRef.current = 0;
    setSimIsPlaying(false);
    setSimIsFinished(false);
    setSimMin(0);
  }, [panelTab]);

  // Auto-fire the deep-link ?ask= once, on mount. initialAsk is set only on a
  // fresh deep-link entry — PlatformEntry clears it on any in-app navigation.
  const askFiredRef = useRef(false);
  useEffect(() => {
    if (askFiredRef.current) return;
    askFiredRef.current = true;
    if (initialAsk && initialAsk.trim()) ask(initialAsk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const countryName = COUNTRIES[country].name;

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* ── Map ─────────────────────────────────────────────────────────────── */}
      <div className="relative h-[42vh] shrink-0 md:h-auto md:min-h-0 md:flex-1 md:basis-[65%]">
        {/* Opaque loader only on the very first load (no map yet). On a
            country switch, the map flies the camera and the choropleth
            recolours as data arrives — no full-screen flash. */}
        {isLoading && Object.keys(indicators).length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-100">
            <p className="animate-pulse text-sm text-neutral-500">Loading map data...</p>
          </div>
        )}
        <CountryMap
          country={country}
          indicators={indicators}
          activeLevel={selectedLevel}
          activeTransport={selectedTransport}
          highlightedDists={highlightedDists}
          rankedHighlights={rankedHighlights}
          selectedDist={selectedDist}
          onDistrictClick={selectDistrict}
          onResetView={() => {
            setSelectedDist(null);
            setChatHighlights([]);
            setRankedHighlights(null);
          }}
          simulationActive={simulationActive}
          simulationSimMin={simMin}
          simHighlights={simHighlights}
        />
      </div>

      {/* ── Side panel ──────────────────────────────────────────────────────── */}
      <aside className="flex flex-1 flex-col overflow-hidden border-t border-neutral-200 bg-white md:flex-none md:basis-[35%] md:border-l md:border-t-0">

        {/* Header + controls */}
        <div className="shrink-0 border-b border-neutral-200 px-4 pb-2 pt-3 md:px-5 md:pb-3 md:pt-4">
          <div className="mb-2 flex items-center justify-between md:mb-3">
            <div>
              <h1 className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
                EduAccess LAC
              </h1>
              <p className="mt-0.5 text-xs text-neutral-400">{countryName} · school access</p>
            </div>
            <Link
              href="/"
              className="text-xs text-neutral-400 transition-colors hover:text-neutral-600"
            >
              ← Home
            </Link>
          </div>

          {/* Country switcher — also the way back to the LAC overview */}
          <div className="mb-1.5 flex items-center gap-2 md:mb-2 md:gap-3">
            <span className="hidden w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 md:block">
              Country
            </span>
            <select
              value={country}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '__lac__') onBackToLac();
                else onCountryChange(v as CountryIso);
              }}
              className="w-full rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-emerald-700 outline-none transition-colors hover:border-neutral-300 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-200 md:w-auto"
            >
              <option value="__lac__">← All of Latin America</option>
              {COUNTRY_ISOS.map((c) => (
                <option key={c} value={c}>
                  {COUNTRIES[c].name}
                </option>
              ))}
            </select>
          </div>

          {/* Transport */}
          <div className="mb-1.5 flex items-center gap-2 md:mb-2 md:gap-3">
            <span className="hidden w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 md:block">
              Transport
            </span>
            <div className="flex w-full gap-0.5 rounded-md bg-neutral-100 p-0.5 md:w-auto">
              {(Object.keys(TRANSPORT_LABELS) as TransportMode[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setSelectedTransport(t)}
                  className={`flex-1 rounded px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors md:flex-none ${
                    selectedTransport === t
                      ? 'bg-white text-emerald-700 shadow-sm'
                      : 'text-neutral-500 hover:text-neutral-700'
                  }`}
                >
                  {TRANSPORT_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {/* Education level */}
          <div className="mb-2 flex items-center gap-2 md:mb-3 md:gap-3">
            <span className="hidden w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 md:block">
              Level
            </span>
            <div className="flex w-full gap-0.5 rounded-md bg-neutral-100 p-0.5 md:w-auto">
              {EDUCATION_LEVELS.map((g) => (
                <button
                  key={g}
                  onClick={() => setSelectedLevel(g)}
                  className={`flex-1 rounded px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors md:flex-none ${
                    selectedLevel === g
                      ? 'bg-white text-emerald-700 shadow-sm'
                      : 'text-neutral-500 hover:text-neutral-700'
                  }`}
                >
                  {EDUCATION_LEVEL_SHORT_LABELS[g]}
                </button>
              ))}
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-1">
            <span className="mr-0.5 text-[10px] text-neutral-400">Worse</span>
            {LEGEND_STOPS.map((color) => (
              <span
                key={color}
                className="inline-block h-2 w-4 shrink-0 rounded-sm md:w-5"
                style={{ backgroundColor: color }}
              />
            ))}
            <span className="ml-0.5 mr-2 text-[10px] text-neutral-400 md:mr-3">Better</span>
            <span
              className="inline-block h-2 w-4 shrink-0 rounded-sm md:w-5"
              style={{ backgroundColor: NO_DATA_COLOR }}
            />
            <span className="ml-0.5 text-[10px] text-neutral-400">No data</span>
          </div>
        </div>

        {/* Tab strip */}
        <div className="shrink-0 border-b border-neutral-200 bg-white">
          <div className="flex">
            {(['insight', 'ask', 'simulation'] as PanelTab[]).map((tab) => {
              const active = panelTab === tab;
              const label =
                tab === 'insight' ? 'Insight' : tab === 'ask' ? 'Ask' : 'Simulate';
              const Icon =
                tab === 'insight' ? InsightIcon : tab === 'ask' ? AskIcon : SimulateIcon;
              return (
                <button
                  key={tab}
                  onClick={() => setPanelTab(tab)}
                  className={`relative flex flex-1 items-center justify-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${
                    active
                      ? 'border-emerald-700 bg-emerald-50/60 text-emerald-800'
                      : 'border-transparent text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800'
                  }`}
                >
                  <Icon />
                  <span>{label}</span>
                  {tab === 'ask' && askBadge && !active && (
                    <span className="absolute right-3 top-2.5 inline-block h-2 w-2 rounded-full bg-emerald-500" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col">
          {panelTab === 'insight' && (
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {!isLoading && !selectedDist && chatHighlights.length === 0 && (
                <p className="mb-3 text-xs text-neutral-500">
                  Click any district on the map, or switch to <strong>Ask</strong> to query the data.
                </p>
              )}
              <IndicatorPanel
                country={country}
                isLoading={isLoading}
                insightStats={insightStats}
                selectedDist={selectedDist}
                distIndicators={distIndicators}
                selectedTransport={selectedTransport}
                selectedLevel={selectedLevel}
                onSelectDist={selectDistrict}
                onClearSelection={() => setSelectedDist(null)}
                onOpenSim={() => setPanelTab('simulation')}
              />
            </div>
          )}

          {panelTab === 'simulation' && (
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <SimulationPanel
                indicators={indicators}
                level={selectedLevel}
                transport={selectedTransport}
                simMin={simMin}
                isPlaying={simIsPlaying}
                isFinished={simIsFinished}
                onPlay={playSimulation}
                onPause={pauseSimulation}
                onReplay={replaySimulation}
              />
            </div>
          )}

          {panelTab === 'ask' && (
            <div className="flex min-h-0 flex-1 flex-col">
              {messages.length === 0 ? (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <ScopeCard countryName={countryName} />
                  <div className="flex flex-col gap-1.5 px-4 pb-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                      Try one
                    </p>
                    {SEEDED_PROMPTS.map((p) => (
                      <button
                        key={p}
                        onClick={() => ask(p)}
                        disabled={isAsking}
                        className="rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-left text-xs text-neutral-700 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
                  {messages.map((msg, i) => (
                    <ChatBubble key={i} msg={msg} onPromptClick={ask} />
                  ))}
                  {isAsking && <p className="animate-pulse text-xs text-neutral-400">Thinking...</p>}
                  <div ref={chatEndRef} />
                </div>
              )}

              <form
                onSubmit={(e) => { e.preventDefault(); ask(question); }}
                className="flex shrink-0 gap-2 border-t border-neutral-100 px-4 py-3"
              >
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={`Ask about school access in ${countryName}...`}
                  disabled={isAsking}
                  className="flex-1 rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-200 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={isAsking || !question.trim()}
                  className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-800 disabled:opacity-40"
                >
                  Ask
                </button>
              </form>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-neutral-100 px-5 py-2">
          <p className="text-xs text-neutral-400">
            Data: IDB Accessibility Platform · FMM + OSRM routing · 2026
          </p>
        </div>
      </aside>
    </div>
  );
}

// ── tab icons ─────────────────────────────────────────────────────────────────

function InsightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <line x1="4" y1="20" x2="4" y2="13" />
      <line x1="10" y1="20" x2="10" y2="9" />
      <line x1="16" y1="20" x2="16" y2="14" />
      <line x1="22" y1="20" x2="22" y2="6" />
    </svg>
  );
}

function AskIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function SimulateIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  );
}

// ── chat bubble ───────────────────────────────────────────────────────────────

interface ChatBubbleProps {
  msg: ChatMessage;
  onPromptClick: (prompt: string) => void;
}

function ChatBubble({ msg, onPromptClick }: ChatBubbleProps) {
  const [showSql, setShowSql] = useState(false);

  if (msg.role === 'user') {
    return (
      <div className="self-end max-w-[85%] rounded-2xl rounded-br-sm bg-emerald-700 px-3 py-2 text-sm text-white">
        {msg.question}
      </div>
    );
  }

  if (msg.error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        {msg.error}
      </div>
    );
  }

  if (msg.kind === 'explainer') {
    return (
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-700">
        {msg.narrative && <p>{msg.narrative}</p>}
      </div>
    );
  }

  if (msg.kind === 'out_of_scope') {
    return (
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-700">
        {msg.narrative && <p>{msg.narrative}</p>}
        {msg.scopeHint && (
          <p className="mt-2 text-xs text-neutral-500">{msg.scopeHint}</p>
        )}
        <div className="mt-3 flex flex-col gap-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
            Try instead
          </p>
          {SUGGESTED_FALLBACK_PROMPTS.map((p) => (
            <button
              key={p}
              onClick={() => onPromptClick(p)}
              className="rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-left text-xs text-neutral-700 transition-colors hover:border-emerald-300 hover:bg-emerald-50/50"
            >
              {p}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {msg.narrative && <p className="text-sm text-neutral-700">{msg.narrative}</p>}

      {msg.rows && msg.rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-neutral-200">
          <table className="w-full text-xs">
            <thead className="bg-neutral-50">
              <tr>
                {msg.columns?.map((c) => (
                  <th key={c} className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-neutral-500">
                    {colLabel(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {msg.rows.map((row, i) => (
                <tr key={i} className="border-t border-neutral-100 hover:bg-neutral-50">
                  {msg.columns?.map((c) => (
                    <td key={c} className="whitespace-nowrap px-2 py-1.5 text-neutral-700">
                      {formatCell(c, row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {msg.rows?.length === 0 && (
        <p className="text-xs text-neutral-400">No results found.</p>
      )}

      {msg.sql && (
        <div>
          <button
            onClick={() => setShowSql((s) => !s)}
            className="text-xs text-neutral-400 hover:text-neutral-600"
          >
            {showSql ? '▲ Hide SQL' : '▼ Show SQL'}
          </button>
          {showSql && (
            <pre className="mt-1 overflow-x-auto rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-600">
              {msg.sql}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

const SUGGESTED_FALLBACK_PROMPTS = [
  'Top 5 districts with the worst walking access for upper-secondary students',
  'Rank provinces by average % within 15 min of a school',
] as const;
