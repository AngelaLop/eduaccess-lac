'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  COUNTRIES,
  type CountryIso,
  type EducationLevel,
  type IndicatorsByDist,
  type TransportMode,
} from '@/lib/types';

const COLOR_STEPS: [number, string][] = [
  [0, '#7f1d1d'],
  [20, '#dc2626'],
  [40, '#f97316'],
  [60, '#eab308'],
  [80, '#16a34a'],
];
const NO_DATA_COLOR = '#d1d5db';

// Module-level cache of parsed district GeoJSON. Survives country switches
// and remounts — flipping back to a country needs no re-fetch / re-parse.
const geojsonCache = new Map<string, GeoJSON.FeatureCollection>();

async function loadCountryGeojson(c: CountryIso): Promise<GeoJSON.FeatureCollection> {
  const cached = geojsonCache.get(c);
  if (cached) return cached;
  const res = await fetch(COUNTRIES[c].geojson);
  const gj = (await res.json()) as GeoJSON.FeatureCollection;
  geojsonCache.set(c, gj);
  return gj;
}

export interface RankedHighlight {
  admin2_pcode: string;
  rank: number;
}

interface Props {
  country: CountryIso;
  indicators: IndicatorsByDist;
  activeLevel: EducationLevel;
  activeTransport: TransportMode;
  highlightedDists: string[];
  rankedHighlights: RankedHighlight[] | null;
  selectedDist: string | null;
  onDistrictClick: (admin2_pcode: string) => void;
  onResetView: () => void;
  simulationActive: boolean;
  simulationSimMin: number;
  // districts to outline once the simulation finishes (the kid-track samples)
  simHighlights: string[];
}

// bbox of any GeoJSON geometry → [minX, minY, maxX, maxY]
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

// Choropleth fill — reads data from feature-state, so the geometry is
// tessellated once and only cheap state updates drive the colours.
const choroplethFill: maplibregl.ExpressionSpecification = [
  'case',
  ['!=', ['feature-state', 'has_data'], 1],
  NO_DATA_COLOR,
  [
    'step',
    ['coalesce', ['feature-state', 'pct'], 0],
    COLOR_STEPS[0][1],
    ...COLOR_STEPS.slice(1).flatMap(([t, c]) => [t, c]),
  ],
] as unknown as maplibregl.ExpressionSpecification;

function simulationFillExpression(simMin: number): maplibregl.ExpressionSpecification {
  const arrived: maplibregl.ExpressionSpecification = [
    'interpolate',
    ['linear'],
    simMin,
    0, 0,
    15, ['coalesce', ['feature-state', 'le15'], 0],
    30, ['coalesce', ['feature-state', 'le30'], 0],
    60, ['coalesce', ['feature-state', 'le60'], 0],
  ] as unknown as maplibregl.ExpressionSpecification;
  return [
    'case',
    ['!=', ['feature-state', 'has_data'], 1],
    NO_DATA_COLOR,
    ['step', arrived, COLOR_STEPS[0][1], ...COLOR_STEPS.slice(1).flatMap(([t, c]) => [t, c])],
  ] as unknown as maplibregl.ExpressionSpecification;
}

