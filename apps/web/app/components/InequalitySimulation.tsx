'use client';

/**
 * Inequality Simulation — particle visualization.
 *
 * For each district, ~10 dots represent children. Each dot is assigned an
 * "arrival time" sampled from the district's pct_le15/le30/le60 distribution:
 *   - some arrive within 15 simulated minutes (green by t=15s × 10s/60min)
 *   - some between 15-30 min
 *   - some between 30-60 min
 *   - some never (pop_nodata + pct above 60min) → stay yellow then turn red
 *
 * Real-time compression: 10 seconds of wall-clock = 60 simulated minutes.
 *
 * Visual storytelling goal: at the end of the animation, the districts with
 * still-moving dots (yellow / red) are the inequality. The eye is drawn to
 * motion against the still backdrop of arrived (green, frozen) dots.
 */

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { AgeGroup, IndicatorsByDist, TransportMode } from '@/lib/types';
import { AGE_GROUP_NARRATIVE, TRANSPORT_LABELS } from '@/lib/types';

const SIM_DURATION_SEC = 10;        // wall-clock seconds for the whole animation
const SIM_MINUTES = 60;             // simulated minutes spanned
const DOTS_PER_DISTRICT = 10;
const PANAMA_VIEW = { center: [-80.0, 8.5] as [number, number], zoom: 6.3 };

interface Dot {
  id: string;
  lng: number;
  lat: number;
  vlng: number;          // per-simulated-minute drift
  vlat: number;
  arrivalMin: number;    // simulated minute the child reaches a school; Infinity = never
  status: 0 | 1 | 2;     // 0 walking · 1 arrived · 2 never (post-60 still walking)
  bboxMinLng: number;
  bboxMaxLng: number;
  bboxMinLat: number;
  bboxMaxLat: number;
}

interface Props {
  indicators: IndicatorsByDist;
  ageGroup: AgeGroup;
  transport: TransportMode;
  onClose: () => void;
}

// ── geometry helpers ──────────────────────────────────────────────────────────

function bboxOf(geometry: GeoJSON.Geometry) {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  function walk(coords: unknown) {
    if (Array.isArray(coords) && typeof coords[0] === 'number') {
      const x = coords[0] as number;
      const y = coords[1] as number;
      if (x < minLng) minLng = x;
      if (x > maxLng) maxLng = x;
      if (y < minLat) minLat = y;
      if (y > maxLat) maxLat = y;
    } else if (Array.isArray(coords)) {
      for (const c of coords) walk(c);
    }
  }
  if ('coordinates' in geometry) walk(geometry.coordinates);
  return { minLng, maxLng, minLat, maxLat };
}

function generateDotsForDistrict(
  cod_dist: string,
  geometry: GeoJSON.Geometry,
  pct_le15: number,
  pct_le30: number,
  pct_le60: number,
  count: number
): Dot[] {
  const { minLng, maxLng, minLat, maxLat } = bboxOf(geometry);
  if (!Number.isFinite(minLng)) return [];

  const cLng = (minLng + maxLng) / 2;
  const cLat = (minLat + maxLat) / 2;
  const spanLng = maxLng - minLng;
  const spanLat = maxLat - minLat;

  const fLe15 = Math.max(0, pct_le15) / 100;
  const f15_30 = Math.max(0, pct_le30 - pct_le15) / 100;
  const f30_60 = Math.max(0, pct_le60 - pct_le30) / 100;

  const dots: Dot[] = [];
  for (let i = 0; i < count; i++) {
    // Start near the polygon's bbox centroid, jitter inside ~40% of the bbox.
    const lng = cLng + (Math.random() - 0.5) * spanLng * 0.4;
    const lat = cLat + (Math.random() - 0.5) * spanLat * 0.4;

    // Wandering velocity (per simulated minute). Slow enough to read at this zoom.
    const angle = Math.random() * Math.PI * 2;
    const speedFactor = 0.03 + Math.random() * 0.025;
    const vlng = Math.cos(angle) * speedFactor * spanLng;
    const vlat = Math.sin(angle) * speedFactor * spanLat;

    const r = Math.random();
    let arrivalMin: number;
    if (r < fLe15) {
      arrivalMin = Math.random() * 15;
    } else if (r < fLe15 + f15_30) {
      arrivalMin = 15 + Math.random() * 15;
    } else if (r < fLe15 + f15_30 + f30_60) {
      arrivalMin = 30 + Math.random() * 30;
    } else {
      arrivalMin = Infinity;
    }

    dots.push({
      id: `${cod_dist}_${i}`,
      lng,
      lat,
      vlng,
      vlat,
      arrivalMin,
      status: 0,
      bboxMinLng: minLng,
      bboxMaxLng: maxLng,
      bboxMinLat: minLat,
      bboxMaxLat: maxLat,
    });
  }
  return dots;
}

function dotsToFeatureCollection(dots: Dot[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: dots.map((d) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [d.lng, d.lat] },
      properties: { status: d.status, id: d.id },
    })),
  };
}

