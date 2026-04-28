'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { supabase } from '@/lib/supabase';
import IndicatorPanel from './IndicatorPanel';
import type { AgeGroup, IndicatorRow, IndicatorsByDist } from '@/lib/types';

const PanamaMap = dynamic(() => import('./PanamaMap'), { ssr: false });

// ── seeded prompts ────────────────────────────────────────────────────────────

const SEEDED_PROMPTS = [
  "Top 5 districts with the worst walking access for high schoolers",
  "Which districts have over 1,000 high schoolers more than 30 minutes from a school?",
  "Show districts where over 20% of school-age population lacks travel-time data",
  "Compare primary vs high school walking access in the districts of Panama province",
  "Rank provinces by their average % of population within 15 minutes of a school",
] as const;

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

// ── component ─────────────────────────────────────────────────────────────────

export default function AppShell() {
  const [indicators, setIndicators] = useState<IndicatorsByDist>({});
  const [selectedDist, setSelectedDist] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  const [chatHighlights, setChatHighlights] = useState<string[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Load all canonical indicators on mount
  useEffect(() => {
    supabase
      .from('v_panama_indicators')
      .select('*')
      .then(({ data, error }) => {
        if (error || !data) { console.error('Failed to load indicators:', error); return; }
        const byDist: IndicatorsByDist = {};
        for (const row of data as IndicatorRow[]) {
          if (!byDist[row.cod_dist]) byDist[row.cod_dist] = {};
          byDist[row.cod_dist][row.age_group as AgeGroup] = row;
        }
        setIndicators(byDist);
        setIsLoading(false);
      });
  }, []);

  const top5Worst = useMemo<IndicatorRow[]>(() => {
    const hsRows = Object.values(indicators)
      .map((d) => d.highschool)
      .filter((r): r is IndicatorRow => r !== undefined);
    return hsRows.sort((a, b) => a.pct_le30 - b.pct_le30).slice(0, 5);
  }, [indicators]);

  // Map highlights: chat results override top-5 default
  const highlightedDists = chatHighlights.length > 0
    ? chatHighlights
    : top5Worst.map((r) => r.cod_dist);

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
        setMessages((m) => [...m, {
          role: 'assistant',
          sql: data.sql,
          columns: data.columns,
          rows: data.rows,
          narrative: data.narrative,
        }]);
        if (data.highlightCodDist?.length) {
          setChatHighlights(data.highlightCodDist);
          setSelectedDist(null); // clear district selection so highlights show
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
      {/* Map */}
      <div className="relative flex-1 md:basis-[65%] min-h-[50vh] md:min-h-0">
        {isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-100">
            <p className="text-sm text-neutral-500 animate-pulse">Loading map data…</p>
          </div>
        )}
        <PanamaMap
          indicators={indicators}
          highlightedDists={highlightedDists}
          selectedDist={selectedDist}
          onDistrictClick={(cod) => { setSelectedDist(cod); setChatHighlights([]); }}
        />
      </div>

      {/* Side panel */}
      <aside className="md:basis-[35%] border-t md:border-t-0 md:border-l border-neutral-200 bg-white flex flex-col overflow-hidden">
        {/* Header */}
        <div className="shrink-0 border-b border-neutral-100 px-5 py-4">
          <h1 className="text-sm font-semibold tracking-wide text-emerald-700 uppercase">
            EduAccess LAC
          </h1>
          <p className="text-xs text-neutral-400 mt-0.5">Panama · preview</p>
        </div>

        {/* Indicator panel — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
          <IndicatorPanel
            top5Worst={top5Worst}
            selectedDist={selectedDist}
            distIndicators={distIndicators}
            onSelectDist={(cod) => { setSelectedDist(cod); setChatHighlights([]); }}
            onClearSelection={() => setSelectedDist(null)}
          />
        </div>

        {/* Chat section */}
        <div className="shrink-0 border-t border-neutral-200 flex flex-col bg-white max-h-[45vh]">

          {/* Seeded prompt buttons */}
          {messages.length === 0 && (
            <div className="px-4 pt-3 pb-2 flex flex-wrap gap-1.5">
              {SEEDED_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => ask(p)}
                  disabled={isAsking}
                  className="rounded-full border border-neutral-200 px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-50 hover:border-neutral-300 transition-colors text-left"
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          {/* Message thread */}
          {messages.length > 0 && (
            <div className="overflow-y-auto px-4 py-2 flex flex-col gap-3 flex-1">
              {messages.map((msg, i) => (
                <ChatBubble key={i} msg={msg} />
              ))}
              {isAsking && (
                <p className="text-xs text-neutral-400 animate-pulse">Thinking…</p>
              )}
              <div ref={chatEndRef} />
            </div>
          )}

          {/* Input */}
          <form
            onSubmit={(e) => { e.preventDefault(); ask(question); }}
            className="flex gap-2 px-4 py-3 border-t border-neutral-100"
          >
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask about school access in Panama…"
              disabled={isAsking}
              className="flex-1 rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-200 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isAsking || !question.trim()}
              className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-40 transition-colors"
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
      {msg.narrative && (
        <p className="text-sm text-neutral-700">{msg.narrative}</p>
      )}

      {msg.rows && msg.rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-neutral-200">
          <table className="w-full text-xs">
            <thead className="bg-neutral-50">
              <tr>
                {msg.columns?.map((c) => (
                  <th key={c} className="px-2 py-1.5 text-left font-medium text-neutral-500 whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {msg.rows.map((row, i) => (
                <tr key={i} className="border-t border-neutral-100 hover:bg-neutral-50">
                  {msg.columns?.map((c) => (
                    <td key={c} className="px-2 py-1.5 text-neutral-700 whitespace-nowrap">
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

      {/* Collapsible SQL — transparency per architecture rule */}
      {msg.sql && (
        <div>
          <button
            onClick={() => setShowSql((s) => !s)}
            className="text-xs text-neutral-400 hover:text-neutral-600"
          >
            {showSql ? '▲ Hide SQL' : '▼ Show SQL'}
          </button>
          {showSql && (
            <pre className="mt-1 overflow-x-auto rounded-md bg-neutral-50 p-2 text-xs text-neutral-600 border border-neutral-200">
              {msg.sql}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
