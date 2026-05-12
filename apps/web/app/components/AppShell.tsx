'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import IndicatorPanel from './IndicatorPanel';
import ScopeCard from './ScopeCard';
import type { RankedHighlight } from './PanamaMap';
import type {
  AgeGroup,
  AskAction,
  AskResponseKind,
  IndicatorRow,
  IndicatorsByDist,
  PanelTab,
  ResultShape,
  TransportMode,
} from '@/lib/types';
import { AGE_GROUPS, AGE_GROUP_SHORT_LABELS, TRANSPORT_LABELS } from '@/lib/types';

const PanamaMap = dynamic(() => import('./PanamaMap'), { ssr: false });
const InequalitySimulation = dynamic(() => import('./InequalitySimulation'), { ssr: false });

// ── constants ─────────────────────────────────────────────────────────────────

const SEEDED_PROMPTS = [
  'Top 5 districts with the worst walking access for high schoolers',
  'Districts with over 1,000 high schoolers more than 30 min from a school',
  'Compare primary vs high school walking access in Panama province',
  'Rank provinces by average % within 15 min of a school',
] as const;

const LEGEND_STOPS = [
  '#7f1d1d', '#dc2626', '#f97316', '#eab308', '#16a34a',
] as const;

const NO_DATA_COLOR = '#d1d5db';

// ── types ─────────────────────────────────────────────────────────────────────

// Aggregate stats for the Insight landing (no district selected).
// Computed in AppShell because indicators live there; rendered in IndicatorPanel.
export interface InsightStats {
  nationalPct: number;
  totalUnderserved: number;
  topUnderserved: Array<{ row: IndicatorRow; underserved: number }>;
  // cod_dist → name + province, for ALL districts — drives priority panel labels
  districtMeta: Record<string, { nomb_dist: string; nomb_prov: string }>;
}

// ChatMessage mirrors the AskResponse contract so Stream B can populate
// these fields without changing this shape.
interface ChatMessage {
  role: 'user' | 'assistant';
  question?: string;
  error?: string;
  kind?: AskResponseKind;
  sql?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  highlightCodDist?: string[];
  resultShape?: ResultShape;
  narrative?: string;
  scopeHint?: string;
  actions?: AskAction[];
}

interface ScenarioRow {
  cod_dist: string;
  nomb_dist: string;
  nomb_prov: string;
  age_group: AgeGroup;
  friction: TransportMode;
  pop_total: number;
  pop_le15: number;
  pop_le30: number;
  pop_le60: number;
  pop_nodata: number;
  pct_le15: number;
  pct_le30: number;
  pct_le60: number;
}

const EMPTY_INDICATORS: Record<TransportMode, IndicatorsByDist> = { walking: {}, motorized: {} };

const COLS =
  'cod_dist,nomb_dist,nomb_prov,age_group,friction,pop_total,pop_le15,pop_le30,pop_le60,pop_nodata,pct_le15,pct_le30,pct_le60';

function ingestRows(
  rows: ScenarioRow[],
  mode: TransportMode,
  target: Record<TransportMode, IndicatorsByDist>
) {
  for (const raw of rows) {
    const row: IndicatorRow = {
      ...raw,
      data_completeness_pct:
        raw.pop_total > 0
          ? Number((((raw.pop_total - raw.pop_nodata) / raw.pop_total) * 100).toFixed(1))
          : 0,
    };
    if (!target[mode][row.cod_dist]) target[mode][row.cod_dist] = {};
    target[mode][row.cod_dist][row.age_group] = row;
  }
}

// ── component ─────────────────────────────────────────────────────────────────

