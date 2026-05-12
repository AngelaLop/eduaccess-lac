'use client';

/**
 * SimulationPanel — side-panel UI for the inequality-in-motion simulation.
 *
 * Two synchronized views: the choropleth on the main map (handled by
 * PanamaMap) and three "kid tracks" rendered here. Same simulated clock
 * drives both. Tracks let a viewer feel three districts at once:
 * the worst, the median, and the best by pct_le30.
 *
 * Each kid's position along the track at simMin t is the district's
 * cumulative "% reached at t" — interpolated linearly through 0, 15, 30,
 * 60. By design, at simMin=30 the kid position equals the static
 * pct_le30 number shown elsewhere on the platform.
 */

import { useMemo } from 'react';
import type { AgeGroup, IndicatorRow, IndicatorsByDist, TransportMode } from '@/lib/types';
import { AGE_GROUP_NARRATIVE, TRANSPORT_LABELS } from '@/lib/types';

interface Props {
  indicators: IndicatorsByDist;
  ageGroup: AgeGroup;
  transport: TransportMode;
  simMin: number;            // 0-60
  isPlaying: boolean;
  isFinished: boolean;
  onPlay: () => void;
  onPause: () => void;
  onReplay: () => void;
}

const SIM_MINUTES = 60;

function formatClock(simMin: number): string {
  const whole = Math.floor(simMin);
  const frac = simMin - whole;
  const seconds = Math.floor(frac * 60);
  return `${String(whole).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function pctArrivedAt(t: number, r: IndicatorRow): number {
  if (t <= 0) return 0;
  if (t <= 15) return (t / 15) * r.pct_le15;
  if (t <= 30) return r.pct_le15 + ((t - 15) / 15) * (r.pct_le30 - r.pct_le15);
  if (t <= 60) return r.pct_le30 + ((t - 30) / 30) * (r.pct_le60 - r.pct_le30);
  return r.pct_le60;
}

interface Representative {
  row: IndicatorRow;
  label: string;          // descriptive header ("Hardest", "Typical", "Easiest")
  description: string;    // 1-line context for this district at finish
}

function pickRepresentatives(
  indicators: IndicatorsByDist,
  ageGroup: AgeGroup
): Representative[] {
  const rows: IndicatorRow[] = [];
  for (const byAge of Object.values(indicators)) {
    const r = byAge[ageGroup];
    if (r && r.data_completeness_pct > 0) rows.push(r);
  }
  if (rows.length < 3) return [];
  rows.sort((a, b) => a.pct_le30 - b.pct_le30);

  // Worst — first non-zero pct_le30 so the demo never opens with a fully
  // empty track. If everything is zero, just take the first.
  const worst =
    rows.find((r) => r.pct_le30 > 0 && r.pct_le30 < 30) ?? rows[0];
  const best = rows[rows.length - 1];
  const median = rows[Math.floor(rows.length / 2)];

  return [
    {
      row: worst,
      label: 'Hardest',
      description: `${worst.pct_le30.toFixed(0)}% reach a school within 30 min`,
    },
    {
      row: median,
      label: 'Typical',
      description: `${median.pct_le30.toFixed(0)}% reach a school within 30 min`,
    },
    {
      row: best,
      label: 'Easiest',
      description: `${best.pct_le30.toFixed(0)}% reach a school within 30 min`,
    },
  ];
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
  // Kid sits at "pct% of the way." School icon is at the end.
  // If the kid never reaches 100% AND we're at the end → mark them stuck.
  const reached = pct >= 99 && rep.row.pct_le60 >= 99;
  const stuck = isFinished && rep.row.pct_le60 < 99;
  const kidColor = reached
    ? 'bg-emerald-600'
    : stuck
    ? 'bg-red-500'
    : 'bg-amber-500';

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <div className="min-w-0 truncate">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
            {rep.label}
          </span>
          <span className="ml-1.5 text-xs font-medium text-neutral-800">
            {rep.row.nomb_dist}
          </span>
          <span className="ml-1 text-[10px] text-neutral-400">{rep.row.nomb_prov}</span>
        </div>
        <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-600">
          {Math.round(pct)}%
        </span>
      </div>

      <div className="relative flex items-center">
        {/* Track line */}
        <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-100">
          {/* Filled portion */}
          <div
            className={`absolute inset-y-0 left-0 ${
              reached
                ? 'bg-emerald-600'
                : stuck
                ? 'bg-red-300'
                : 'bg-amber-300'
            } transition-[width] duration-100 ease-linear`}
            style={{ width: `${pct}%` }}
          />
          {/* Kid marker */}
          <div
            className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-sm ${kidColor} transition-[left] duration-100 ease-linear`}
            style={{ left: `${pct}%` }}
            aria-hidden
          />
        </div>
        {/* School icon */}
        <span className="ml-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-neutral-700 text-[10px] font-bold text-white">
          🏫
        </span>
      </div>

      <p className="mt-1 text-[10px] leading-snug text-neutral-500">
        {rep.description}
      </p>
    </div>
  );
}

