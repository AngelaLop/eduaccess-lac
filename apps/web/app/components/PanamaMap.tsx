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

export interface SimulationCommand {
  type: 'play' | 'pause' | 'replay' | 'idle';
  nonce: number;
}

export interface SimulationStatusUpdate {
  simMin: number;
  arrivedPct: number;
  isPlaying: boolean;
  isFinished: boolean;
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
  // Inequality-in-motion simulation overlay
  simulationActive: boolean;
  simulationCommand: SimulationCommand;
  onSimulationStatus: (s: SimulationStatusUpdate) => void;
}

// ── simulation helpers ──────────────────────────────────────────────────────

const SIM_DURATION_SEC = 10;
const SIM_MINUTES = 60;
const DOTS_PER_DISTRICT = 10;

interface SimDot {
  id: string;
  lng: number;
  lat: number;
  vlng: number;
  vlat: number;
  arrivalMin: number;     // Infinity = never arrives in 60 min
  status: 0 | 1 | 2;      // 0 walking · 1 arrived · 2 never (post-60)
  bMinLng: number;
  bMaxLng: number;
  bMinLat: number;
  bMaxLat: number;
}

function generateDotsForDistrict(
  codDist: string,
  geometry: GeoJSON.Geometry,
  pct_le15: number,
  pct_le30: number,
  pct_le60: number,
  count: number
): SimDot[] {
  const [minLng, minLat, maxLng, maxLat] = geometryBbox(geometry);
  if (!Number.isFinite(minLng)) return [];

  const cLng = (minLng + maxLng) / 2;
  const cLat = (minLat + maxLat) / 2;
  const spanLng = maxLng - minLng;
  const spanLat = maxLat - minLat;

  const fLe15 = Math.max(0, pct_le15) / 100;
  const f15_30 = Math.max(0, pct_le30 - pct_le15) / 100;
  const f30_60 = Math.max(0, pct_le60 - pct_le30) / 100;

  const dots: SimDot[] = [];
  for (let i = 0; i < count; i++) {
    const lng = cLng + (Math.random() - 0.5) * spanLng * 0.4;
    const lat = cLat + (Math.random() - 0.5) * spanLat * 0.4;

    const angle = Math.random() * Math.PI * 2;
    const speed = 0.025 + Math.random() * 0.02;
    const vlng = Math.cos(angle) * speed * spanLng;
    const vlat = Math.sin(angle) * speed * spanLat;

    const r = Math.random();
    let arrivalMin: number;
    if (r < fLe15) arrivalMin = Math.random() * 15;
    else if (r < fLe15 + f15_30) arrivalMin = 15 + Math.random() * 15;
    else if (r < fLe15 + f15_30 + f30_60) arrivalMin = 30 + Math.random() * 30;
    else arrivalMin = Infinity;

    dots.push({
      id: `${codDist}_${i}`,
      lng, lat, vlng, vlat, arrivalMin,
      status: 0,
      bMinLng: minLng, bMaxLng: maxLng,
      bMinLat: minLat, bMaxLat: maxLat,
    });
  }
  return dots;
}

