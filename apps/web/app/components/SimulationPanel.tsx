'use client';

/**
 * SimulationPanel — side-panel UI for the inequality-in-motion simulation.
 *
 * Two synchronized views: the choropleth on the main map (handled by
 * CountryMap) and three "kid tracks" rendered here. Same simulated clock
 * drives both. Tracks let a viewer feel three districts at once:
 * the worst, the median, and the best by pct_le30.
 *
 * Each kid's position along the track at simMin t is the district's
 * cumulative "% reached at t" — interpolated linearly through 0, 15, 30, 60.
 */

import { useMemo } from 'react';
import type { EducationLevel, IndicatorRow, IndicatorsByDist, TransportMode } from '@/lib/types';
import { EDUCATION_LEVEL_NARRATIVE, TRANSPORT_LABELS } from '@/lib/types';

interface Props {
  indicators: IndicatorsByDist;
  level: EducationLevel;
  transport: TransportMode;
  simMin: number;            // 0-60
  isPlaying: boolean;
  isFinished: boolean;
  onPlay: () => void;
  onPause: () => void;
  onReplay: () => void;
}

function formatClock(simMin: number): string {
  const whole = Math.floor(simMin);
  const frac = simMin - whole;
  const seconds = Math.floor(frac * 60);
  return `${String(whole).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function pctArrivedAt(t: number, r: IndicatorRow): number {
  const le15 = r.pct_le15 ?? 0;
  const le30 = r.pct_le30 ?? 0;
  const le60 = r.pct_le60 ?? 0;
  if (t <= 0) return 0;
  if (t <= 15) return (t / 15) * le15;
  if (t <= 30) return le15 + ((t - 15) / 15) * (le30 - le15);
  if (t <= 60) return le30 + ((t - 30) / 30) * (le60 - le30);
  return le60;
}

export interface Representative {
  row: IndicatorRow;
  label: string;
}

export function pickRepresentatives(
  indicators: IndicatorsByDist,
  level: EducationLevel
): Representative[] {
  const rows: IndicatorRow[] = [];
  for (const byLevel of Object.values(indicators)) {
    const r = byLevel[level];
    if (r && r.pop_total > 0) rows.push(r);
  }
  if (rows.length < 3) return [];
  rows.sort((a, b) => (a.pct_le30 ?? 0) - (b.pct_le30 ?? 0));

  const worst =
    rows.find((r) => (r.pct_le30 ?? 0) > 0 && (r.pct_le30 ?? 0) < 30) ?? rows[0];
  const best = rows[rows.length - 1];
  const median = rows[Math.floor(rows.length / 2)];

  return [
    { row: worst, label: 'Hardest' },
    { row: median, label: 'Typical' },
    { row: best, label: 'Easiest' },
  ];
}

// Plain SVG controls — Unicode glyphs (▶ ❚❚ ↻ 🏫) render as colour emoji on
// mobile; these stay identical on every platform.
function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

function ReplayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

function SchoolIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M3 21h18" />
      <path d="M6 21V9l6-4 6 4v12" />
      <path d="M10 21v-4h4v4" />
    </svg>
  );
}

function KidTrack({
  rep,
  simMin,
  isFinished,
}: {
  rep: Representative;
  simMin: number;
  isFinished: boolean;
}) {
  const pct = pctArrivedAt(simMin, rep.row);
  const reached = pct >= 99;
  const stuck = isFinished && (rep.row.pct_le60 ?? 0) < 99 && !reached;
  const kidColor = reached ? 'bg-emerald-600' : stuck ? 'bg-red-500' : 'bg-amber-500';
  const fillColor = reached ? 'bg-emerald-500' : stuck ? 'bg-red-300' : 'bg-amber-300';

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <div className="min-w-0 truncate">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
            {rep.label}
          </span>
          <span className="ml-1.5 text-xs font-medium text-neutral-800">
            {rep.row.admin2_name}
          </span>
          <span className="ml-1 text-[10px] text-neutral-400">{rep.row.admin1_name}</span>
        </div>
        <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-700">
          {Math.round(pct)}%
        </span>
      </div>

      <div className="relative flex items-center">
        <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-neutral-100">
          <div
            className={`absolute top-0 bottom-0 left-0 ${fillColor}`}
            style={{ width: `${pct}%` }}
          />
          <div
            className={`absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ${kidColor}`}
            style={{ left: `${pct}%` }}
            aria-hidden
          />
        </div>
        <span
          className="ml-2 inline-flex h-5 w-5 shrink-0 items-center justify-center text-neutral-700"
          aria-hidden
        >
          <SchoolIcon />
        </span>
      </div>
    </div>
  );
}

export default function SimulationPanel({
  indicators,
  level,
  transport,
  simMin,
  isPlaying,
  isFinished,
  onPlay,
  onPause,
  onReplay,
}: Props) {
  const narrative = EDUCATION_LEVEL_NARRATIVE[level];
  const mode = TRANSPORT_LABELS[transport].toLowerCase();
  const clock = formatClock(simMin);

  const representatives = useMemo(
    () => pickRepresentatives(indicators, level),
    [indicators, level]
  );

  const aggregate = useMemo(() => {
    let totalPop = 0;
    let arrived = 0;
    for (const byLevel of Object.values(indicators)) {
      const r = byLevel[level];
      if (!r || r.pop_total <= 0) continue;
      totalPop += r.pop_total;
      arrived += (pctArrivedAt(simMin, r) / 100) * r.pop_total;
    }
    return {
      arrivedPct: totalPop > 0 ? Math.round((arrived / totalPop) * 100) : 0,
      remainingCount: Math.max(0, Math.round(totalPop - arrived)),
    };
  }, [indicators, level, simMin]);

  const statusLabel = isFinished ? 'finished' : isPlaying ? 'running' : 'paused';

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Inequality in motion
        </p>
        <p className="mt-1 text-[11px] leading-snug text-neutral-500">
          Watch the map heat up over 60 simulated minutes of {mode}.
        </p>
      </div>

      <div className="rounded-lg bg-neutral-50 p-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
              Simulated time
            </p>
            <p className="mt-0.5 font-mono text-2xl font-bold leading-none tabular-nums text-neutral-900 sm:text-3xl">
              {clock}
              <span className="ml-1.5 align-baseline text-sm font-normal text-neutral-400">
                / 60:00
              </span>
            </p>
            <p className="mt-0.5 text-[10px] text-neutral-500">{statusLabel}</p>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {!isPlaying && !isFinished && (
              <button
                onClick={onPlay}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-800"
                aria-label="Play simulation"
              >
                <PlayIcon /> Play
              </button>
            )}
            {isPlaying && (
              <button
                onClick={onPause}
                className="inline-flex items-center gap-1.5 rounded-md bg-neutral-200 px-3 py-2 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-300"
                aria-label="Pause simulation"
              >
                <PauseIcon /> Pause
              </button>
            )}
            {isFinished && (
              <button
                onClick={onReplay}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-800"
                aria-label="Replay simulation"
              >
                <ReplayIcon /> Replay
              </button>
            )}
            {!isFinished && simMin > 0 && (
              <button
                onClick={onReplay}
                className="inline-flex items-center justify-center rounded-md border border-neutral-100 bg-white px-2 py-2 text-neutral-600 transition-colors hover:bg-neutral-50"
                title="Reset and play from the start"
                aria-label="Reset and play from the start"
              >
                <ReplayIcon />
              </button>
            )}
          </div>
        </div>
      </div>

      {representatives.length === 3 && (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            Three children, three districts
          </p>
          <p className="mb-2 text-[11px] leading-snug text-neutral-500">
            The number on each track is the share of {narrative} in that
            district who have reached a school by the current simulated
            minute. Each track is a different district sampled from the
            hardest, the typical, and the easiest.
          </p>
          <div className="flex flex-col gap-3 rounded-md border border-neutral-100 bg-white p-3">
            {representatives.map((rep) => (
              <KidTrack
                key={rep.row.admin2_pcode}
                rep={rep}
                simMin={simMin}
                isFinished={isFinished}
              />
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md bg-neutral-50 p-3">
          <p className="text-[11px] text-neutral-500">Reached a school</p>
          <p className="mt-0.5 text-xl font-bold tabular-nums text-emerald-700">
            {aggregate.arrivedPct}%
          </p>
        </div>
        <div className="rounded-md bg-neutral-50 p-3">
          <p className="text-[11px] text-neutral-500">Still walking</p>
          <p className="mt-0.5 text-xl font-bold tabular-nums text-amber-700">
            {aggregate.remainingCount.toLocaleString()}
          </p>
          <p className="text-[10px] text-neutral-400">{narrative}</p>
        </div>
      </div>

      <p className="text-[11px] leading-snug text-neutral-500">
        20 seconds of wall-clock = 60 simulated minutes. At the end, any
        district still showing amber or red on the map (or any kid not yet at
        the school icon) is one the system failed.
      </p>
    </div>
  );
}
