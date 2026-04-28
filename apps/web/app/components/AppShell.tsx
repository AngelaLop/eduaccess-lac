'use client';

import { useState, useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { supabase } from '@/lib/supabase';
import IndicatorPanel from './IndicatorPanel';
import type { AgeGroup, IndicatorRow, IndicatorsByDist } from '@/lib/types';

// MapLibre uses window — load client-side only
const PanamaMap = dynamic(() => import('./PanamaMap'), { ssr: false });

export default function AppShell() {
  const [indicators, setIndicators] = useState<IndicatorsByDist>({});
  const [selectedDist, setSelectedDist] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load all canonical indicators on mount
  useEffect(() => {
    supabase
      .from('v_panama_indicators')
      .select('*')
      .then(({ data, error }) => {
        if (error || !data) {
          console.error('Failed to load indicators:', error);
          return;
        }
        const byDist: IndicatorsByDist = {};
        for (const row of data as IndicatorRow[]) {
          if (!byDist[row.cod_dist]) byDist[row.cod_dist] = {};
          byDist[row.cod_dist][row.age_group as AgeGroup] = row;
        }
        setIndicators(byDist);
        setIsLoading(false);
      });
  }, []);

  // Top 5 worst high-school walking access (ascending pct_le30)
  const top5Worst = useMemo<IndicatorRow[]>(() => {
    const hsRows = Object.values(indicators)
      .map((d) => d.highschool)
      .filter((r): r is IndicatorRow => r !== undefined);
    return hsRows.sort((a, b) => a.pct_le30 - b.pct_le30).slice(0, 5);
  }, [indicators]);

  const highlightedDists = useMemo(
    () => top5Worst.map((r) => r.cod_dist),
    [top5Worst]
  );

  const distIndicators = selectedDist ? (indicators[selectedDist] ?? null) : null;

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Map — 65% on desktop, full width on mobile */}
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
          onDistrictClick={setSelectedDist}
        />
      </div>

      {/* Side panel — 35% on desktop */}
      <aside className="md:basis-[35%] md:overflow-y-auto border-t md:border-t-0 md:border-l border-neutral-200 bg-white flex flex-col">
        {/* Header */}
        <div className="border-b border-neutral-100 px-5 py-4">
          <h1 className="text-sm font-semibold tracking-wide text-emerald-700 uppercase">
            EduAccess LAC
          </h1>
          <p className="text-xs text-neutral-400 mt-0.5">Panama · preview</p>
        </div>

        {/* Indicator content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <IndicatorPanel
            top5Worst={top5Worst}
            selectedDist={selectedDist}
            distIndicators={distIndicators}
            onSelectDist={setSelectedDist}
            onClearSelection={() => setSelectedDist(null)}
          />
        </div>

        {/* Chat placeholder — section 3 */}
        <div className="border-t border-neutral-100 px-5 py-4 bg-neutral-50">
          <p className="text-xs text-neutral-400 text-center">
            Chat coming next (section 3)
          </p>
        </div>

        {/* Footer */}
        <div className="border-t border-neutral-100 px-5 py-3">
          <p className="text-xs text-neutral-400">
            Data: IDB Accessibility Platform · v1 preview · 2026
          </p>
        </div>
      </aside>
    </div>
  );
}
