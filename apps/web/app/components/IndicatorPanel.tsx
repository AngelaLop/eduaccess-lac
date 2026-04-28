'use client';

import { useEffect, useState } from 'react';
import type {
  AgeGroup,
  DistrictIndicators,
  IndicatorRow,
  TransportMode,
} from '@/lib/types';
import {
  AGE_GROUP_LABELS,
  AGE_GROUP_SHORT_LABELS,
  AGE_GROUPS,
  TRANSPORT_LABELS,
} from '@/lib/types';

const LEGEND_COLORS = ['#7f1d1d', '#dc2626', '#f97316', '#eab308', '#16a34a'];
const NO_DATA_COLOR = '#d1d5db';

function RobustnessCard({ row }: { row: IndicatorRow }) {
  return (
    <section className="mt-4 rounded-md border border-neutral-200 p-4 text-sm">
      <h3 className="font-semibold text-neutral-800">How much can we trust this?</h3>
      <ul className="mt-2 space-y-1 text-neutral-700">
        <li>
          Data completeness: <strong>{row.data_completeness_pct}%</strong>
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
          <span className="text-xs text-neutral-500"> - globally validated</span>
        </li>
        <li>Travel-time model: Fast Marching Method on 1 km grid</li>
      </ul>
      <p className="mt-2 text-xs text-neutral-500">
        Source: IDB Accessibility Platform, Panama pilot (3,617 schools, MPCS thesis 2026).
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

function ViewControls({
  selectedTransport,
  selectedAgeGroup,
  onTransportChange,
  onAgeGroupChange,
}: {
  selectedTransport: TransportMode;
  selectedAgeGroup: AgeGroup;
  onTransportChange: (transport: TransportMode) => void;
  onAgeGroupChange: (ageGroup: AgeGroup) => void;
}) {
  return (
    <section className="rounded-md border border-neutral-200 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
        Map view
      </p>
      <p className="mt-1 text-sm leading-6 text-neutral-500">
        Pan and zoom the map manually, then switch the accessibility view by transport
        mode or education level.
      </p>

      <div className="mt-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Transport
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {(Object.keys(TRANSPORT_LABELS) as TransportMode[]).map((transport) => (
            <button
              key={transport}
              onClick={() => onTransportChange(transport)}
              className={`rounded px-2.5 py-1.5 text-xs font-medium transition-colors ${
                selectedTransport === transport
                  ? 'bg-emerald-700 text-white'
                  : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
              }`}
            >
              {TRANSPORT_LABELS[transport]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Education level
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {AGE_GROUPS.map((group) => (
            <button
              key={group}
              onClick={() => onAgeGroupChange(group)}
              className={`rounded px-2.5 py-1.5 text-xs font-medium transition-colors ${
                selectedAgeGroup === group
                  ? 'bg-emerald-700 text-white'
                  : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
              }`}
            >
              {AGE_GROUP_SHORT_LABELS[group]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Legend
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          <span>Worse</span>
          {LEGEND_COLORS.map((color) => (
            <span
              key={color}
              className="inline-block h-3 w-6 rounded-sm"
              style={{ background: color }}
            />
          ))}
          <span>Better</span>
          <span
            className="ml-2 inline-block h-3 w-6 rounded-sm"
            style={{ background: NO_DATA_COLOR }}
          />
          <span>No travel-time data</span>
        </div>
      </div>
    </section>
  );
}

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
      <div>
        <button
          onClick={onBack}
          className="mb-2 flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700"
        >
          Back to overview
        </button>
        <h2 className="text-xl font-bold text-neutral-900">{summaryRow.nomb_dist}</h2>
        <p className="text-sm text-neutral-500">{summaryRow.nomb_prov} Province</p>
      </div>

      <div className="flex flex-wrap gap-1">
        {AGE_GROUPS.map((group) => (
          <button
            key={group}
            onClick={() => setActiveGroup(group)}
            className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
              activeGroup === group
                ? 'bg-emerald-700 text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            {AGE_GROUP_SHORT_LABELS[group]}
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

              <div className="grid grid-cols-2 gap-2 text-sm">
                <Stat label="Within 15 min" value={`${row.pct_le15.toFixed(1)}%`} />
                <Stat label="Within 60 min" value={`${row.pct_le60.toFixed(1)}%`} />
                <Stat label="Population" value={row.pop_total.toLocaleString()} />
                <Stat label="Reachable in 30 min" value={row.pop_le30.toLocaleString()} />
              </div>
            </>
          ) : (
            <>
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-center">
                <p className="text-xl font-semibold text-neutral-700">No travel-time data</p>
                <p className="mt-1 text-sm text-neutral-500">
                  This district is shown in gray for {AGE_GROUP_SHORT_LABELS[activeGroup].toLowerCase()}{' '}
                  {TRANSPORT_LABELS[selectedTransport].toLowerCase()} access.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 text-sm">
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
  const rankingLabel = `${AGE_GROUP_SHORT_LABELS[selectedAgeGroup]} ${TRANSPORT_LABELS[selectedTransport].toLowerCase()}`;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-bold text-neutral-900">Panama School Access</h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          Accessibility indicators by district, with no-travel-data areas shown in gray
        </p>
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Worst {rankingLabel} access
        </p>
        {top5.length > 0 ? (
          <ol className="space-y-2">
            {top5.map((row, i) => (
              <li key={row.cod_dist}>
                <button
                  onClick={() => onSelectDist(row.cod_dist)}
                  className="w-full rounded-md border border-neutral-200 p-3 text-left transition-colors hover:bg-neutral-50"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="mr-2 text-xs text-neutral-400">{i + 1}.</span>
                      <span className="font-medium text-neutral-800">{row.nomb_dist}</span>
                      <span className="ml-1 text-xs text-neutral-500">{row.nomb_prov}</span>
                    </div>
                    <span className="text-sm font-bold text-red-700">
                      {row.pct_le30.toFixed(1)}%
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-500">
            No districts with travel-time data are available for this view.
          </p>
        )}
      </div>

      <p className="text-xs text-neutral-400">
        Click any district on the map to see its full indicator breakdown.
      </p>
    </div>
  );
}

interface Props {
  isLoading: boolean;
  top5Worst: IndicatorRow[];
  selectedDist: string | null;
  distIndicators: DistrictIndicators | null;
  selectedTransport: TransportMode;
  selectedAgeGroup: AgeGroup;
  onTransportChange: (transport: TransportMode) => void;
  onAgeGroupChange: (ageGroup: AgeGroup) => void;
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
  onTransportChange,
  onAgeGroupChange,
  onSelectDist,
  onClearSelection,
}: Props) {
  return (
    <div className="flex flex-col gap-4">
      <ViewControls
        selectedTransport={selectedTransport}
        selectedAgeGroup={selectedAgeGroup}
        onTransportChange={onTransportChange}
        onAgeGroupChange={onAgeGroupChange}
      />

      {selectedDist && distIndicators ? (
        <DistrictDetail
          distIndicators={distIndicators}
          onBack={onClearSelection}
          defaultGroup={selectedAgeGroup}
          selectedTransport={selectedTransport}
        />
      ) : isLoading ? (
        <div className="flex h-32 items-center justify-center text-sm text-neutral-400">
          Loading indicators...
        </div>
      ) : (
        <DefaultView
          top5={top5Worst}
          onSelectDist={onSelectDist}
          selectedTransport={selectedTransport}
          selectedAgeGroup={selectedAgeGroup}
        />
      )}
    </div>
  );
}