export default function CountryMap({
  country,
  indicators,
  activeLevel,
  activeTransport,
  highlightedDists,
  rankedHighlights,
  selectedDist,
  onDistrictClick,
  onResetView,
  simulationActive,
  simulationSimMin,
  simHighlights,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const geojsonRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const lastSimPaintRef = useRef(0);
  const [mapReady, setMapReady] = useState(false);

  const indicatorsRef = useRef<IndicatorsByDist>(indicators);
  const levelRef = useRef<EducationLevel>(activeLevel);
  const highlightedRef = useRef<string[]>(highlightedDists);
  const selectedRef = useRef<string | null>(selectedDist);
  indicatorsRef.current = indicators;
  levelRef.current = activeLevel;
  highlightedRef.current = highlightedDists;
  selectedRef.current = selectedDist;
  void activeTransport;

  // ── feature-state: push the data values for the active level ──────────────
  function applyDataStates(map: maplibregl.Map) {
    const gj = geojsonRef.current;
    if (!gj || !map.getSource('districts')) return;
    const inds = indicatorsRef.current;
    const level = levelRef.current;
    for (const f of gj.features) {
      const code = f.properties?.admin2_pcode as string;
      const cur = inds[code]?.[level];
      const hasData = cur ? cur.pop_total > 0 : false;
      map.setFeatureState(
        { source: 'districts', id: code },
        {
          has_data: hasData ? 1 : 0,
          pct: hasData ? cur?.pct_le30 ?? 0 : 0,
          le15: hasData ? cur?.pct_le15 ?? 0 : 0,
          le30: hasData ? cur?.pct_le30 ?? 0 : 0,
          le60: hasData ? cur?.pct_le60 ?? 0 : 0,
        }
      );
    }
  }

  // ── rank labels live in a tiny separate point source (≤ ~20 points), so
  //    the 1,000+-polygon source is never re-uploaded for a chat result ────
  function rankPointsFC(ranked: RankedHighlight[] | null): GeoJSON.FeatureCollection {
    const gj = geojsonRef.current;
    if (!gj || !ranked || ranked.length === 0) {
      return { type: 'FeatureCollection', features: [] };
    }
    const rankByCode = new Map(ranked.map((r) => [r.admin2_pcode, r.rank]));
    // largest bbox feature per code carries the label
    const best = new Map<string, { area: number; center: [number, number] }>();
    for (const f of gj.features) {
      const code = f.properties?.admin2_pcode as string | undefined;
      if (!code || !rankByCode.has(code)) continue;
      const [minX, minY, maxX, maxY] = geometryBbox(f.geometry);
      if (!Number.isFinite(minX)) continue;
      const area = (maxX - minX) * (maxY - minY);
      const prev = best.get(code);
      if (!prev || area > prev.area) {
        best.set(code, { area, center: [(minX + maxX) / 2, (minY + maxY) / 2] });
      }
    }
    return {
      type: 'FeatureCollection',
      features: [...best.entries()].map(([code, { center }]) => ({
        type: 'Feature' as const,
        properties: { rank: rankByCode.get(code) },
        geometry: { type: 'Point' as const, coordinates: center },
      })),
    };
  }

  function applyFillOpacity(map: maplibregl.Map, sel: string | null, highlights: string[]) {
    if (!map.getLayer('districts-fill')) return;
    if (sel) {
      map.setPaintProperty('districts-fill', 'fill-opacity', [
        'case', ['==', ['get', 'admin2_pcode'], sel], 0.95, 0.18,
      ] as unknown as maplibregl.ExpressionSpecification);
      return;
    }
    if (highlights.length > 0) {
      map.setPaintProperty('districts-fill', 'fill-opacity', [
        'case', ['in', ['get', 'admin2_pcode'], ['literal', highlights]], 0.95, 0.30,
      ] as unknown as maplibregl.ExpressionSpecification);
      return;
    }
    map.setPaintProperty('districts-fill', 'fill-opacity', 0.82);
  }

  // ── map init (once) ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: COUNTRIES[country].center,
      zoom: COUNTRIES[country].zoom,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    const popup = new maplibregl.Popup({
      closeButton: false, closeOnClick: false, offset: 10, className: 'eduaccess-popup',
    });
    popupRef.current = popup;

    map.on('click', 'districts-fill', (e) => {
      const code = e.features?.[0]?.properties?.admin2_pcode as string | undefined;
      if (code) onDistrictClick(code);
    });
    map.on('mouseenter', 'districts-fill', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mousemove', 'districts-fill', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const code = f.properties?.admin2_pcode as string;
      const name = f.properties?.admin2_name as string | undefined;
      const prov = f.properties?.admin1_name as string | undefined;
      const ind = indicatorsRef.current[code]?.[levelRef.current];
      const valueLine =
        !ind || ind.pop_total <= 0
          ? '<span style="color:#a3a3a3;">No travel-time data</span>'
          : `<strong>${ind.pct_le30}%</strong> within 30 min`;
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

    map.on('load', () => setMapReady(true));

    mapRef.current = map;
    return () => {
      popup.remove();
      map.remove();
      mapRef.current = null;
      popupRef.current = null;
      setMapReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── load geometry on country change (the only place geometry uploads) ─────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let cancelled = false;

    (async () => {
      const gj = await loadCountryGeojson(country);
      if (cancelled || !mapRef.current) return;
      geojsonRef.current = gj;

      if (map.getSource('districts')) {
        (map.getSource('districts') as maplibregl.GeoJSONSource).setData(gj);
      } else {
        // promoteId → feature.id is the admin2_pcode, so setFeatureState keys on it
        map.addSource('districts', { type: 'geojson', data: gj, promoteId: 'admin2_pcode' });
        map.addSource('rank-points', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'districts-fill',
          type: 'fill',
          source: 'districts',
          paint: {
            'fill-color': choroplethFill,
            'fill-opacity': 0.82,
            'fill-color-transition': { duration: 0, delay: 0 },
          },
        });
        map.addLayer({
          id: 'districts-border',
          type: 'line',
          source: 'districts',
          paint: { 'line-color': '#ffffff', 'line-width': 0.6 },
        });
        map.addLayer({
          id: 'rank-labels',
          type: 'symbol',
          source: 'rank-points',
          layout: {
            'text-field': ['to-string', ['get', 'rank']],
            'text-size': 13,
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#ffffff',
            'text-halo-color': '#0a0a0a',
            'text-halo-width': 2,
          },
        });
      }

      applyDataStates(map);
      (map.getSource('rank-points') as maplibregl.GeoJSONSource | undefined)?.setData(
        rankPointsFC(rankedHighlights)
      );
      map.flyTo({
        center: COUNTRIES[country].center,
        zoom: COUNTRIES[country].zoom,
        duration: 600,
      });
      applyFillOpacity(map, selectedRef.current, highlightedRef.current);

      for (const other of Object.keys(COUNTRIES) as CountryIso[]) {
        if (other !== country && !geojsonCache.has(other)) void loadCountryGeojson(other);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, mapReady]);

  // ── data values change (level / transport / indicators) → feature-state ───
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getSource('districts')) return;
    applyDataStates(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicators, activeLevel, mapReady]);

  // ── ranking result → tiny point source only ───────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    (map.getSource('rank-points') as maplibregl.GeoJSONSource | undefined)?.setData(
      rankPointsFC(rankedHighlights)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rankedHighlights, mapReady]);

  // ── simulation finished → spotlight the sampled districts ─────────────────
  // Same treatment as a ranking result: the sampled districts stay bright, the
  // rest dim. Only meaningful while the Simulate tab is active.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !simulationActive || !map.getLayer('districts-fill')) return;
    if (simHighlights.length > 0) {
      applyFillOpacity(map, null, simHighlights);
    } else {
      map.setPaintProperty('districts-fill', 'fill-opacity', 0.88);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simHighlights, simulationActive, mapReady]);

  // ── highlight opacity ─────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    applyFillOpacity(map, selectedDist, highlightedDists);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedDists, mapReady]);

  // ── selection: dim others + zoom to fit ───────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    const gj = geojsonRef.current;
    if (!map || !mapReady) return;

    applyFillOpacity(map, selectedDist, highlightedRef.current);
    popupRef.current?.remove();

    if (!selectedDist) {
      map.flyTo({
        center: COUNTRIES[country].center,
        zoom: COUNTRIES[country].zoom,
        duration: 700,
      });
      return;
    }
    if (!gj) return;
    const feature = gj.features.find((f) => f.properties?.admin2_pcode === selectedDist);
    if (!feature) return;
    const [minX, minY, maxX, maxY] = geometryBbox(feature.geometry);
    if (!Number.isFinite(minX)) return;
    map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 80, duration: 700, maxZoom: 11 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDist]);

  // ── simulation fill ───────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getLayer('districts-fill')) return;
    if (simulationActive) {
      map.setPaintProperty('districts-fill', 'fill-color', simulationFillExpression(simulationSimMin));
      map.setPaintProperty('districts-fill', 'fill-opacity', 0.88);
    } else {
      map.setPaintProperty('districts-fill', 'fill-color', choroplethFill);
      applyFillOpacity(map, selectedRef.current, highlightedRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationActive, mapReady]);

  useEffect(() => {
    if (!simulationActive) return;
    const map = mapRef.current;
    if (!map || !mapReady || !map.getLayer('districts-fill')) return;
    // Throttle to ~11 fps — a fill-color expression swap is cheap, but not free
    // across a large viewport. The 0 and 60 edges always paint.
    const isEdge = simulationSimMin <= 0 || simulationSimMin >= 60;
    const now = performance.now();
    if (!isEdge && now - lastSimPaintRef.current < 90) return;
    lastSimPaintRef.current = now;
    map.setPaintProperty('districts-fill', 'fill-color', simulationFillExpression(simulationSimMin));
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
          title="Back to country overview"
          aria-label="Back to country overview"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M3 12L12 3l9 9" />
            <path d="M5 10v10h14V10" />
          </svg>
          Overview
        </button>
      )}
    </div>
  );
}
