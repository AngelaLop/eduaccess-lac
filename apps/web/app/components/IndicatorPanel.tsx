'use client';

import { useEffect, useState } from 'react';
import type { AgeGroup, DistrictIndicators, IndicatorRow, TransportMode } from '@/lib/types';
import {
  AGE_GROUP_LABELS,
  AGE_GROUP_SHORT_LABELS,
  AGE_GROUPS,
  TRANSPORT_LABELS,
} from '@/lib/types';

// ── sub-components ────────────────────────────────────────────────────────────

function RobustnessCard({ row }: { row: IndicatorRow }) {
  return (
    <section className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs">
      <p className="mb-2 font-semibold text-neutral-700">How much can we trust this?</p>
      <ul className="space-y-1 text-neutral-600">
        <li>
          Data completeness:{' '}
          <strong className="text-neutral-800">{row.data_completeness_pct}%</strong>
          <span className="text-neutral-400">
            {' '}({row.pop_nodata.toLocaleString()} of {row.pop_total.toLocaleString()} lack
            travel-time data)
          </span>
        </li>
        <li>
          Population source: <strong className="text-neutral-800">WorldPop 2023</strong>
          <span className="text-neutral-400"> (1 km raster, age-binned)</span>
        </li>
        <li>
          Friction surface: <strong className="text-neutral-800">MAP (Weiss et al. 2020)</strong>
          <span className="text-neutral-400"> — globally validated</span>
        </li>
        <li>Travel-time model: Fast Marching Method on 1 km grid</li>
      </ul>
      <p className="mt-2 text-neutral-400">
        IDB Accessibility Platform, Panama pilot (3,617 schools).
      </p>
    </section>
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

// ── district detail ───────────────────────────────────────────────────────────

function DistrictDetail({
  distIndicators,
  onBack,
  defaultGroup,
  selectedTransport,
}: {
  distIndicators: DistrictIndicators;
  onBack: () => void;
  defaultGroup: AgeGroup;
  selectedTransport: TransportMode;
}) {
  const [activeGroup, setActiveGroup] = useState<AgeGroup>(defaultGroup);
  const row = distIndicators[activeGroup];
  const summaryRow = distIndicators.highschool ?? distIndicators.all;
  const hasTravelData = row ? row.data_completeness_pct > 0 : false;

  useEffect(() => {
    setActiveGroup(defaultGroup);
  }, [defaultGroup]);

  if (!summaryRow) {
    return <p className="p-4 text-sm text-neutral-500">No data for this district.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Back + title */}
      <div>
        <button
          onClick={onBack}
          className="mb-2 text-xs text-neutral-400 hover:text-neutral-600 transition-colors"
        >
          ← Back to overview
        </button>
        <h2 className="text-xl font-bold text-neutral-900">{summaryRow.nomb_dist}</h2>
        <p className="text-sm text-neutral-500">{summaryRow.nomb_prov} Province</p>
      </div>

      {/* Age group tabs */}
      <div className="flex gap-1 rounded-md bg-neutral-100 p-0.5">
        {AGE_GROUPS.map((g) => (
          <button
            key={g}
            onClick={() => setActiveGroup(g)}
            className={`flex-1 rounded px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
              activeGroup === g
                ? 'bg-white text-emerald-700 shadow-sm'
                : 'text-neutral-500 hover:text-neutral-700'
            }`}
          >
            {AGE_GROUP_SHORT_LABELS[g]}
          </button>
        ))}
      </div>

      {row ? (
        <>
          {hasTravelData ? (
            <>
              <div className="rounded-lg bg-emerald-50 p-4 text-center">
                <p className="text-4xl font-bold text-emerald-800">{row.pct_le30.toFixed(1)}%</p>
                <p className="mt-1 text-sm text-emerald-700">
                  of {AGE_GROUP_LABELS[activeGroup].toLowerCase()} within 30 min by{' '}
                  {TRANSPORT_LABELS[selectedTransport].toLowerCase()}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Stat label="Within 15 min" value={`${row.pct_le15.toFixed(1)}%`} />
                <Stat label="Within 60 min" value={`${row.pct_le60.toFixed(1)}%`} />
                <Stat label="Population" value={row.pop_total.toLocaleString()} />
                <Stat label="Reachable in 30 min" value={row.pop_le30.toLocaleString()} />
              </div>
            </>
          ) : (
            <>
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-center">
                <p className="text-lg font-semibold text-neutral-600">No travel-time data</p>
                <p className="mt-1 text-sm text-neutral-500">
                  This district is shown in grey on the map for{' '}
                  {AGE_GROUP_SHORT_LABELS[activeGroup].toLowerCase()}{' '}
                  {TRANSPORT_LABELS[selectedTransport].toLowerCase()} access.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Stat label="Population" value={row.pop_total.toLocaleString()} />
                <Stat label="Missing travel data" value={row.pop_nodata.toLocaleString()} />
                <Stat label="Completeness" value={`${row.data_completeness_pct.toFixed(1)}%`} />
                <Stat label="Mode" value={TRANSPORT_LABELS[selectedTransport]} />
              </div>
            </>
          )}

          <RobustnessCard row={row} />
        </>
      ) : (
        <p className="text-sm text-neutral-500">No data for this age group.</p>
      )}
    </div>
  );
}

// ── default view ──────────────────────────────────────────────────────────────

function DefaultView({
  top5,
  onSelectDist,
  selectedTransport,
  selectedAgeGroup,
}: {
  top5: IndicatorRow[];
  onSelectDist: (cod: string) => void;
  selectedTransport: TransportMode;
  selectedAgeGroup: AgeGroup;
}) {
  const rankLabel = `${AGE_GROUP_SHORT_LABELS[selectedAgeGroup]} ${TRANSPORT_LABELS[selectedTransport].toLowerCase()}`;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        5 worst {rankLabel} districts
      </p>

      {top5.length > 0 ? (
        <ol className="space-y-1.5">
          {top5.map((row, i) => (
            <li key={row.cod_dist}>
              <button
                onClick={() => onSelectDist(row.cod_dist)}
                className="w-full rounded-md border border-neutral-200 px-3 py-2.5 text-left transition-colors hover:bg-neutral-50"
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <span className="mr-1.5 text-xs text-neutral-400">{i + 1}.</span>
                    <span className="font-medium text-neutral-800">{row.nomb_dist}</span>
                    <span className="ml-1 text-xs text-neutral-400">{row.nomb_prov}</span>
                  </div>
                  <span className="ml-2 shrink-0 text-sm font-bold text-red-700">
                    {row.pct_le30.toFixed(1)}%
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-500">
          No districts with travel-time data for this view.
        </p>
      )}

      <p className="text-xs text-neutral-400">
        Click any district on the map to see its full breakdown.
      </p>
    </div>
  );
}

// ── main export ───────────────────────────────────────────────────────────────

interface Props {
  isLoading: boolean;
  top5Worst: IndicatorRow[];
  selectedDist: string | null;
  distIndicators: DistrictIndicators | null;
  selectedTransport: TransportMode;
  selectedAgeGroup: AgeGroup;
  onSelectDist: (cod: string) => void;
  onClearSelection: () => void;
}

export default function IndicatorPanel({
  isLoading,
  top5Worst,
  selectedDist,
  distIndicators,
  selectedTransport,
  selectedAgeGroup,
  onSelectDist,
  onClearSelection,
}: Props) {
  if (selectedDist && distIndicators) {
    return (
      <DistrictDetail
        distIndicators={distIndicators}
        onBack={onClearSelection}
        defaultGroup={selectedAgeGroup}
        selectedTransport={selectedTransport}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-neutral-400">
        Loading indicators...
      </div>
    );
  }

  return (
    <DefaultView
      top5={top5Worst}
      onSelectDist={onSelectDist}
      selectedTransport={selectedTransport}
      selectedAgeGroup={selectedAgeGroup}
    />
  );
}
