'use client';

import { useState } from 'react';
import type { AgeGroup, DistrictIndicators, IndicatorRow } from '@/lib/types';
import { AGE_GROUP_LABELS } from '@/lib/types';

const AGE_GROUPS: AgeGroup[] = ['all', 'primary', 'secondary', 'highschool'];

// ── Robustness card ──────────────────────────────────────────────────────────

function RobustnessCard({ row }: { row: IndicatorRow }) {
  return (
    <section className="mt-4 rounded-md border border-neutral-200 p-4 text-sm">
      <h3 className="font-semibold text-neutral-800">How much can we trust this?</h3>
      <ul className="mt-2 space-y-1 text-neutral-700">
        <li>
          Data completeness:{' '}
          <strong>{row.data_completeness_pct}%</strong>
          <span className="text-xs text-neutral-500">
            {' '}
            ({row.pop_nodata.toLocaleString()} of {row.pop_total.toLocaleString()} people lack
            travel-time data)
          </span>
        </li>
        <li>
          Population source: <strong>WorldPop 2023</strong>
          <span className="text-xs text-neutral-500"> (1 km raster, age-binned)</span>
        </li>
        <li>
          Friction surface: <strong>MAP (Weiss et al. 2020)</strong>
          <span className="text-xs text-neutral-500"> — globally validated</span>
        </li>
        <li>Travel-time model: Fast Marching Method on 1 km grid</li>
      </ul>
      <p className="mt-2 text-xs text-neutral-500">
        Source: IDB Accessibility Platform, Panama pilot (3,617 schools, MPCS thesis 2026). A
        full Robustness Auditor agent ships in v3.
      </p>
    </section>
  );
}

// ── District detail view ─────────────────────────────────────────────────────

function DistrictDetail({
  distIndicators,
  onBack,
}: {
  distIndicators: DistrictIndicators;
  onBack: () => void;
}) {
  const [activeGroup, setActiveGroup] = useState<AgeGroup>('highschool');
  const row = distIndicators[activeGroup];
  const hsRow = distIndicators.highschool;

  if (!hsRow) return <p className="p-4 text-sm text-neutral-500">No data for this district.</p>;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div>
        <button
          onClick={onBack}
          className="mb-2 text-xs text-neutral-500 hover:text-neutral-700 flex items-center gap-1"
        >
          ← All districts
        </button>
        <h2 className="text-xl font-bold text-neutral-900">{hsRow.nomb_dist}</h2>
        <p className="text-sm text-neutral-500">{hsRow.nomb_prov} Province</p>
      </div>

      {/* Age-group toggle */}
      <div className="flex gap-1 flex-wrap">
        {AGE_GROUPS.map((g) => (
          <button
            key={g}
            onClick={() => setActiveGroup(g)}
            className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
              activeGroup === g
                ? 'bg-emerald-700 text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            {g === 'all' ? 'All' : g === 'primary' ? 'Primary' : g === 'secondary' ? 'Secondary' : 'High school'}
          </button>
        ))}
      </div>

      {row ? (
        <>
          {/* Hero metric */}
          <div className="rounded-lg bg-emerald-50 p-4 text-center">
            <p className="text-4xl font-bold text-emerald-800">{row.pct_le30.toFixed(1)}%</p>
            <p className="mt-1 text-sm text-emerald-700">
              of {AGE_GROUP_LABELS[activeGroup].toLowerCase()} within 30 min walk of a school
            </p>
          </div>

          {/* Secondary grid */}
          <div className="grid grid-cols-2 gap-2 text-sm">
            <Stat label="Within 15 min" value={`${row.pct_le15.toFixed(1)}%`} />
            <Stat label="Within 60 min" value={`${row.pct_le60.toFixed(1)}%`} />
            <Stat label="Population" value={row.pop_total.toLocaleString()} />
            <Stat label="Reachable in 30 min" value={row.pop_le30.toLocaleString()} />
          </div>

          <RobustnessCard row={row} />
        </>
      ) : (
        <p className="text-sm text-neutral-500">No data for this age group.</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-neutral-50 p-3">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-neutral-900">{value}</p>
    </div>
  );
}

// ── Default view: Top 5 worst ────────────────────────────────────────────────

function DefaultView({
  top5,
  onSelectDist,
}: {
  top5: IndicatorRow[];
  onSelectDist: (cod: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-bold text-neutral-900">Panama School Access</h2>
        <p className="text-sm text-neutral-500 mt-0.5">
          Walking access to nearest school, by district
        </p>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-1 text-xs text-neutral-500">
        <span>Worse</span>
        {['#7f1d1d', '#dc2626', '#f97316', '#eab308', '#16a34a'].map((c) => (
          <span key={c} className="inline-block h-3 w-6 rounded-sm" style={{ background: c }} />
        ))}
        <span>Better</span>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400 mb-2">
          Worst high-school walking access
        </p>
        <ol className="space-y-2">
          {top5.map((row, i) => (
            <li key={row.cod_dist}>
              <button
                onClick={() => onSelectDist(row.cod_dist)}
                className="w-full text-left rounded-md border border-neutral-200 p-3 hover:bg-neutral-50 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-neutral-400 mr-2">{i + 1}.</span>
                    <span className="font-medium text-neutral-800">{row.nomb_dist}</span>
                    <span className="text-xs text-neutral-500 ml-1">{row.nomb_prov}</span>
                  </div>
                  <span className="text-sm font-bold text-red-700">
                    {row.pct_le30.toFixed(1)}%
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ol>
      </div>

      <p className="text-xs text-neutral-400">
        Click any district on the map to see its full indicator breakdown.
      </p>
    </div>
  );
}

// ── Public component ─────────────────────────────────────────────────────────

interface Props {
  top5Worst: IndicatorRow[];
  selectedDist: string | null;
  distIndicators: DistrictIndicators | null;
  onSelectDist: (cod: string) => void;
  onClearSelection: () => void;
}

export default function IndicatorPanel({
  top5Worst,
  selectedDist,
  distIndicators,
  onSelectDist,
  onClearSelection,
}: Props) {
  if (selectedDist && distIndicators) {
    return (
      <DistrictDetail distIndicators={distIndicators} onBack={onClearSelection} />
    );
  }

  if (top5Worst.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-neutral-400">
        Loading indicators…
      </div>
    );
  }

  return <DefaultView top5={top5Worst} onSelectDist={onSelectDist} />;
}
