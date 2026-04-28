'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import IndicatorPanel from './IndicatorPanel';
import type { AgeGroup, IndicatorRow, IndicatorsByDist, TransportMode } from '@/lib/types';
import { AGE_GROUPS, AGE_GROUP_SHORT_LABELS, TRANSPORT_LABELS } from '@/lib/types';

const PanamaMap = dynamic(() => import('./PanamaMap'), { ssr: false });

// ── constants ─────────────────────────────────────────────────────────────────

const SEEDED_PROMPTS = [
  'Top 5 districts with the worst walking access for high schoolers',
  'Which districts have over 1,000 high schoolers more than 30 minutes from a school?',
  'Show districts where over 20% of school-age population lacks travel-time data',
  'Compare primary vs high school walking access in the districts of Panama province',
  'Rank provinces by their average % of population within 15 minutes of a school',
] as const;

const LEGEND_STOPS = [
  '#7f1d1d', '#dc2626', '#f97316', '#eab308', '#16a34a',
] as const;

const NO_DATA_COLOR = '#d1d5db';

// ── types ─────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant';
  question?: string;
  sql?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  narrative?: string;
  error?: string;
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
  const chatEndRef = useRef<HTMLDivElement>(null);

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

  const top5Worst = useMemo<IndicatorRow[]>(() => {
    const rows = Object.values(indicators)
      .map((d) => d[selectedAgeGroup])
      .filter((r): r is IndicatorRow => r !== undefined)
      .filter((r) => r.data_completeness_pct > 0);
    return rows.sort((a, b) => a.pct_le30 - b.pct_le30).slice(0, 5);
  }, [indicators, selectedAgeGroup]);

  const highlightedDists = useMemo(
    () => (chatHighlights.length > 0 ? chatHighlights : top5Worst.map((r) => r.cod_dist)),
    [chatHighlights, top5Worst]
  );

  const distIndicators = selectedDist ? (indicators[selectedDist] ?? null) : null;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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
            sql: data.sql,
            columns: data.columns,
            rows: data.rows,
            narrative: data.narrative,
          },
        ]);
        if (data.highlightCodDist?.length) {
          setChatHighlights(data.highlightCodDist);
          setSelectedDist(null);
        }
      }
    } catch {
      setMessages((m) => [...m, { role: 'assistant', error: 'Network error. Try again.' }]);
    } finally {
      setIsAsking(false);
    }
  }

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* ── Map ─────────────────────────────────────────────────────────────── */}
      <div className="relative min-h-[50vh] flex-1 md:min-h-0 md:basis-[65%]">
        {isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-100">
            <p className="animate-pulse text-sm text-neutral-500">Loading map data...</p>
          </div>
        )}
        <PanamaMap
          indicators={indicators}
          activeAgeGroup={selectedAgeGroup}
          highlightedDists={highlightedDists}
          selectedDist={selectedDist}
          onDistrictClick={(cod) => {
            setSelectedDist(cod);
            setChatHighlights([]);
          }}
        />
      </div>

      {/* ── Side panel ──────────────────────────────────────────────────────── */}
      <aside className="flex flex-col overflow-hidden border-t border-neutral-200 bg-white md:basis-[35%] md:border-l md:border-t-0">

        {/* Header + controls — always visible, never scrolls away */}
        <div className="shrink-0 border-b border-neutral-200 px-5 pb-3 pt-4">
          <div className="mb-3 flex items-center justify-between">
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
          <div className="mb-2 flex items-center gap-3">
            <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
              Transport
            </span>
            <div className="flex gap-0.5 rounded-md bg-neutral-100 p-0.5">
              {(Object.keys(TRANSPORT_LABELS) as TransportMode[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setSelectedTransport(t)}
                  className={`rounded px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
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
          <div className="mb-3 flex items-center gap-3">
            <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
              Level
            </span>
            <div className="flex gap-0.5 rounded-md bg-neutral-100 p-0.5">
              {AGE_GROUPS.map((g) => (
                <button
                  key={g}
                  onClick={() => setSelectedAgeGroup(g)}
                  className={`rounded px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
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
                className="inline-block h-2 w-5 shrink-0 rounded-sm"
                style={{ backgroundColor: color }}
              />
            ))}
            <span className="ml-0.5 mr-3 text-[10px] text-neutral-400">Better</span>
            <span
              className="inline-block h-2 w-5 shrink-0 rounded-sm"
              style={{ backgroundColor: NO_DATA_COLOR }}
            />
            <span className="ml-0.5 text-[10px] text-neutral-400">No data</span>
          </div>
        </div>

        {/* Scrollable indicator content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <IndicatorPanel
            isLoading={isLoading}
            top5Worst={top5Worst}
            selectedDist={selectedDist}
            distIndicators={distIndicators}
            selectedTransport={selectedTransport}
            selectedAgeGroup={selectedAgeGroup}
            onSelectDist={(cod) => {
              setSelectedDist(cod);
              setChatHighlights([]);
            }}
            onClearSelection={() => setSelectedDist(null)}
          />
        </div>

        {/* Chat */}
        <div className="flex max-h-[45vh] shrink-0 flex-col border-t border-neutral-200 bg-white">
          {messages.length === 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pb-2 pt-3">
              {SEEDED_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => ask(p)}
                  disabled={isAsking}
                  className="rounded-full border border-neutral-200 px-2.5 py-1 text-left text-xs text-neutral-600 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          {messages.length > 0 && (
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-2">
              {messages.map((msg, i) => (
                <ChatBubble key={i} msg={msg} />
              ))}
              {isAsking && <p className="animate-pulse text-xs text-neutral-400">Thinking...</p>}
              <div ref={chatEndRef} />
            </div>
          )}

          <form
            onSubmit={(e) => { e.preventDefault(); ask(question); }}
            className="flex gap-2 border-t border-neutral-100 px-4 py-3"
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

        {/* Footer */}
        <div className="shrink-0 border-t border-neutral-100 px-5 py-2">
          <p className="text-xs text-neutral-400">
            Data: IDB Accessibility Platform · v1 preview · 2026
          </p>
        </div>
      </aside>
    </div>
  );
}

// ── chat bubble ───────────────────────────────────────────────────────────────

function ChatBubble({ msg }: { msg: ChatMessage }) {
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
