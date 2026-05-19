'use client';

import { useEffect, useState } from 'react';
import type {
  CountryIso,
  DistrictIndicators,
  EducationLevel,
  IndicatorRow,
  PriorityRow,
  TransportMode,
} from '@/lib/types';
import {
  COUNTRIES,
  EDUCATION_LEVELS,
  EDUCATION_LEVEL_LABELS,
  EDUCATION_LEVEL_NARRATIVE,
  EDUCATION_LEVEL_SHORT_LABELS,
  TRANSPORT_LABELS,
} from '@/lib/types';
import type { InsightStats } from './AppShell';
import RobustnessCard from './RobustnessCard';
import PriorityPanel from './PriorityPanel';
import CountryAuditBrief from './CountryAuditBrief';
import EquityGapCard from './EquityGapCard';
import { supabase } from '@/lib/supabase';

// ── sub-components ────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-neutral-50 p-3">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-neutral-900">{value}</p>
    </div>
  );
}

const popLe30 = (r: IndicatorRow) => Math.round(r.pop_total * ((r.pct_le30 ?? 0) / 100));

// ── district detail ───────────────────────────────────────────────────────────

function DistrictDetail({
  country,
  distIndicators,
  onBack,
  defaultLevel,
  selectedTransport,
}: {
  country: CountryIso;
  distIndicators: DistrictIndicators;
  onBack: () => void;
  defaultLevel: EducationLevel;
  selectedTransport: TransportMode;
}) {
  const [activeLevel, setActiveLevel] = useState<EducationLevel>(defaultLevel);
  const row = distIndicators[activeLevel];
  const summaryRow =
    distIndicators.secalta ?? Object.values(distIndicators).find((r) => r !== undefined);
  const hasTravelData = row ? row.pop_total > 0 : false;

  useEffect(() => {
    setActiveLevel(defaultLevel);
  }, [defaultLevel]);

  if (!summaryRow) {
    return <p className="p-4 text-sm text-neutral-500">No data for this district.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <button
          onClick={onBack}
          className="mb-2 text-xs text-neutral-400 hover:text-neutral-600 transition-colors"
        >
          ← Back to overview
        </button>
        <h2 className="text-xl font-bold text-neutral-900">{summaryRow.admin2_name}</h2>
        <p className="text-sm text-neutral-500">{summaryRow.admin1_name}</p>
      </div>

      {/* Education level tabs */}
      <div className="flex gap-1 rounded-md bg-neutral-100 p-0.5">
        {EDUCATION_LEVELS.map((g) => (
          <button
            key={g}
            onClick={() => setActiveLevel(g)}
            className={`flex-1 rounded px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
              activeLevel === g
                ? 'bg-white text-emerald-700 shadow-sm'
                : 'text-neutral-500 hover:text-neutral-700'
            }`}
          >
            {EDUCATION_LEVEL_SHORT_LABELS[g]}
          </button>
        ))}
      </div>

      {row ? (
        hasTravelData ? (
          <>
            <div className="rounded-lg bg-neutral-100 p-4 text-center">
              <p className="text-4xl font-bold text-neutral-900">{(row.pct_le30 ?? 0).toFixed(1)}%</p>
              <p className="mt-1 text-sm text-neutral-600">
                of {EDUCATION_LEVEL_LABELS[activeLevel].toLowerCase()} within 30 min by{' '}
                {TRANSPORT_LABELS[selectedTransport].toLowerCase()}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Stat label="Within 15 min" value={`${(row.pct_le15 ?? 0).toFixed(1)}%`} />
              <Stat label="Within 60 min" value={`${(row.pct_le60 ?? 0).toFixed(1)}%`} />
              <Stat label="Population" value={Math.round(row.pop_total).toLocaleString()} />
              <Stat label="Reachable in 30 min" value={popLe30(row).toLocaleString()} />
            </div>

            {row.pct_le30_osrm != null && (
              <p className="text-[11px] leading-snug text-neutral-500">
                OSRM routing puts 30-min access at{' '}
                <strong>{row.pct_le30_osrm.toFixed(1)}%</strong>, a{' '}
                {Math.abs((row.pct_le30 ?? 0) - row.pct_le30_osrm).toFixed(0)}-point gap from the FMM
                estimate above. The robustness score reflects this.
              </p>
            )}

            <RobustnessCard
              country_iso={country}
              admin2_pcode={row.admin2_pcode}
              education_level={activeLevel}
              transport_mode={selectedTransport}
            />
          </>
        ) : (
          <div className="rounded-lg border border-neutral-100 bg-neutral-50 p-4 text-center">
            <p className="text-lg font-semibold text-neutral-600">No school-age population</p>
            <p className="mt-1 text-sm text-neutral-500">
              No {EDUCATION_LEVEL_SHORT_LABELS[activeLevel].toLowerCase()} population is recorded
              here, so the accessibility number is not meaningful.
            </p>
          </div>
        )
      ) : (
        <p className="text-sm text-neutral-500">No data for this education level.</p>
      )}
    </div>
  );
}