export default function SimulationPanel({
  indicators,
  ageGroup,
  transport,
  simMin,
  isPlaying,
  isFinished,
  onPlay,
  onPause,
  onReplay,
}: Props) {
  const narrative = AGE_GROUP_NARRATIVE[ageGroup];
  const mode = TRANSPORT_LABELS[transport].toLowerCase();
  const clock = formatClock(simMin);

  const representatives = useMemo(
    () => pickRepresentatives(indicators, ageGroup),
    [indicators, ageGroup]
  );

  // Aggregate stats across all districts with data, at current simMin
  const aggregate = useMemo(() => {
    let totalPop = 0;
    let arrived = 0;
    for (const byAge of Object.values(indicators)) {
      const r = byAge[ageGroup];
      if (!r || r.data_completeness_pct === 0) continue;
      totalPop += r.pop_total;
      arrived += (pctArrivedAt(simMin, r) / 100) * r.pop_total;
    }
    return {
      arrivedPct: totalPop > 0 ? Math.round((arrived / totalPop) * 100) : 0,
      remainingCount: Math.max(0, Math.round(totalPop - arrived)),
    };
  }, [indicators, ageGroup, simMin]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Inequality in motion
        </p>
        <p className="mt-1 text-sm leading-snug text-neutral-600">
          Watch where {narrative} reach a school as the clock runs. The map
          fills with the same colors you see on the Insight tab — but
          unfolding through 60 simulated minutes of {mode}.
        </p>
      </div>

      {/* Digital clock */}
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-center">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
          Simulated time
        </p>
        <p className="mt-1 font-mono text-4xl font-bold tabular-nums text-neutral-900">
          {clock}
        </p>
        <p className="mt-0.5 text-[11px] text-neutral-500">
          of 60:00 ({isFinished ? 'finished' : isPlaying ? 'running' : 'paused'})
        </p>
      </div>

      {/* Kid tracks */}
      {representatives.length === 3 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            Three children, three districts
          </p>
          <div className="flex flex-col gap-3 rounded-md border border-neutral-200 bg-white p-3">
            {representatives.map((rep) => (
              <KidTrack
                key={rep.row.cod_dist}
                rep={rep}
                simMin={simMin}
                isFinished={isFinished}
              />
            ))}
          </div>
        </div>
      )}

      {/* Aggregate counter */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md bg-emerald-50 p-3">
          <p className="text-[11px] text-emerald-700">Reached a school</p>
          <p className="mt-0.5 text-xl font-bold tabular-nums text-emerald-800">
            {aggregate.arrivedPct}%
          </p>
        </div>
        <div className="rounded-md bg-amber-50 p-3">
          <p className="text-[11px] text-amber-700">Still walking</p>
          <p className="mt-0.5 text-xl font-bold tabular-nums text-amber-800">
            {aggregate.remainingCount.toLocaleString()}
          </p>
          <p className="text-[10px] text-amber-700/70">{narrative}</p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2">
        {!isPlaying && !isFinished && (
          <button
            onClick={onPlay}
            className="flex-1 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-800"
          >
            ▶ Play
          </button>
        )}
        {isPlaying && (
          <button
            onClick={onPause}
            className="flex-1 rounded-md bg-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-300"
          >
            ❚❚ Pause
          </button>
        )}
        {isFinished && (
          <button
            onClick={onReplay}
            className="flex-1 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-800"
          >
            ↻ Replay
          </button>
        )}
        {!isFinished && simMin > 0 && (
          <button
            onClick={onReplay}
            className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-600 transition-colors hover:bg-neutral-50"
            title="Reset and play from the start"
          >
            ↻
          </button>
        )}
      </div>

      <p className="text-[11px] leading-snug text-neutral-500">
        10 seconds of wall-clock = 60 simulated minutes. At the end, any
        district still showing amber or red on the map (or any kid not yet at
        the school icon) is one the system failed.
      </p>
    </div>
  );
}
