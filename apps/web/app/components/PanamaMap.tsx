'use client';

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { AgeGroup, IndicatorsByDist, TransportMode } from '@/lib/types';

const COLOR_STEPS: [number, string][] = [
  [0, '#7f1d1d'],
  [20, '#dc2626'],
  [40, '#f97316'],
  [60, '#eab308'],
  [80, '#16a34a'],
];

const NO_DATA_COLOR = '#d1d5db';

const PANAMA_VIEW = { center: [-80.0, 8.5] as [number, number], zoom: 6.5 };

const choroplethFill: maplibregl.ExpressionSpecification = [
  'case',
  ['==', ['get', 'has_travel_data'], 0],
  NO_DATA_COLOR,
  [
    'step',
    ['coalesce', ['get', 'pct_le30_current'], 0],
    COLOR_STEPS[0][1],
    ...COLOR_STEPS.slice(1).flatMap(([threshold, color]) => [threshold, color]),
  ],
] as unknown as maplibregl.ExpressionSpecification;

export interface RankedHighlight {
  cod_dist: string;
  rank: number;
}

interface Props {
  indicators: IndicatorsByDist;
  activeAgeGroup: AgeGroup;
  activeTransport: TransportMode;
  highlightedDists: string[];
  // Set when chat returned a ranking result; empty/null otherwise.
  // Drives the numbered labels on the highlighted polygons.
  rankedHighlights: RankedHighlight[] | null;
  selectedDist: string | null;
  onDistrictClick: (codDist: string) => void;
  onResetView: () => void;
  // Inequality simulation: when active, the choropleth rebinds to
  // "% of children reached at simulationSimMin" instead of static pct_le30.
  simulationActive: boolean;
  simulationSimMin: number;     // 0..60
}

// ── simulation helper ───────────────────────────────────────────────────────

/**
 * Compute % of children who have reached a school by simulated minute t,
 * given the district's pct_le15/30/60. Linear interp through the data
 * points (0,0), (15, pct_le15), (30, pct_le30), (60, pct_le60).
 */
function pctArrivedAt(t: number, pct_le15: number, pct_le30: number, pct_le60: number): number {
  if (t <= 0) return 0;
  if (t <= 15) return (t / 15) * pct_le15;
  if (t <= 30) return pct_le15 + ((t - 15) / 15) * (pct_le30 - pct_le15);
  if (t <= 60) return pct_le30 + ((t - 30) / 30) * (pct_le60 - pct_le30);
  return pct_le60;
}

// bbox of any GeoJSON Polygon | MultiPolygon, returned as [minX, minY, maxX, maxY]
function geometryBbox(geometry: GeoJSON.Geometry): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function walk(coords: unknown) {
    if (Array.isArray(coords) && typeof coords[0] === 'number') {
      const x = coords[0] as number;
      const y = coords[1] as number;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    } else if (Array.isArray(coords)) {
      for (const c of coords) walk(c);
    }
  }
  if ('coordinates' in geometry) walk(geometry.coordinates);
  return [minX, minY, maxX, maxY];
}