export default function AppShell() {
  const [indicatorsByTransport, setIndicatorsByTransport] =
    useState<Record<TransportMode, IndicatorsByDist>>(EMPTY_INDICATORS);
  const [selectedTransport, setSelectedTransport] = useState<TransportMode>('walking');
  const [selectedAgeGroup, setSelectedAgeGroup] = useState<AgeGroup>('highschool');
  const [selectedDist, setSelectedDist] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  const [chatHighlights, setChatHighlights] = useState<string[]>([]);
  const [rankedHighlights, setRankedHighlights] = useState<RankedHighlight[] | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>('insight');
  const [askBadge, setAskBadge] = useState(false);
  const [isSimOpen, setIsSimOpen] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const urlConsumedRef = useRef(false);

  // URL-params bootstrap: ?tab=ask opens the Ask tab; ?ask=<prompt> also auto-fires.
  // Done in useEffect (not useState init) because window is unavailable during SSR.
  useEffect(() => {
    if (urlConsumedRef.current) return;
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    const askParam = params.get('ask');
    if (tab === 'ask' || askParam) {
      urlConsumedRef.current = true;
      setPanelTab('ask');
    }
  }, []);

  useEffect(() => {
    const grouped: Record<TransportMode, IndicatorsByDist> = { walking: {}, motorized: {} };

    Promise.all([
      // Canonical walking scenario: WorldPop + MAP friction + walking
      supabase.from('panama_district_indicators').select(COLS)
        .eq('pop_source', 'worldpop').eq('friction_source', 'map').eq('friction', 'walking'),
      // Motorized scenario: WorldPop + OSM road network + motorized
      supabase.from('panama_district_indicators').select(COLS)
        .eq('pop_source', 'worldpop').eq('friction_source', 'osm').eq('friction', 'motorized'),
    ]).then(([walkRes, motoRes]) => {
      if (walkRes.error || motoRes.error) {
        console.error('Failed to load indicators:', walkRes.error ?? motoRes.error);
        return;
      }
      ingestRows(walkRes.data as ScenarioRow[], 'walking', grouped);
      ingestRows(motoRes.data as ScenarioRow[], 'motorized', grouped);
      setIndicatorsByTransport(grouped);
      setIsLoading(false);
    });
  }, []);

  const indicators = indicatorsByTransport[selectedTransport] ?? {};

  const insightStats = useMemo<InsightStats | null>(() => {
    const rows = Object.values(indicators)
      .map((d) => d[selectedAgeGroup])
      .filter((r): r is IndicatorRow => r !== undefined)
      .filter((r) => r.data_completeness_pct > 0);
    // District meta: one entry per cod_dist using whichever age_group has data
    const districtMeta: Record<string, { nomb_dist: string; nomb_prov: string }> = {};
    for (const [cod, byAge] of Object.entries(indicators)) {
      const sample = Object.values(byAge).find((r): r is IndicatorRow => r !== undefined);
      if (sample) districtMeta[cod] = { nomb_dist: sample.nomb_dist, nomb_prov: sample.nomb_prov };
    }
    if (rows.length === 0) return null;
    const totalPop = rows.reduce((s, r) => s + r.pop_total, 0);
    const totalLe30 = rows.reduce((s, r) => s + r.pop_le30, 0);
    const nationalPct = totalPop > 0 ? Math.round((totalLe30 / totalPop) * 100) : 0;
    const totalUnderserved = totalPop - totalLe30;
    const topUnderserved = rows
      .map((r) => ({ row: r, underserved: r.pop_total - r.pop_le30 }))
      .filter((x) => x.underserved > 0)
      .sort((a, b) => b.underserved - a.underserved)
      .slice(0, 5);
    return { nationalPct, totalUnderserved, topUnderserved, districtMeta };
  }, [indicators, selectedAgeGroup]);

  // Only true chat results dim the map. The default top-5-worst still
  // shows in the Insight panel list, but the map stays at full opacity
  // until the user actually asks something or selects a district.
  const highlightedDists = chatHighlights;

  const distIndicators = selectedDist ? (indicators[selectedDist] ?? null) : null;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Clear the Ask-tab notification dot when the user lands on the Ask tab
  useEffect(() => {
    if (panelTab === 'ask') setAskBadge(false);
  }, [panelTab]);

  function dispatchAction(action: AskAction) {
    switch (action.type) {
      case 'select_district':
        setSelectedDist(action.cod_dist);
        setChatHighlights([]);
        break;
      case 'set_transport_mode':
        setSelectedTransport(action.mode);
        break;
      case 'set_education_level':
        setSelectedAgeGroup(action.level);
        break;
      case 'focus_panel_tab':
        setPanelTab(action.tab);
        break;
    }
  }

  async function ask(q: string) {
    if (!q.trim() || isAsking) return;
    setIsAsking(true);
    setQuestion('');
    setMessages((m) => [...m, { role: 'user', question: q }]);

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setMessages((m) => [...m, { role: 'assistant', error: data.error ?? 'Unknown error.' }]);
      } else {
        setMessages((m) => [
          ...m,
          {
            role: 'assistant',
            kind: data.kind,
            sql: data.sql,
            columns: data.columns,
            rows: data.rows,
            highlightCodDist: data.highlightCodDist,
            resultShape: data.resultShape,
            narrative: data.narrative,
            scopeHint: data.scopeHint,
            actions: data.actions,
          },
        ]);
        if (data.highlightCodDist?.length) {
          // Dedupe while preserving rank order (first occurrence = best rank)
          const ordered: string[] = [];
          const seen = new Set<string>();
          for (const c of data.highlightCodDist as string[]) {
            if (seen.has(c)) continue;
            seen.add(c);
            ordered.push(c);
          }
          setChatHighlights(ordered);
          setSelectedDist(null);
          if (data.resultShape === 'ranking') {
            setRankedHighlights(ordered.map((cod_dist, i) => ({ cod_dist, rank: i + 1 })));
          } else {
            setRankedHighlights(null);
          }
        } else {
          setRankedHighlights(null);
        }
        if (Array.isArray(data.actions)) {
          for (const action of data.actions as AskAction[]) dispatchAction(action);
        }
      }

      if (panelTab !== 'ask') setAskBadge(true);
    } catch {
      setMessages((m) => [...m, { role: 'assistant', error: 'Network error. Try again.' }]);
    } finally {
      setIsAsking(false);
    }
  }

  // Selecting a district from the map or insight list takes the user to the Insight tab
  function selectDistrict(cod: string) {
    setSelectedDist(cod);
    setChatHighlights([]);
    setRankedHighlights(null);
    setPanelTab('insight');
  }

  // Auto-fire ?ask=<prompt> from URL once on mount (landing page → Ask)
  const askFireRef = useRef(false);
  useEffect(() => {
    if (askFireRef.current) return;
    if (typeof window === 'undefined') return;
    const askParam = new URLSearchParams(window.location.search).get('ask');
    if (askParam && askParam.trim()) {
      askFireRef.current = true;
      ask(askParam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* ── Map ─────────────────────────────────────────────────────────────── */}
      <div className="relative h-[42vh] shrink-0 md:h-auto md:min-h-0 md:flex-1 md:basis-[65%]">
        {isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-100">
            <p className="animate-pulse text-sm text-neutral-500">Loading map data...</p>
          </div>
        )}
        <PanamaMap
          indicators={indicators}
          activeAgeGroup={selectedAgeGroup}
          highlightedDists={highlightedDists}
          rankedHighlights={rankedHighlights}
          selectedDist={selectedDist}
          onDistrictClick={selectDistrict}
          onResetView={() => {
            setSelectedDist(null);
            setChatHighlights([]);
            setRankedHighlights(null);
          }}
        />
      </div>

      {/* ── Side panel ──────────────────────────────────────────────────────── */}
      <aside className="flex flex-1 flex-col overflow-hidden border-t border-neutral-200 bg-white md:flex-none md:basis-[35%] md:border-l md:border-t-0">

        {/* Header + controls — always visible, never scrolls away */}
        <div className="shrink-0 border-b border-neutral-200 px-4 pb-2 pt-3 md:px-5 md:pb-3 md:pt-4">
          <div className="mb-2 flex items-center justify-between md:mb-3">
            <div>
              <h1 className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
                EduAccess LAC
              </h1>
              <p className="mt-0.5 text-xs text-neutral-400">Panama · school access</p>
            </div>
            <Link
              href="/"
              className="text-xs text-neutral-400 transition-colors hover:text-neutral-600"
            >
              ← Home
            </Link>
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
              {AGE_GROUPS.map((g) => (
                <button
                  key={g}
                  onClick={() => setSelectedAgeGroup(g)}
                  className={`flex-1 rounded px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors md:flex-none ${
                    selectedAgeGroup === g
                      ? 'bg-white text-emerald-700 shadow-sm'
                      : 'text-neutral-500 hover:text-neutral-700'
                  }`}
                >
                  {AGE_GROUP_SHORT_LABELS[g]}
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
            {(['insight', 'ask'] as PanelTab[]).map((tab) => {
              const active = panelTab === tab;
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
                  {tab === 'insight' ? <InsightIcon /> : <AskIcon />}
                  <span>{tab === 'insight' ? 'Insight' : 'Ask'}</span>
                  {tab === 'ask' && askBadge && !active && (
                    <span className="absolute right-3 top-2.5 inline-block h-2 w-2 rounded-full bg-emerald-500" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Body — swaps based on panelTab */}
        <div className="flex min-h-0 flex-1 flex-col">
          {panelTab === 'insight' && (
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {!isLoading && !selectedDist && chatHighlights.length === 0 && (
                <p className="mb-3 text-xs text-neutral-500">
                  Click any district on the map, or switch to <strong>Ask</strong> to query the data.
                </p>
              )}
              <IndicatorPanel
                isLoading={isLoading}
                insightStats={insightStats}
                selectedDist={selectedDist}
                distIndicators={distIndicators}
                selectedTransport={selectedTransport}
                selectedAgeGroup={selectedAgeGroup}
                onSelectDist={selectDistrict}
                onClearSelection={() => setSelectedDist(null)}
                onOpenSim={() => setIsSimOpen(true)}
              />
            </div>
          )}

          {panelTab === 'ask' && (
            <div className="flex min-h-0 flex-1 flex-col">
              {messages.length === 0 ? (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <ScopeCard />
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
                  placeholder="Ask about school access in Panama..."
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
            Data: IDB Accessibility Platform · v1 preview · 2026
          </p>
        </div>
      </aside>

      {isSimOpen && (
        <InequalitySimulation
          indicators={indicators}
          ageGroup={selectedAgeGroup}
          transport={selectedTransport}
          onClose={() => setIsSimOpen(false)}
        />
      )}
    </div>
  );
}

// ── tab icons ─────────────────────────────────────────────────────────────────

function InsightIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <line x1="4" y1="20" x2="4" y2="13" />
      <line x1="10" y1="20" x2="10" y2="9" />
      <line x1="16" y1="20" x2="16" y2="14" />
      <line x1="22" y1="20" x2="22" y2="6" />
    </svg>
  );
}

function AskIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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
                  <th
                    key={c}
                    className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-neutral-500"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {msg.rows.map((row, i) => (
                <tr key={i} className="border-t border-neutral-100 hover:bg-neutral-50">
                  {msg.columns?.map((c) => (
                    <td key={c} className="whitespace-nowrap px-2 py-1.5 text-neutral-700">
                      {String(row[c] ?? '')}
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
  'Top 5 districts with the worst walking access for high schoolers',
  'Compare primary vs high school walking access in Panama province',
] as const;