// ── component ────────────────────────────────────────────────────────────────

export default function InequalitySimulation({
  indicators,
  ageGroup,
  transport,
  onClose,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const dotsRef = useRef<Dot[]>([]);
  const animationRef = useRef<number | null>(null);
  const playStartRef = useRef<number | null>(null);   // wall-clock ms at play start
  const elapsedAtPauseRef = useRef<number>(0);        // accumulated sim time across plays

  const [isPlaying, setIsPlaying] = useState(false);
  const [simMin, setSimMin] = useState(0);
  const [arrivedPct, setArrivedPct] = useState(0);
  const [hasFinished, setHasFinished] = useState(false);

  // ── mount the map ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: PANAMA_VIEW.center,
      zoom: PANAMA_VIEW.zoom,
      attributionControl: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.AttributionControl({ compact: true }));

    map.on('load', async () => {
      // District outlines for orientation — same source the main map uses.
      const res = await fetch('/panama_districts.simplified.geojson');
      const gj: GeoJSON.FeatureCollection = await res.json();

      // Build dots up front from the geojson + current indicators.
      const allDots: Dot[] = [];
      for (const feature of gj.features) {
        const code = feature.properties?.cod_dist as string | undefined;
        if (!code) continue;
        const row = indicators[code]?.[ageGroup];
        if (!row || row.data_completeness_pct === 0) continue;
        const made = generateDotsForDistrict(
          code,
          feature.geometry,
          row.pct_le15,
          row.pct_le30,
          row.pct_le60,
          DOTS_PER_DISTRICT
        );
        allDots.push(...made);
      }
      dotsRef.current = allDots;

      map.addSource('districts', { type: 'geojson', data: gj });
      map.addLayer({
        id: 'districts-outline',
        type: 'line',
        source: 'districts',
        paint: { 'line-color': '#a3a3a3', 'line-width': 0.5 },
      });

      map.addSource('dots', { type: 'geojson', data: dotsToFeatureCollection(allDots) });
      map.addLayer({
        id: 'dots-layer',
        type: 'circle',
        source: 'dots',
        paint: {
          'circle-radius': 2.5,
          'circle-color': [
            'match',
            ['get', 'status'],
            1, '#16a34a',   // arrived
            2, '#dc2626',   // never (still walking past 60 min)
            '#eab308',      // walking (default)
          ] as unknown as maplibregl.ExpressionSpecification,
          'circle-stroke-width': 0.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9,
        },
      });
    });

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      map.remove();
      mapRef.current = null;
    };
  }, [indicators, ageGroup]);

  // ── animation tick ─────────────────────────────────────────────────────────
  function tick() {
    const map = mapRef.current;
    const source = map?.getSource('dots') as maplibregl.GeoJSONSource | undefined;
    if (!map || !source || !playStartRef.current) return;

    const realMs = performance.now() - playStartRef.current + elapsedAtPauseRef.current;
    const totalSimMin = Math.min(SIM_MINUTES, (realMs / (SIM_DURATION_SEC * 1000)) * SIM_MINUTES);

    // Advance every dot
    let arrived = 0;
    const total = dotsRef.current.length;
    for (const d of dotsRef.current) {
      // status transitions
      if (d.status === 0 && totalSimMin >= d.arrivalMin) {
        d.status = 1; // arrived (frozen in place)
      } else if (d.status === 0 && d.arrivalMin === Infinity && totalSimMin >= SIM_MINUTES) {
        d.status = 2; // never made it
      }

      if (d.status !== 1) {
        // walking or "never" — keep moving
        const dt = 0.016 * (SIM_MINUTES / SIM_DURATION_SEC); // approx 1 sim-min per ~166ms real
        d.lng += d.vlng * dt;
        d.lat += d.vlat * dt;
        // Bounce off the district bbox edges
        if (d.lng < d.bboxMinLng) { d.lng = d.bboxMinLng; d.vlng = -d.vlng; }
        if (d.lng > d.bboxMaxLng) { d.lng = d.bboxMaxLng; d.vlng = -d.vlng; }
        if (d.lat < d.bboxMinLat) { d.lat = d.bboxMinLat; d.vlat = -d.vlat; }
        if (d.lat > d.bboxMaxLat) { d.lat = d.bboxMaxLat; d.vlat = -d.vlat; }
      }
      if (d.status === 1) arrived++;
    }

    source.setData(dotsToFeatureCollection(dotsRef.current));
    setSimMin(Math.round(totalSimMin));
    setArrivedPct(total === 0 ? 0 : Math.round((arrived / total) * 100));

    if (totalSimMin >= SIM_MINUTES) {
      // Final pass: any still-walking dots that never arrive turn red.
      let changed = false;
      for (const d of dotsRef.current) {
        if (d.status === 0 && d.arrivalMin === Infinity) {
          d.status = 2;
          changed = true;
        }
      }
      if (changed) source.setData(dotsToFeatureCollection(dotsRef.current));
      setIsPlaying(false);
      setHasFinished(true);
      playStartRef.current = null;
      elapsedAtPauseRef.current = 0;
      return;
    }
    animationRef.current = requestAnimationFrame(tick);
  }

  function handlePlay() {
    if (hasFinished) handleReplay();
    setIsPlaying(true);
    playStartRef.current = performance.now();
    animationRef.current = requestAnimationFrame(tick);
  }

  function handlePause() {
    setIsPlaying(false);
    if (playStartRef.current) {
      elapsedAtPauseRef.current += performance.now() - playStartRef.current;
      playStartRef.current = null;
    }
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
  }

  function handleReplay() {
    const map = mapRef.current;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    elapsedAtPauseRef.current = 0;
    playStartRef.current = null;
    setSimMin(0);
    setArrivedPct(0);
    setHasFinished(false);

    // Regenerate dots from scratch
    if (map) {
      const source = map.getSource('dots') as maplibregl.GeoJSONSource | undefined;
      const districts = map.getSource('districts') as maplibregl.GeoJSONSource | undefined;
      if (districts && source) {
        const data = (districts as unknown as { _data: GeoJSON.FeatureCollection })._data;
        if (data) {
          const allDots: Dot[] = [];
          for (const feature of data.features) {
            const code = feature.properties?.cod_dist as string | undefined;
            if (!code) continue;
            const row = indicators[code]?.[ageGroup];
            if (!row || row.data_completeness_pct === 0) continue;
            const made = generateDotsForDistrict(
              code,
              feature.geometry,
              row.pct_le15,
              row.pct_le30,
              row.pct_le60,
              DOTS_PER_DISTRICT
            );
            allDots.push(...made);
          }
          dotsRef.current = allDots;
          source.setData(dotsToFeatureCollection(allDots));
        }
      }
    }
    setIsPlaying(true);
    playStartRef.current = performance.now();
    animationRef.current = requestAnimationFrame(tick);
  }

  // ── render ────────────────────────────────────────────────────────────────
  const narrative = AGE_GROUP_NARRATIVE[ageGroup];
  const mode = TRANSPORT_LABELS[transport].toLowerCase();
  const progressPct = (simMin / SIM_MINUTES) * 100;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-neutral-950/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      {/* Header */}
      <div className="flex items-start justify-between px-4 py-3 sm:px-6">
        <div>
          <h2 className="text-lg font-semibold text-white sm:text-xl">
            An hour of {mode} in Panama
          </h2>
          <p className="mt-0.5 text-xs text-neutral-400 sm:text-sm">
            Each dot is a child. Yellow = still {mode}. Green = reached a school.
            Red = still {mode} after 60 minutes.
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close simulation"
          className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
            <path d="M6.3 6.3a1 1 0 011.4 0L10 8.6l2.3-2.3a1 1 0 111.4 1.4L11.4 10l2.3 2.3a1 1 0 11-1.4 1.4L10 11.4l-2.3 2.3a1 1 0 01-1.4-1.4L8.6 10 6.3 7.7a1 1 0 010-1.4z" />
          </svg>
        </button>
      </div>

      {/* Map */}
      <div className="relative mx-auto w-full max-w-5xl flex-1 px-2 pb-2 sm:px-4">
        <div ref={containerRef} className="h-full w-full overflow-hidden rounded-md" />
      </div>

      {/* Caption strip */}
      <div className="border-t border-neutral-800 bg-neutral-900 px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-2">
          <div className="flex items-baseline justify-between text-xs text-neutral-300">
            <span>
              Simulated time:{' '}
              <strong className="font-mono tabular-nums text-white">{simMin}</strong> /{' '}
              {SIM_MINUTES} min
            </span>
            <span className="text-neutral-400">
              {arrivedPct}% of {narrative} have reached a school
            </span>
          </div>
          <div className="relative h-1 w-full overflow-hidden rounded-full bg-neutral-800">
            <div
              className="absolute inset-y-0 left-0 bg-emerald-500 transition-[width] duration-100 ease-linear"
              style={{ width: `${progressPct}%` }}
            />
            {[15, 30].map((mark) => (
              <div
                key={mark}
                className="absolute inset-y-0 w-px bg-neutral-600"
                style={{ left: `${(mark / SIM_MINUTES) * 100}%` }}
                aria-hidden
              />
            ))}
          </div>
          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-2">
              {!isPlaying && !hasFinished && (
                <button
                  onClick={handlePlay}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
                >
                  ▶ Play
                </button>
              )}
              {isPlaying && (
                <button
                  onClick={handlePause}
                  className="rounded-md bg-neutral-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-600"
                >
                  ❚❚ Pause
                </button>
              )}
              {hasFinished && (
                <button
                  onClick={handleReplay}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
                >
                  ↻ Replay
                </button>
              )}
            </div>
            <p className="text-[11px] text-neutral-500">
              10 seconds of wall-clock = 60 simulated minutes of travel.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