// ── insight landing (no district selected) ────────────────────────────────────

function InsightLanding({
  country,
  stats,
  onSelectDist,
  selectedTransport,
  selectedLevel,
  onOpenSim,
}: {
  country: CountryIso;
  stats: InsightStats;
  onSelectDist: (code: string) => void;
  selectedTransport: TransportMode;
  selectedLevel: EducationLevel;
  onOpenSim: () => void;
}) {
  const narrative = EDUCATION_LEVEL_NARRATIVE[selectedLevel];
  const mode = TRANSPORT_LABELS[selectedTransport].toLowerCase();
  const countryName = COUNTRIES[country].name;
  const maxUnderserved = stats.topUnderserved[0]?.underserved ?? 0;

  const [priorityRows, setPriorityRows] = useState<PriorityRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    setPriorityRows([]);
    supabase
      .from('priority_scores')
      .select(
        'country_iso, admin2_pcode, education_level, transport_mode, score, rank_in_country, children_underserved, pct_le30, robustness'
      )
      .eq('country_iso', country)
      .eq('education_level', selectedLevel)
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
  }, [country, selectedLevel, selectedTransport]);

  const showPriority = priorityRows.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <button
        onClick={onOpenSim}
        className="group flex items-center justify-between rounded-md border border-neutral-100 bg-white px-3 py-2.5 text-left transition-colors hover:border-neutral-300 hover:bg-neutral-900/5"
      >
        <div>
          <p className="text-sm font-semibold text-neutral-800 group-hover:text-neutral-900">
            See inequality in motion
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-neutral-500">
            20-second animation: the map heats up over 60 simulated minutes. Where the
            amber keeps moving is where access fails.
          </p>
        </div>
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          className="ml-3 h-3.5 w-3.5 shrink-0 text-emerald-700 group-hover:text-neutral-900"
        >
          <path d="M8 5v14l11-7z" />
        </svg>
      </button>

      <div className="rounded-lg bg-neutral-100 p-4 text-center">
        <p className="text-4xl font-bold text-neutral-900">{stats.nationalPct}%</p>
        <p className="mt-1 text-sm text-neutral-600">
          of {countryName}&apos;s {narrative} live within 30 min by {mode} of a school
        </p>
      </div>

      <div className="rounded-lg border border-neutral-100 bg-white p-4">
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
            <ol className="space-y-1">
              {stats.topUnderserved.map((entry, i) => {
                const widthPct =
                  maxUnderserved > 0 ? (entry.underserved / maxUnderserved) * 100 : 0;
                return (
                  <li key={entry.row.admin2_pcode}>
                    <button
                      onClick={() => onSelectDist(entry.row.admin2_pcode)}
                      className="block w-full px-3 py-2 text-left transition-colors hover:bg-neutral-900/5"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <div className="min-w-0 truncate">
                          <span className="mr-1.5 text-xs tabular-nums text-neutral-400">
                            {i + 1}
                          </span>
                          <span className="text-sm font-medium text-neutral-800">
                            {entry.row.admin2_name}
                          </span>
                          <span className="ml-1 text-xs text-neutral-400">
                            {entry.row.admin1_name}
                          </span>
                        </div>
                        <span className="shrink-0 text-sm font-bold tabular-nums text-neutral-900">
                          {entry.underserved.toLocaleString()}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1 w-full overflow-hidden bg-neutral-100">
                        <div
                          className="h-full bg-neutral-500"
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

      <EquityGapCard country={country} level={selectedLevel} transport={selectedTransport} />

      <CountryAuditBrief countryIso={country} />
    </div>
  );
}

// ── main export ───────────────────────────────────────────────────────────────

interface Props {
  country: CountryIso;
  isLoading: boolean;
  insightStats: InsightStats | null;
  selectedDist: string | null;
  distIndicators: DistrictIndicators | null;
  selectedTransport: TransportMode;
  selectedLevel: EducationLevel;
  onSelectDist: (code: string) => void;
  onClearSelection: () => void;
  onOpenSim: () => void;
}

export default function IndicatorPanel({
  country,
  isLoading,
  insightStats,
  selectedDist,
  distIndicators,
  selectedTransport,
  selectedLevel,
  onSelectDist,
  onClearSelection,
  onOpenSim,
}: Props) {
  if (selectedDist && distIndicators) {
    return (
      <DistrictDetail
        country={country}
        distIndicators={distIndicators}
        onBack={onClearSelection}
        defaultLevel={selectedLevel}
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
      <p className="rounded-md border border-neutral-100 bg-neutral-50 px-3 py-3 text-sm text-neutral-500">
        No districts with travel-time data for this view.
      </p>
    );
  }

  return (
    <InsightLanding
      country={country}
      stats={insightStats}
      onSelectDist={onSelectDist}
      selectedTransport={selectedTransport}
      selectedLevel={selectedLevel}
      onOpenSim={onOpenSim}
    />
  );
}
