'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import IndicatorPanel from './IndicatorPanel';
import type {
  AgeGroup,
  IndicatorRow,
  IndicatorsByDist,
  TransportMode,
} from '@/lib/types';

const PanamaMap = dynamic(() => import('./PanamaMap'), { ssr: false });

const SEEDED_PROMPTS = [
  'Top 5 districts with the worst walking access for high schoolers',
  'Which districts have over 1,000 high schoolers more than 30 minutes from a school?',
  'Show districts where over 20% of school-age population lacks travel-time data',
  'Compare primary vs high school walking access in the districts of Panama province',
  'Rank provinces by their average % of population within 15 minutes of a school',
] as const;

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

const EMPTY_INDICATORS: Record<TransportMode, IndicatorsByDist> = {
  walking: {},
  motorized: {},
};

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
    supabase
      .from('panama_district_indicators')
      .select(
        'cod_dist,nomb_dist,nomb_prov,age_group,friction,pop_total,pop_le15,pop_le30,pop_le60,pop_nodata,pct_le15,pct_le30,pct_le60'
      )
      .eq('pop_source', 'worldpop')
      .eq('friction_source', 'map')
      .in('friction', ['walking', 'motorized'])
      .then(({ data, error }) => {
        if (error || !data) {
          console.error('Failed to load indicators:', error);
          return;
        }

        const grouped: Record<TransportMode, IndicatorsByDist> = {
          walking: {},
          motorized: {},
        };

        for (const rawRow of data as ScenarioRow[]) {
          const typedRow: IndicatorRow = {
            ...rawRow,
            data_completeness_pct:
              rawRow.pop_total > 0
                ? Number(
                    (((rawRow.pop_total - rawRow.pop_nodata) / rawRow.pop_total) * 100).toFixed(1)
                  )
                : 0,
          };

          if (!grouped[rawRow.friction][typedRow.cod_dist]) {
            grouped[rawRow.friction][typedRow.cod_dist] = {};
          }
          grouped[rawRow.friction][typedRow.cod_dist][typedRow.age_group] = typedRow;
        }

        setIndicatorsByTransport(grouped);
        setIsLoading(false);
      });
  }, []);

  const indicators = indicatorsByTransport[selectedTransport] ?? {};

  const top5Worst = useMemo<IndicatorRow[]>(() => {
    const rows = Object.values(indicators)
      .map((district) => district[selectedAgeGroup])
      .filter((row): row is IndicatorRow => row !== undefined)
      .filter((row) => row.data_completeness_pct > 0);

    return rows.sort((a, b) => a.pct_le30 - b.pct_le30).slice(0, 5);
  }, [indicators, selectedAgeGroup]);

  const highlightedDists = useMemo(() => {
    if (chatHighlights.length > 0) return chatHighlights;
    return top5Worst.map((row) => row.cod_dist);
  }, [chatHighlights, top5Worst]);

  const distIndicators = selectedDist ? (indicators[selectedDist] ?? null) : null;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function ask(q: string) {
    if (!q.trim() || isAsking) return;

    setIsAsking(true);
    setQuestion('');
    setMessages((current) => [...current, { role: 'user', question: q }]);

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setMessages((current) => [
          ...current,
          { role: 'assistant', error: data.error ?? 'Unknown error.' },
        ]);
      } else {
        setMessages((current) => [
          ...current,
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
      setMessages((current) => [
        ...current,
        { role: 'assistant', error: 'Network error. Try again.' },
      ]);
    } finally {
      setIsAsking(false);
    }
  }

  return (
    <div className="flex h-full flex-col md:flex-row">
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

      <aside className="flex flex-col overflow-hidden border-t border-neutral-200 bg-white md:basis-[35%] md:border-l md:border-t-0">
        <div className="shrink-0 border-b border-neutral-100 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
                EduAccess LAC
              </h1>
              <p className="mt-0.5 text-xs text-neutral-400">Panama preview</p>
            </div>
            <Link
              href="/"
              className="rounded-full border border-neutral-200 px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-800"
            >
              Home
            </Link>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <IndicatorPanel
            isLoading={isLoading}
            top5Worst={top5Worst}
            selectedDist={selectedDist}
            distIndicators={distIndicators}
            selectedTransport={selectedTransport}
            selectedAgeGroup={selectedAgeGroup}
            onTransportChange={setSelectedTransport}
            onAgeGroupChange={setSelectedAgeGroup}
            onSelectDist={(cod) => {
              setSelectedDist(cod);
              setChatHighlights([]);
            }}
            onClearSelection={() => setSelectedDist(null)}
          />
        </div>

        <div className="flex max-h-[45vh] shrink-0 flex-col border-t border-neutral-200 bg-white">
          {messages.length === 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pb-2 pt-3">
              {SEEDED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => ask(prompt)}
                  disabled={isAsking}
                  className="rounded-full border border-neutral-200 px-2.5 py-1 text-left text-xs text-neutral-600 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
                >
                  {prompt}
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
            onSubmit={(e) => {
              e.preventDefault();
              ask(question);
            }}
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

        <div className="shrink-0 border-t border-neutral-100 px-5 py-2">
          <p className="text-xs text-neutral-400">
            Data: IDB Accessibility Platform - v1 preview - 2026
          </p>
        </div>
      </aside>
    </div>
  );
}

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
                {msg.columns?.map((column) => (
                  <th
                    key={column}
                    className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-neutral-500"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {msg.rows.map((row, i) => (
                <tr key={i} className="border-t border-neutral-100 hover:bg-neutral-50">
                  {msg.columns?.map((column) => (
                    <td
                      key={column}
                      className="whitespace-nowrap px-2 py-1.5 text-neutral-700"
                    >
                      {String(row[column] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {msg.rows?.length === 0 && <p className="text-xs text-neutral-400">No results found.</p>}

      {msg.sql && (
        <div>
          <button
            onClick={() => setShowSql((current) => !current)}
            className="text-xs text-neutral-400 hover:text-neutral-600"
          >
            {showSql ? 'Hide SQL' : 'Show SQL'}
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
