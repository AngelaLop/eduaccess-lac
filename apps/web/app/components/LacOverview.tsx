'use client';

/**
 * LacOverview — the platform's first view: a region-level choropleth of Latin
 * America. Each country is one polygon shaded by its country-total % within
 * 30 min of a school. The five countries with data are coloured; the rest of
 * the 21 LAC countries render grey ("data coming"). Click a country with data
 * to drop into its district-level view.
 */

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { supabase } from '@/lib/supabase';
import {
  COUNTRY_ISOS,
  EDUCATION_LEVELS,
  EDUCATION_LEVEL_SHORT_LABELS,
  TRANSPORT_LABELS,
  type CountryIso,
  type EducationLevel,
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

const fillExpr: maplibregl.ExpressionSpecification = [
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

const WITH_DATA = new Set<string>(COUNTRY_ISOS);

interface Props {
  onSelectCountry: (iso: CountryIso) => void;
}

// pct keyed `${country_iso}:${level}:${mode}` — country-total le30
type PctMap = Record<string, number>;

export default function LacOverview({ onSelectCountry }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const [level, setLevel] = useState<EducationLevel>('secalta');
  const [transport, setTransport] = useState<TransportMode>('walking');
  const [pct, setPct] = useState<PctMap>({});

  const pctRef = useRef<PctMap>(pct);
  const levelRef = useRef<EducationLevel>(level);
  const transportRef = useRef<TransportMode>(transport);
  pctRef.current = pct;
  levelRef.current = level;
  transportRef.current = transport;
  const onSelectRef = useRef(onSelectCountry);
  onSelectRef.current = onSelectCountry;

  // ── load country-total accessibility (once) ───────────────────────────────
  useEffect(() => {
    let cancelled = false;
    supabase
      .from('accessibility_indicators')
      .select('country_iso, education_level, mode, value')
      .eq('idgeo', 'country')
      .eq('method', 'FMM')
      .eq('sector', 'Total')
      .eq('area', 'Total')
      .eq('quintile', 'Total')
      .eq('time_band', 'le30')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('[LacOverview] country totals:', error);
          return;
        }
        const next: PctMap = {};
        for (const r of (data as Record<string, unknown>[]) ?? []) {
          if (r.value == null) continue;
          next[`${r.country_iso}:${r.education_level}:${r.mode}`] = Number(r.value);
        }
        setPct(next);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── push the active slice into feature-state ──────────────────────────────
  function applyStates(map: maplibregl.Map) {
    if (!map.getSource('lac')) return;
    for (const iso of COUNTRY_ISOS) {
      const v = pctRef.current[`${iso}:${levelRef.current}:${transportRef.current}`];
      map.setFeatureState(
        { source: 'lac', id: iso },
        { has_data: v == null ? 0 : 1, pct: v ?? 0 }
      );
    }
  }

  // ── map init (once) ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: [-77, -9],
      zoom: 2.4,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 8,
      className: 'eduaccess-popup',
    });
    popupRef.current = popup;

    map.on('click', 'lac-fill', (e) => {
      const iso = e.features?.[0]?.properties?.country_iso as string | undefined;
      if (iso && WITH_DATA.has(iso)) onSelectRef.current(iso as CountryIso);
    });
    map.on('mouseenter', 'lac-fill', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mousemove', 'lac-fill', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const iso = f.properties?.country_iso as string;
      const name = (f.properties?.country_name as string | undefined) ?? iso;
      const v = pctRef.current[`${iso}:${levelRef.current}:${transportRef.current}`];
      const line =
        v == null
          ? '<span style="color:#a3a3a3;">Data coming soon</span>'
          : `<strong>${v.toFixed(1)}%</strong> within 30 min`;
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font: 12px ui-sans-serif, system-ui; line-height: 1.35;">
             <div style="font-weight: 600; color: #171717;">${name}</div>
             <div style="margin-top: 2px; color: #404040;">${line}</div>
           </div>`
        )
        .addTo(map);
    });
    map.on('mouseleave', 'lac-fill', () => {
      map.getCanvas().style.cursor = '';
      popup.remove();
    });

    map.on('load', async () => {
      const res = await fetch('/lac_countries.geojson');
      const gj: GeoJSON.FeatureCollection = await res.json();
      if (!mapRef.current) return;
      map.addSource('lac', { type: 'geojson', data: gj, promoteId: 'country_iso' });
      map.addLayer({
        id: 'lac-fill',
        type: 'fill',
        source: 'lac',
        paint: {
          'fill-color': fillExpr,
          'fill-opacity': 0.85,
          'fill-color-transition': { duration: 0, delay: 0 },
        },
      });
      map.addLayer({
        id: 'lac-border',
        type: 'line',
        source: 'lac',
        paint: { 'line-color': '#ffffff', 'line-width': 0.7 },
      });
      applyStates(map);
      setMapReady(true);
    });

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

  // ── re-colour on data load or level / transport change ────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    applyStates(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pct, level, transport, mapReady]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-neutral-200 bg-white px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
              EduAccess LAC
            </h1>
            <p className="mt-0.5 text-xs text-neutral-500">
              School access across Latin America — pick a country to explore its districts.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-0.5 rounded-md bg-neutral-100 p-0.5">
              {EDUCATION_LEVELS.map((g) => (
                <button
                  key={g}
                  onClick={() => setLevel(g)}
                  className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                    level === g
                      ? 'bg-white text-emerald-700 shadow-sm'
                      : 'text-neutral-500 hover:text-neutral-700'
                  }`}
                >
                  {EDUCATION_LEVEL_SHORT_LABELS[g]}
                </button>
              ))}
            </div>
            <div className="flex gap-0.5 rounded-md bg-neutral-100 p-0.5">
              {(Object.keys(TRANSPORT_LABELS) as TransportMode[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTransport(t)}
                  className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                    transport === t
                      ? 'bg-white text-emerald-700 shadow-sm'
                      : 'text-neutral-500 hover:text-neutral-700'
                  }`}
                >
                  {TRANSPORT_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
        </div>
        {/* Legend */}
        <div className="mt-2 flex items-center gap-1">
          <span className="mr-0.5 text-[10px] text-neutral-400">Worse</span>
          {COLOR_STEPS.map(([, color]) => (
            <span
              key={color}
              className="inline-block h-2 w-5 shrink-0 rounded-sm"
              style={{ backgroundColor: color }}
            />
          ))}
          <span className="ml-0.5 mr-2 text-[10px] text-neutral-400">Better</span>
          <span
            className="inline-block h-2 w-5 shrink-0 rounded-sm"
            style={{ backgroundColor: NO_DATA_COLOR }}
          />
          <span className="ml-0.5 text-[10px] text-neutral-400">Data coming soon</span>
        </div>
      </div>

      {/* Map */}
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}
