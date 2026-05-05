'use client';

import { useEffect, useState } from 'react';
import type { AgeGroup, DistrictIndicators, IndicatorRow, TransportMode } from '@/lib/types';
import {
  AGE_GROUP_LABELS,
  AGE_GROUP_NARRATIVE,
  AGE_GROUP_SHORT_LABELS,
  AGE_GROUPS,
  TRANSPORT_LABELS,
} from '@/lib/types';
import type { InsightStats } from './AppShell';
import RobustnessCard from './RobustnessCard';
import PriorityPanel from './PriorityPanel';
import { supabase } from '@/lib/supabase';
import type { PriorityRow } from '@/lib/types';

// ── sub-components ────────────────────────────────────────────────────────────

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

          <RobustnessCard
            cod_dist={row.cod_dist}
            age_group={activeGroup}
            transport_mode={selectedTransport}
          />
        </>
      ) : (
        <p className="text-sm text-neutral-500">No data for this age group.</p>
      )}
    </div>
  );
}

// ── insight landing (no district selected) ────────────────────────────────────

function InsightLanding({
  stats,
  onSelectDist,
  selectedTransport,
  selectedAgeGroup,
}: {
  stats: InsightStats;
  onSelectDist: (cod: string) => void;
  selectedTransport: TransportMode;
  selectedAgeGroup: AgeGroup;
}) {
  const narrative = AGE_GROUP_NARRATIVE[selectedAgeGroup];
  const mode = TRANSPORT_LABELS[selectedTransport].toLowerCase();
  const maxUnderserved = stats.topUnderserved[0]?.underserved ?? 0;

  // Worker-computed priority rows — falls back to the underserved bars when empty
  const [priorityRows, setPriorityRows] = useState<PriorityRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    setPriorityRows([]);
    supabase
      .from('priority_scores')
      .select('cod_dist, age_group, transport_mode, score, rank_in_country, children_underserved, pct_le30, robustness')
      .eq('age_group', selectedAgeGroup)
      .eq('transport_mode', selectedTransport)
      .order('rank_in_country', { ascending: true })
      .limit(5)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error('[InsightLanding] priority_scores:', error);
        setPriorityRows((data as PriorityRow[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAgeGroup, selectedTransport]);

  const showPriority = priorityRows.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Headline: % within 30 min */}
      <div className="rounded-lg bg-emerald-50 p-4 text-center">
        <p className="text-4xl font-bold text-emerald-800">{stats.nationalPct}%</p>
        <p className="mt-1 text-sm text-emerald-700">
          of Panama&apos;s {narrative} live within 30 min by {mode} of a school
        </p>
      </div>

      {/* Stakes: absolute children underserved */}
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <p className="text-3xl font-bold text-neutral-900">
          {stats.totalUnderserved.toLocaleString()}
        </p>
        <p className="mt-0.5 text-sm text-neutral-500">
          {narrative} more than 30 min by {mode} from any school
        </p>
      </div>

      {showPriority ? (
        <PriorityPanel
          rows={priorityRows}
          meta={stats.districtMeta}
          narrative={narrative}
          mode={mode}
          onSelectDist={onSelectDist}
        />
      ) : (
        stats.topUnderserved.length > 0 && (
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
              Districts with the most {narrative} underserved
            </p>
            <ol className="space-y-1.5">
              {stats.topUnderserved.map((entry, i) => {
                const widthPct =
                  maxUnderserved > 0 ? (entry.underserved / maxUnderserved) * 100 : 0;
                return (
                  <li key={entry.row.cod_dist}>
                    <button
                      onClick={() => onSelectDist(entry.row.cod_dist)}
                      className="block w-full rounded-md border border-neutral-200 px-3 py-2 text-left transition-colors hover:bg-neutral-50"
                    >
                      <div className="mb-1 flex items-baseline justify-between gap-2">
                        <div className="min-w-0 truncate">
                          <span className="mr-1.5 text-xs text-neutral-400">{i + 1}.</span>
                          <span className="text-sm font-medium text-neutral-800">
                            {entry.row.nomb_dist}
                          </span>
                          <span className="ml-1 text-xs text-neutral-400">
                            {entry.row.nomb_prov}
                          </span>
                        </div>
                        <span className="shrink-0 text-sm font-bold text-neutral-900">
                          {entry.underserved.toLocaleString()}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                        <div
                          className="h-full rounded-full bg-emerald-600"
                          style={{ width: `${Math.max(widthPct, 2)}%` }}
                        />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        )
      )}

      <p className="text-xs text-neutral-400">
        Click any bar to focus that district on the map.
      </p>
    </div>
  );
}

// ── main export ───────────────────────────────────────────────────────────────

interface Props {
  isLoading: boolean;
  insightStats: InsightStats | null;
  selectedDist: string | null;
  distIndicators: DistrictIndicators | null;
  selectedTransport: TransportMode;
  selectedAgeGroup: AgeGroup;
  onSelectDist: (cod: string) => void;
  onClearSelection: () => void;
}

export default function IndicatorPanel({
  isLoading,
  insightStats,
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

  if (!insightStats) {
    return (
      <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-500">
        No districts with travel-time data for this view.
      </p>
    );
  }

  return (
    <InsightLanding
      stats={insightStats}
      onSelectDist={onSelectDist}
      selectedTransport={selectedTransport}
      selectedAgeGroup={selectedAgeGroup}
    />
  );
}