export default function PanamaMap({
  indicators,
  activeAgeGroup,
  activeTransport,
  highlightedDists,
  rankedHighlights,
  selectedDist,
  onDistrictClick,
  onResetView,
  simulationActive,
  simulationSimMin,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const geojsonRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const readyRef = useRef(false);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  const indicatorsRef = useRef<IndicatorsByDist>(indicators);
  const ageGroupRef = useRef<AgeGroup>(activeAgeGroup);
  const transportRef = useRef<TransportMode>(activeTransport);
  const highlightedRef = useRef<string[]>(highlightedDists);
  const rankedRef = useRef<RankedHighlight[] | null>(rankedHighlights);
  const selectedRef = useRef<string | null>(selectedDist);
  indicatorsRef.current = indicators;
  ageGroupRef.current = activeAgeGroup;
  transportRef.current = activeTransport;
  highlightedRef.current = highlightedDists;
  rankedRef.current = rankedHighlights;
  selectedRef.current = selectedDist;

  // Avoid unused-var warnings in simulation-mode codepaths
  void activeTransport;

  function mergedGeoJSON(gj: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
    const inds = indicatorsRef.current;
    const activeGroup = ageGroupRef.current;
    const rankByCode = new Map(
      (rankedRef.current ?? []).map((r) => [r.cod_dist, r.rank])
    );
    // Some districts are split across multiple features in the geojson
    // (multipolygon coasts / archipelagos). Pick one feature per cod_dist —
    // the largest by approximate bbox area — so we only render one label.
    const labelFeatureByCode = new Map<string, number>();
    if (rankByCode.size > 0) {
      const areaByIdx: Array<{ idx: number; code: string; area: number }> = [];
      gj.features.forEach((f, idx) => {
        const code = f.properties?.cod_dist as string | undefined;
        if (!code || !rankByCode.has(code)) return;
        const [minX, minY, maxX, maxY] = geometryBbox(f.geometry);
        const area = Number.isFinite(minX) ? (maxX - minX) * (maxY - minY) : 0;
        areaByIdx.push({ idx, code, area });
      });
      areaByIdx.sort((a, b) => b.area - a.area);
      for (const { idx, code } of areaByIdx) {
        if (!labelFeatureByCode.has(code)) labelFeatureByCode.set(code, idx);
      }
    }

    return {
      ...gj,
      features: gj.features.map((feature, idx) => {
        const code = feature.properties?.cod_dist as string;
        const current = inds[code]?.[activeGroup];
        const hasTravelData = current ? current.data_completeness_pct > 0 : false;
        const rank = rankByCode.get(code);
        const isLabelFeature = rank !== undefined && labelFeatureByCode.get(code) === idx;

        const properties: Record<string, unknown> = {
          ...feature.properties,
          has_travel_data: hasTravelData ? 1 : 0,
          pct_le30_current: hasTravelData ? current?.pct_le30 ?? null : null,
          // Properties used by the simulation fill expression
          pct_le15_sim: hasTravelData ? current?.pct_le15 ?? 0 : 0,
          pct_le30_sim: hasTravelData ? current?.pct_le30 ?? 0 : 0,
          pct_le60_sim: hasTravelData ? current?.pct_le60 ?? 0 : 0,
        };
        if (isLabelFeature) properties.rank_in_result = rank;

        return { ...feature, properties };
      }),
    };
  }

  // ── apply selection-aware fill opacity ────────────────────────────────────
  // - selection: 0.95 selected, 0.18 others
  // - chat highlights (no selection): 0.95 highlighted, 0.30 others
  // - neither: 0.82 default
  function applyFillOpacity(
    map: maplibregl.Map,
    sel: string | null,
    highlights: string[]
  ) {
    if (sel) {
      map.setPaintProperty('districts-fill', 'fill-opacity', [
        'case',
        ['==', ['get', 'cod_dist'], sel],
        0.95,
        0.18,
      ] as unknown as maplibregl.ExpressionSpecification);
      return;
    }
    if (highlights.length > 0) {
      map.setPaintProperty('districts-fill', 'fill-opacity', [
        'case',
        ['in', ['get', 'cod_dist'], ['literal', highlights]],
        0.95,
        0.30,
      ] as unknown as maplibregl.ExpressionSpecification);
      return;
    }
    map.setPaintProperty('districts-fill', 'fill-opacity', 0.82);
  }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: PANAMA_VIEW.center,
      zoom: PANAMA_VIEW.zoom,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 10,
      className: 'eduaccess-popup',
    });
    popupRef.current = popup;

    map.on('load', async () => {
      const res = await fetch('/panama_districts.simplified.geojson');
      const gj: GeoJSON.FeatureCollection = await res.json();
      geojsonRef.current = gj;

      map.addSource('districts', { type: 'geojson', data: mergedGeoJSON(gj) });

      map.addLayer({
        id: 'districts-fill',
        type: 'fill',
        source: 'districts',
        paint: { 'fill-color': choroplethFill, 'fill-opacity': 0.82 },
      });

      map.addLayer({
        id: 'districts-border',
        type: 'line',
        source: 'districts',
        paint: { 'line-color': '#ffffff', 'line-width': 0.6 },
      });

      // Rank labels for ranking results — small numbered badge centered on the polygon
      map.addLayer({
        id: 'rank-labels',
        type: 'symbol',
        source: 'districts',
        filter: ['has', 'rank_in_result'],
        layout: {
          'text-field': ['to-string', ['get', 'rank_in_result']],
          'text-size': 13,
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#0a0a0a',
          'text-halo-width': 2,
        },
      });

      map.on('click', 'districts-fill', (e) => {
        const code = e.features?.[0]?.properties?.cod_dist as string | undefined;
        if (code) onDistrictClick(code);
      });
      map.on('mouseenter', 'districts-fill', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mousemove', 'districts-fill', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const code = f.properties?.cod_dist as string;
        const name = f.properties?.nomb_dist as string | undefined;
        const prov = f.properties?.nomb_prov as string | undefined;
        const ind = indicatorsRef.current[code]?.[ageGroupRef.current];
        const valueLine =
          !ind || ind.data_completeness_pct === 0
            ? '<span style="color:#a3a3a3;">No travel-time data</span>'
            : `<strong>${ind.pct_le30}%</strong> within 30 min walk`;
        popup
          .setLngLat(e.lngLat)
          .setHTML(
            `<div style="font: 12px ui-sans-serif, system-ui; line-height: 1.35;">
               <div style="font-weight: 600; color: #171717;">${name ?? code}</div>
               <div style="color: #737373; font-size: 11px;">${prov ?? ''}</div>
               <div style="margin-top: 2px; color: #404040;">${valueLine}</div>
             </div>`
          )
          .addTo(map);
      });
      map.on('mouseleave', 'districts-fill', () => {
        map.getCanvas().style.cursor = '';
        popup.remove();
      });

      readyRef.current = true;

      applyFillOpacity(map, selectedRef.current, highlightedRef.current);
    });

    mapRef.current = map;
    return () => {
      popup.remove();
      map.remove();
      mapRef.current = null;
      popupRef.current = null;
      readyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const gj = geojsonRef.current;
    if (!map || !gj || !readyRef.current) return;

    (map.getSource('districts') as maplibregl.GeoJSONSource | undefined)?.setData(
      mergedGeoJSON(gj)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicators, activeAgeGroup, rankedHighlights]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    applyFillOpacity(map, selectedDist, highlightedDists);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedDists]);

  // Selection: dim non-selected and zoom to fit
  useEffect(() => {
    const map = mapRef.current;
    const gj = geojsonRef.current;
    if (!map || !readyRef.current) return;

    applyFillOpacity(map, selectedDist, highlightedRef.current);
    popupRef.current?.remove();

    if (!selectedDist) {
      map.flyTo({ center: PANAMA_VIEW.center, zoom: PANAMA_VIEW.zoom, duration: 700 });
      return;
    }

    if (!gj) return;
    const feature = gj.features.find((f) => f.properties?.cod_dist === selectedDist);
    if (!feature) return;
    const [minX, minY, maxX, maxY] = geometryBbox(feature.geometry);
    if (!Number.isFinite(minX)) return;
    map.fitBounds(
      [
        [minX, minY],
        [maxX, maxY],
      ],
      { padding: 80, duration: 700, maxZoom: 11 }
    );
  }, [selectedDist]);

  // ── simulation: rebind choropleth fill to current sim time ──────────────
  //
  // The expression interpolates a "% arrived at simMin" value per feature
  // from its pct_le15/30/60 properties, then maps that to the same color
  // ramp as the static choropleth. At simMin=30 the colors equal the
  // current Insight-tab choropleth — the simulation just shows the same
  // story unfolding through time.
  function simulationFillExpression(simMin: number): maplibregl.ExpressionSpecification {
    const arrivedExpr: maplibregl.ExpressionSpecification = [
      'interpolate',
      ['linear'],
      simMin,
      0, 0,
      15, ['get', 'pct_le15_sim'],
      30, ['get', 'pct_le30_sim'],
      60, ['get', 'pct_le60_sim'],
    ] as unknown as maplibregl.ExpressionSpecification;

    return [
      'case',
      ['==', ['get', 'has_travel_data'], 0],
      NO_DATA_COLOR,
      [
        'step',
        arrivedExpr,
        COLOR_STEPS[0][1],
        ...COLOR_STEPS.slice(1).flatMap(([threshold, color]) => [threshold, color]),
      ],
    ] as unknown as maplibregl.ExpressionSpecification;
  }

  // Apply / unapply the simulation fill expression when simulationActive
  // toggles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    if (simulationActive) {
      map.setPaintProperty(
        'districts-fill',
        'fill-color',
        simulationFillExpression(simulationSimMin)
      );
      map.setPaintProperty('districts-fill', 'fill-opacity', 0.88);
    } else {
      map.setPaintProperty('districts-fill', 'fill-color', choroplethFill);
      applyFillOpacity(map, selectedRef.current, highlightedRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationActive]);

  // While simulation is active, update the fill expression on every simMin
  // change (driven by the parent's animation loop).
  useEffect(() => {
    if (!simulationActive) return;
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setPaintProperty(
      'districts-fill',
      'fill-color',
      simulationFillExpression(simulationSimMin)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationSimMin, simulationActive]);

  const showOverviewButton = !!selectedDist || highlightedDists.length > 0;

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {showOverviewButton && (
        <button
          onClick={onResetView}
          className="absolute right-3 top-24 z-10 flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-700 shadow-lg transition-colors hover:bg-neutral-50 hover:text-neutral-900"
          title="Back to Panama overview"
          aria-label="Back to Panama overview"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5"
            aria-hidden="true"
          >
            <path d="M3 12L12 3l9 9" />
            <path d="M5 10v10h14V10" />
          </svg>
          Overview
        </button>
      )}
    </div>
  );
}
