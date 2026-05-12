'use client';

/**
 * SimulationPanel — side-panel UI for the inequality-in-motion simulation.
 *
 * The actual dots + map animation lives in PanamaMap (so it overlays the same
 * basemap users already know). This panel only shows the clock, captions, and
 * play controls. It mirrors the platform's white-and-emerald visual language.
 */

import type { AgeGroup, TransportMode } from '@/lib/types';
import { AGE_GROUP_NARRATIVE, TRANSPORT_LABELS } from '@/lib/types';

export interface SimulationStatus {
  simMin: number;          // 0-60
  arrivedPct: number;      // 0-100
  isPlaying: boolean;
  isFinished: boolean;
}

interface Props {
  status: SimulationStatus;
  ageGroup: AgeGroup;
  transport: TransportMode;
  onPlay: () => void;
  onPause: () => void;
  onReplay: () => void;
}

const SIM_MINUTES = 60;

function formatClock(simMin: number): string {
  // Show as MM:SS where SS is the fractional minute mapped to 60 seconds —
  // gives a smooth-ticking clock the eye latches onto, even though the
  // underlying value is simulated minutes only.
  const whole = Math.floor(simMin);
  const frac = simMin - whole;
  const seconds = Math.floor(frac * 60);
  return `${String(whole).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export default function SimulationPanel({
  status,
  ageGroup,
  transport,
  onPlay,
  onPause,
  onReplay,
}: Props) {
  const narrative = AGE_GROUP_NARRATIVE[ageGroup];
  const mode = TRANSPORT_LABELS[transport].toLowerCase();
  const progressPct = (status.simMin / SIM_MINUTES) * 100;
  const clock = formatClock(status.simMin);
  const stillMoving = 100 - status.arrivedPct;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Inequality in motion
        </p>
        <p className="mt-1 text-sm leading-snug text-neutral-600">
          Each dot is a child {mode}. As the clock runs, dots turn{' '}
          <span className="font-medium text-emerald-700">green</span> when they
          reach a school. Dots still moving at 60 minutes are the ones the
          system fails.
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
          of 60:00 ({status.isFinished ? 'finished' : status.isPlaying ? 'running' : 'paused'})
        </p>
      </div>

      {/* Progress bar with 15/30 ticks */}
      <div>
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
          <div
            className="absolute inset-y-0 left-0 bg-emerald-600 transition-[width] duration-100 ease-linear"
            style={{ width: `${progressPct}%` }}
          />
          {[15, 30].map((mark) => (
            <div
              key={mark}
              className="absolute inset-y-0 w-px bg-neutral-300"
              style={{ left: `${(mark / SIM_MINUTES) * 100}%` }}
              aria-hidden
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-neutral-400">
          <span>0 min</span>
          <span>15</span>
          <span>30</span>
          <span>60 min</span>
        </div>
      </div>

      {/* Status stats */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md bg-emerald-50 p-3">
          <p className="text-xs text-emerald-700">Reached a school</p>
          <p className="mt-0.5 text-2xl font-bold text-emerald-800">{status.arrivedPct}%</p>
        </div>
        <div className="rounded-md bg-amber-50 p-3">
          <p className="text-xs text-amber-700">Still {mode}</p>
          <p className="mt-0.5 text-2xl font-bold text-amber-800">{stillMoving}%</p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2">
        {!status.isPlaying && !status.isFinished && (
          <button
            onClick={onPlay}
            className="flex-1 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-800"
          >
            ▶ Play
          </button>
        )}
        {status.isPlaying && (
          <button
            onClick={onPause}
            className="flex-1 rounded-md bg-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-300"
          >
            ❚❚ Pause
          </button>
        )}
        {status.isFinished && (
          <button
            onClick={onReplay}
            className="flex-1 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-800"
          >
            ↻ Replay
          </button>
        )}
        {!status.isFinished && (
          <button
            onClick={onReplay}
            className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-600 transition-colors hover:bg-neutral-50"
            title="Reset and replay"
          >
            ↻
          </button>
        )}
      </div>

      <p className="text-[11px] leading-snug text-neutral-500">
        10 seconds of wall-clock = 60 simulated minutes of {mode}. Speed is the
        same for every {narrative.replace(/s$/, '')}; the differences you see
        are how far each child has to go.
      </p>
    </div>
  );
}