function dotsToFeatures(dots: SimDot[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: dots.map((d) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [d.lng, d.lat] },
      properties: { status: d.status, id: d.id },
    })),
  };
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
  simulationCommand,
  onSimulationStatus,
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

  // Simulation state (kept in refs so animation ticks don't trigger React rerenders)
  const simDotsRef = useRef<SimDot[]>([]);
  const simAnimRef = useRef<number | null>(null);
  const simPlayStartRef = useRef<number | null>(null);
  const simElapsedAtPauseRef = useRef<number>(0);
  const simIsPlayingRef = useRef(false);
  const simIsFinishedRef = useRef(false);
  const simulationStatusRef = useRef(onSimulationStatus);
  simulationStatusRef.current = onSimulationStatus;

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

  // ── simulation: build dots from current indicators ──────────────────────
  function buildSimDots(): SimDot[] {
    const gj = geojsonRef.current;
    if (!gj) return [];
    const inds = indicatorsRef.current;
    const age = ageGroupRef.current;
    const out: SimDot[] = [];
    for (const feat of gj.features) {
      const code = feat.properties?.cod_dist as string | undefined;
      if (!code) continue;
      const row = inds[code]?.[age];
      if (!row || row.data_completeness_pct === 0) continue;
      out.push(
        ...generateDotsForDistrict(
          code,
          feat.geometry,
          row.pct_le15,
          row.pct_le30,
          row.pct_le60,
          DOTS_PER_DISTRICT
        )
      );
    }
    return out;
  }

  function emitSimStatus(simMin: number) {
    const total = simDotsRef.current.length;
    const arrived = simDotsRef.current.filter((d) => d.status === 1).length;
    simulationStatusRef.current({
      simMin,
      arrivedPct: total === 0 ? 0 : Math.round((arrived / total) * 100),
      isPlaying: simIsPlayingRef.current,
      isFinished: simIsFinishedRef.current,
    });
  }

  function simTick() {
    const map = mapRef.current;
    if (!map || simPlayStartRef.current === null) return;

    const realMs =
      performance.now() - simPlayStartRef.current + simElapsedAtPauseRef.current;
    const simMin = Math.min(
      SIM_MINUTES,
      (realMs / (SIM_DURATION_SEC * 1000)) * SIM_MINUTES
    );

    const dtRealSec = 0.016;
    const simMinPerSec = SIM_MINUTES / SIM_DURATION_SEC;
    const dt = dtRealSec * simMinPerSec;

    for (const d of simDotsRef.current) {
      if (d.status === 0 && simMin >= d.arrivalMin) d.status = 1;
      if (d.status !== 1) {
        d.lng += d.vlng * dt;
        d.lat += d.vlat * dt;
        if (d.lng < d.bMinLng) { d.lng = d.bMinLng; d.vlng = -d.vlng; }
        if (d.lng > d.bMaxLng) { d.lng = d.bMaxLng; d.vlng = -d.vlng; }
        if (d.lat < d.bMinLat) { d.lat = d.bMinLat; d.vlat = -d.vlat; }
        if (d.lat > d.bMaxLat) { d.lat = d.bMaxLat; d.vlat = -d.vlat; }
      }
    }

    const source = map.getSource('dots-sim') as maplibregl.GeoJSONSource | undefined;
    source?.setData(dotsToFeatures(simDotsRef.current));

    if (simMin >= SIM_MINUTES) {
      // Final: any still-walking dots that never arrive turn red
      for (const d of simDotsRef.current) {
        if (d.status === 0 && d.arrivalMin === Infinity) d.status = 2;
      }
      source?.setData(dotsToFeatures(simDotsRef.current));
      simIsPlayingRef.current = false;
      simIsFinishedRef.current = true;
      simPlayStartRef.current = null;
      simElapsedAtPauseRef.current = 0;
      emitSimStatus(SIM_MINUTES);
      return;
    }

    emitSimStatus(simMin);
    simAnimRef.current = requestAnimationFrame(simTick);
  }

  function setChoroplethDimmed(dim: boolean) {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setPaintProperty('districts-fill', 'fill-opacity', dim ? 0.12 : 0.82);
  }

  // Toggle simulation overlay on/off when simulationActive changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    if (simulationActive) {
      // Build dots, add source + layer (if not already), dim choropleth
      const dots = buildSimDots();
      simDotsRef.current = dots;
      simIsFinishedRef.current = false;
      simIsPlayingRef.current = false;
      simPlayStartRef.current = null;
      simElapsedAtPauseRef.current = 0;

      if (!map.getSource('dots-sim')) {
        map.addSource('dots-sim', {
          type: 'geojson',
          data: dotsToFeatures(dots),
        });
        map.addLayer({
          id: 'dots-sim-layer',
          type: 'circle',
          source: 'dots-sim',
          paint: {
            'circle-radius': 3,
            'circle-color': [
              'match',
              ['get', 'status'],
              1, '#16a34a', // arrived (emerald)
              2, '#dc2626', // never
              '#eab308',    // walking (amber)
            ] as unknown as maplibregl.ExpressionSpecification,
            'circle-stroke-width': 0.6,
            'circle-stroke-color': '#ffffff',
            'circle-opacity': 0.95,
          },
        });
      } else {
        (map.getSource('dots-sim') as maplibregl.GeoJSONSource).setData(dotsToFeatures(dots));
      }
      setChoroplethDimmed(true);
      emitSimStatus(0);
    } else {
      // Cancel anim, remove layer + source, restore choropleth
      if (simAnimRef.current) {
        cancelAnimationFrame(simAnimRef.current);
        simAnimRef.current = null;
      }
      if (map.getLayer('dots-sim-layer')) map.removeLayer('dots-sim-layer');
      if (map.getSource('dots-sim')) map.removeSource('dots-sim');
      simDotsRef.current = [];
      simIsPlayingRef.current = false;
      simIsFinishedRef.current = false;
      simPlayStartRef.current = null;
      simElapsedAtPauseRef.current = 0;
      setChoroplethDimmed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationActive]);

  // When age/transport changes during an active simulation, regenerate dots
  useEffect(() => {
    if (!simulationActive) return;
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (simAnimRef.current) {
      cancelAnimationFrame(simAnimRef.current);
      simAnimRef.current = null;
    }
    const dots = buildSimDots();
    simDotsRef.current = dots;
    simIsPlayingRef.current = false;
    simIsFinishedRef.current = false;
    simPlayStartRef.current = null;
    simElapsedAtPauseRef.current = 0;
    const source = map.getSource('dots-sim') as maplibregl.GeoJSONSource | undefined;
    source?.setData(dotsToFeatures(dots));
    emitSimStatus(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgeGroup, activeTransport]);

  // React to play/pause/replay commands from the side panel
  useEffect(() => {
    if (!simulationActive) return;
    if (simulationCommand.type === 'idle') return;
    const map = mapRef.current;
    if (!map) return;

    if (simulationCommand.type === 'play') {
      if (simIsPlayingRef.current) return;
      if (simIsFinishedRef.current) {
        // Reset before play
        const dots = buildSimDots();
        simDotsRef.current = dots;
        simIsFinishedRef.current = false;
        simElapsedAtPauseRef.current = 0;
        (map.getSource('dots-sim') as maplibregl.GeoJSONSource | undefined)?.setData(
          dotsToFeatures(dots)
        );
      }
      simIsPlayingRef.current = true;
      simPlayStartRef.current = performance.now();
      emitSimStatus(simElapsedAtPauseRef.current / (SIM_DURATION_SEC * 1000) * SIM_MINUTES);
      simAnimRef.current = requestAnimationFrame(simTick);
    } else if (simulationCommand.type === 'pause') {
      if (!simIsPlayingRef.current) return;
      if (simPlayStartRef.current !== null) {
        simElapsedAtPauseRef.current += performance.now() - simPlayStartRef.current;
        simPlayStartRef.current = null;
      }
      if (simAnimRef.current) cancelAnimationFrame(simAnimRef.current);
      simAnimRef.current = null;
      simIsPlayingRef.current = false;
      emitSimStatus(simElapsedAtPauseRef.current / (SIM_DURATION_SEC * 1000) * SIM_MINUTES);
    } else if (simulationCommand.type === 'replay') {
      if (simAnimRef.current) cancelAnimationFrame(simAnimRef.current);
      const dots = buildSimDots();
      simDotsRef.current = dots;
      simIsFinishedRef.current = false;
      simElapsedAtPauseRef.current = 0;
      simIsPlayingRef.current = true;
      simPlayStartRef.current = performance.now();
      (map.getSource('dots-sim') as maplibregl.GeoJSONSource | undefined)?.setData(
        dotsToFeatures(dots)
      );
      emitSimStatus(0);
      simAnimRef.current = requestAnimationFrame(simTick);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationCommand]);

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
