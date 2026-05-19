'use client';

/**
 * LacOverview — the platform's first view. Same map + right-panel layout as the
 * per-country shell: a region-level choropleth of Latin America on the left and
 * a right panel with a region summary + a clickable country ranking. The five
 * countries with data are coloured / ranked; the rest of the 21 LAC countries
 * render grey. Click a country (map or list) to drop into its district view.
 *
 * Map view toggle — compares all countries on one map by:
 *   access     → country-total % within 30 min of a school
 *   area_gap   → urban % minus rural % (points)
 *   wealth_gap → wealthiest-quintile % minus poorest-quintile % (points)
 *
 * Colour is DATA-RELATIVE: with only five countries the ramp is stretched to
 * the actual min/max of whatever is shown, so the spread between countries is
 * always visible. The legend prints those min/max values so it stays honest.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { supabase } from '@/lib/supabase';
import {
  COUNTRIES,
  COUNTRY_ISOS,
  EDUCATION_LEVELS,
  EDUCATION_LEVEL_NARRATIVE,
  EDUCATION_LEVEL_SHORT_LABELS,
  TRANSPORT_LABELS,
  type CountryIso,
  type EducationLevel,
  type TransportMode,
} from '@/lib/types';

// Diverging ramps, low → high. Access: low access is red. Gap: a small gap is
// good, so the ramp runs green → red as the gap widens.
const ACCESS_RAMP = ['#b91c1c', '#f97316', '#eab308', '#65a30d', '#15803d'];
const GAP_RAMP = ['#15803d', '#65a30d', '#eab308', '#f97316', '#b91c1c'];
const NO_DATA_COLOR = '#d1d5db';

// Stretch a ramp across [min, max] as a continuous interpolation, so the five
// covered countries always span the full colour range.
function rampFill(min: number, max: number, ramp: string[]): maplibregl.ExpressionSpecification {
  const span = max - min || 1;
  const stops = ramp.flatMap((c, i) => [min + (span * i) / (ramp.length - 1), c]);
  return [
    'case',
    ['!=', ['feature-state', 'has_data'], 1],
    NO_DATA_COLOR,
    ['interpolate', ['linear'], ['coalesce', ['feature-state', 'pct'], min], ...stops],
  ] as unknown as maplibregl.ExpressionSpecification;
}

// Countries without data render faint — they recede so the five covered
// countries read as the active layer.
const fillOpacityExpr: maplibregl.ExpressionSpecification = [
  'case',
  ['!=', ['feature-state', 'has_data'], 1],
  0.25,
  0.85,
] as unknown as maplibregl.ExpressionSpecification;

const WITH_DATA = new Set<string>(COUNTRY_ISOS);

// The 3D-globe fly-in plays once per page load — the entry flourish. Going
// back to the overview from a country lands flat, no replay.
let introPlayed = false;

// ── map view metric ──────────────────────────────────────────────────────────

type Metric = 'access' | 'area_gap' | 'wealth_gap';

const METRICS: Metric[] = ['access', 'area_gap', 'wealth_gap'];
const METRIC_BUTTON: Record<Metric, string> = {
  access: 'Access',
  area_gap: 'Area gap',
  wealth_gap: 'Wealth gap',
};
const METRIC_HELP: Record<Metric, string> = {
  access: 'Each country shaded by its share of students within 30 min of a school.',
  area_gap:
    'Area gap: each country’s difference between urban and rural 30-min access.',
  wealth_gap:
    'Wealth gap: each country’s difference between the wealthiest fifth (quintile 5) and the poorest (quintile 1).',
};

interface Props {
  onSelectCountry: (iso: CountryIso) => void;
}

interface CountryStat {
  /** % within 30 min — area=Total, quintile=Total */
  accessPct?: number;
  pop: number;
  urbanPct?: number;
  ruralPct?: number;
  /** quintile_1 = poorest fifth, quintile_5 = wealthiest fifth */
  q1Pct?: number;
  q5Pct?: number;
}
// keyed `${country_iso}:${level}:${mode}`
type StatMap = Record<string, CountryStat>;

// The value driving the choropleth + ranking for the active metric. null when
// that country has no data for the metric (→ rendered grey).
function metricValue(stat: CountryStat | undefined, metric: Metric): number | null {
  if (!stat) return null;
  if (metric === 'access') return stat.accessPct ?? null;
  if (metric === 'area_gap') {
    return stat.urbanPct != null && stat.ruralPct != null
      ? stat.urbanPct - stat.ruralPct
      : null;
  }
  return stat.q5Pct != null && stat.q1Pct != null ? stat.q5Pct - stat.q1Pct : null;
}

export default function LacOverview({ onSelectCountry }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const [level, setLevel] = useState<EducationLevel>('secalta');
  const [transport, setTransport] = useState<TransportMode>('walking');
  const [metric, setMetric] = useState<Metric>('access');
  const [stats, setStats] = useState<StatMap>({});

  const statsRef = useRef<StatMap>(stats);
  const levelRef = useRef<EducationLevel>(level);
  const transportRef = useRef<TransportMode>(transport);
  const metricRef = useRef<Metric>(metric);
  const onSelectRef = useRef(onSelectCountry);
  statsRef.current = stats;
  levelRef.current = level;
  transportRef.current = transport;
  metricRef.current = metric;
  onSelectRef.current = onSelectCountry;

  // ── load country-level slices (once) ──────────────────────────────────────
  // One broad query: country totals plus the urban/rural and quintile_1/_5
  // rows, so all three map metrics derive from a single fetch.
  useEffect(() => {
    let cancelled = false;
    supabase
      .from('accessibility_indicators')
      .select('country_iso, education_level, mode, area, quintile, value, population_base')
      .eq('idgeo', 'country')
      .eq('method', 'FMM')
      .eq('sector', 'Total')
      .eq('time_band', 'le30')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('[LacOverview] country slices:', error);
          return;
        }
        const next: StatMap = {};
        for (const r of (data as Record<string, unknown>[]) ?? []) {
          if (r.value == null) continue;
          const key = `${r.country_iso}:${r.education_level}:${r.mode}`;
          const cur = next[key] ?? { pop: 0 };
          const val = Number(r.value);
          const area = r.area;
          const q = r.quintile;
          if (area === 'Total' && q === 'Total') {
            cur.accessPct = val;
            cur.pop = Number(r.population_base ?? 0);
          } else if (area === 'urban' && q === 'Total') {
            cur.urbanPct = val;
          } else if (area === 'rural' && q === 'Total') {
            cur.ruralPct = val;
          } else if (area === 'Total' && q === 'quintile_1') {
            cur.q1Pct = val;
          } else if (area === 'Total' && q === 'quintile_5') {
            cur.q5Pct = val;
          }
          next[key] = cur;
        }
        setStats(next);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── region summary + country ranking for the active level/mode/metric ─────
  const summary = useMemo(() => {
    const entries = COUNTRY_ISOS.map((iso) => {
      const stat = stats[`${iso}:${level}:${transport}`];
      return { iso, stat, value: metricValue(stat, metric) };
    }).filter(
      (e): e is { iso: CountryIso; stat: CountryStat; value: number } => e.value !== null
    );

    // access → weakest (lowest %) first; gaps → widest gap first.
    const ranking = [...entries].sort((a, b) =>
      metric === 'access' ? a.value - b.value : b.value - a.value
    );

    let headline = 0;
    let underserved: number | null = null;
    if (metric === 'access') {
      let totalPop = 0;
      let reached = 0;
      for (const { stat, value } of entries) {
        totalPop += stat.pop;
        reached += stat.pop * (value / 100);
      }
      headline = totalPop > 0 ? Math.round((reached / totalPop) * 100) : 0;
      underserved = Math.max(0, Math.round(totalPop - reached));
    } else {
      headline = entries.length
        ? Math.round(entries.reduce((s, e) => s + e.value, 0) / entries.length)
        : 0;
    }

    const values = ranking.map((r) => r.value);
    const domain: [number, number] = values.length
      ? [Math.min(...values), Math.max(...values)]
      : [0, 1];

    return {
      headline,
      underserved,
      ranking,
      maxValue: Math.max(...values, 1),
      domain,
      ready: Object.keys(stats).length > 0,
    };
  }, [stats, level, transport, metric]);

  // ── feature-state ─────────────────────────────────────────────────────────
  function applyStates(map: maplibregl.Map) {
    if (!map.getSource('lac')) return;
    for (const iso of COUNTRY_ISOS) {
      const s = statsRef.current[`${iso}:${levelRef.current}:${transportRef.current}`];
      const v = metricValue(s, metricRef.current);
      map.setFeatureState(
        { source: 'lac', id: iso },
        { has_data: v != null ? 1 : 0, pct: v ?? 0 }
      );
    }
  }

  // ── map init (once) ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // First entry of the page load → start as a 3D globe and fly into LAC.
    const playIntro = !introPlayed;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: playIntro ? [-72, 4] : [-77, -9],
      zoom: playIntro ? 0.35 : 2.2,
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
      const s = statsRef.current[`${iso}:${levelRef.current}:${transportRef.current}`];
      const m = metricRef.current;
      const v = metricValue(s, m);
      let line: string;
      if (v == null) {
        line = '<span style="color:#a3a3a3;">Data coming soon</span>';
      } else if (m === 'access') {
        line = `<strong>${v.toFixed(1)}%</strong> within 30 min`;
      } else {
        line = `<strong>${v.toFixed(0)} pts</strong> ${
          m === 'area_gap' ? 'urban–rural' : 'wealth'
        } gap`;
      }
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
      // Style is loaded here — safe to switch projection to the 3D globe.
      if (playIntro) map.setProjection({ type: 'globe' });
      const res = await fetch('/lac_countries.geojson');
      const gj: GeoJSON.FeatureCollection = await res.json();
      if (!mapRef.current) return;
      map.addSource('lac', { type: 'geojson', data: gj, promoteId: 'country_iso' });
      map.addLayer({
        id: 'lac-fill',
        type: 'fill',
        source: 'lac',
        paint: {
          // Real colours are set by the recolour effect once data lands.
          'fill-color': NO_DATA_COLOR,
          'fill-opacity': fillOpacityExpr,
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

      // Frame the map on the countries we actually have data for, rather than
      // all of LAC — so the five covered countries read clearly.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const walk = (c: unknown): void => {
        if (Array.isArray(c) && typeof c[0] === 'number') {
          minX = Math.min(minX, c[0] as number);
          maxX = Math.max(maxX, c[0] as number);
          minY = Math.min(minY, c[1] as number);
          maxY = Math.max(maxY, c[1] as number);
        } else if (Array.isArray(c)) {
          for (const v of c) walk(v);
        }
      };
      for (const f of gj.features) {
        const iso = f.properties?.country_iso as string | undefined;
        if (iso && WITH_DATA.has(iso) && f.geometry && 'coordinates' in f.geometry) {
          walk(f.geometry.coordinates);
        }
      }
      if (Number.isFinite(minX)) {
        const bounds: [[number, number], [number, number]] = [
          [minX, minY],
          [maxX, maxY],
        ];
        if (playIntro) {
          introPlayed = true;
          // Fly the globe down into the region, then drop the curvature so
          // the resting view matches the normal flat overview.
          map.fitBounds(bounds, { padding: 50, duration: 3200 });
          map.once('moveend', () => map.setProjection({ type: 'mercator' }));
        } else {
          map.fitBounds(bounds, { padding: 50, duration: 0 });
        }
      }

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

  // Recolour + repaint when the data, level/mode, or map metric changes. The
  // ramp is stretched to the current metric's min/max (summary.domain).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getLayer('lac-fill')) return;
    const ramp = metric === 'access' ? ACCESS_RAMP : GAP_RAMP;
    map.setPaintProperty(
      'lac-fill',
      'fill-color',
      rampFill(summary.domain[0], summary.domain[1], ramp)
    );
    applyStates(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, level, transport, metric, mapReady]);

  const narrative = EDUCATION_LEVEL_NARRATIVE[level];
  const mode = TRANSPORT_LABELS[transport].toLowerCase();
  const isGap = metric !== 'access';
  const gapLabel = metric === 'area_gap' ? 'urban–rural' : 'wealth';
  const legendRamp = isGap ? GAP_RAMP : ACCESS_RAMP;
  const fmtLegend = (v: number) =>
    metric === 'access' ? `${Math.round(v)}%` : `${Math.round(v)} pts`;

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* ── Map ──────────────────────────────────────────────────────────── */}
      <div className="relative h-[42vh] shrink-0 md:h-auto md:min-h-0 md:flex-1 md:basis-[65%]">
        <div ref={containerRef} className="h-full w-full" />
      </div>

      {/* ── Side panel ───────────────────────────────────────────────────── */}
      <aside className="flex flex-1 flex-col overflow-hidden border-t border-neutral-200 bg-white md:flex-none md:basis-[35%] md:border-l md:border-t-0">
        {/* Header + controls */}
        <div className="shrink-0 border-b border-neutral-200 px-4 pb-2 pt-3 md:px-5 md:pb-3 md:pt-4">
          <div className="mb-2 flex items-center justify-between md:mb-3">
            <div>
              <h1 className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
                EduAccess LAC
              </h1>
              <p className="mt-0.5 text-xs text-neutral-400">Latin America · school access</p>
            </div>
            <Link
              href="/"
              className="text-xs text-neutral-400 transition-colors hover:text-neutral-600"
            >
              ← Home
            </Link>
          </div>

          {/* Map view */}
          <div className="mb-1.5 flex items-center gap-2 md:mb-2 md:gap-3">
            <span className="hidden w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 md:block">
              Map view
            </span>
            <div className="flex w-full gap-0.5 rounded-md bg-neutral-100 p-0.5 md:w-auto">
              {METRICS.map((m) => (
                <button
                  key={m}
                  onClick={() => setMetric(m)}
                  className={`flex-1 rounded px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors md:flex-none ${
                    metric === m
                      ? 'bg-white text-emerald-700 shadow-sm'
                      : 'text-neutral-500 hover:text-neutral-700'
                  }`}
                >
                  {METRIC_BUTTON[m]}
                </button>
              ))}
            </div>
          </div>

          {/* Transport */}
          <div className="mb-1.5 flex items-center gap-2 md:mb-2 md:gap-3">
            <span className="hidden w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 md:block">
              Transport
            </span>
            <div className="flex w-full gap-0.5 rounded-md bg-neutral-100 p-0.5 md:w-auto">
              {(Object.keys(TRANSPORT_LABELS) as TransportMode[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTransport(t)}
                  className={`flex-1 rounded px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors md:flex-none ${
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

          {/* Education level */}
          <div className="mb-2 flex items-center gap-2 md:mb-3 md:gap-3">
            <span className="hidden w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 md:block">
              Level
            </span>
            <div className="flex w-full gap-0.5 rounded-md bg-neutral-100 p-0.5 md:w-auto">
              {EDUCATION_LEVELS.map((g) => (
                <button
                  key={g}
                  onClick={() => setLevel(g)}
                  className={`flex-1 rounded px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors md:flex-none ${
                    level === g
                      ? 'bg-white text-emerald-700 shadow-sm'
                      : 'text-neutral-500 hover:text-neutral-700'
                  }`}
                >
                  {EDUCATION_LEVEL_SHORT_LABELS[g]}
                </button>
              ))}
            </div>
          </div>

          {/* Legend — a continuous gradient stretched to the data's min/max */}
          <div className="flex items-center gap-1.5">
            <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-neutral-400">
              {summary.ready ? fmtLegend(summary.domain[0]) : ''}
            </span>
            <span
              className="h-2 flex-1 rounded-sm"
              style={{ background: `linear-gradient(to right, ${legendRamp.join(', ')})` }}
            />
            <span className="w-12 shrink-0 text-[10px] tabular-nums text-neutral-400">
              {summary.ready ? fmtLegend(summary.domain[1]) : ''}
            </span>
            <span
              className="ml-1 inline-block h-2 w-4 shrink-0 rounded-sm"
              style={{ backgroundColor: NO_DATA_COLOR }}
            />
            <span className="text-[10px] text-neutral-400">Soon</span>
          </div>
          <p className="mt-1.5 text-[10px] leading-snug text-neutral-400">
            {METRIC_HELP[metric]}
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-3 text-xs text-neutral-500">
            Click a country on the map or in the list to explore its districts.
          </p>

          {!summary.ready ? (
            <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-500">
              Loading regional data…
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Headline summary */}
              {metric === 'access' ? (
                <>
                  <div className="rounded-lg bg-emerald-50 p-4 text-center">
                    <p className="text-4xl font-bold text-emerald-800">{summary.headline}%</p>
                    <p className="mt-1 text-sm text-emerald-700">
                      of {narrative} across the {summary.ranking.length} covered countries
                      live within 30 min by {mode} of a school
                    </p>
                  </div>

                  <div className="rounded-lg border border-neutral-200 bg-white p-4">
                    <p className="text-3xl font-bold text-neutral-900">
                      {(summary.underserved ?? 0).toLocaleString()}
                    </p>
                    <p className="mt-0.5 text-sm text-neutral-500">
                      {narrative} more than 30 min by {mode} from any school
                    </p>
                  </div>
                </>
              ) : (
                <div className="rounded-lg bg-emerald-50 p-4 text-center">
                  <p className="text-4xl font-bold text-emerald-800">{summary.headline} pts</p>
                  <p className="mt-1 text-sm text-emerald-700">
                    average {gapLabel} gap in 30-min access for {narrative} ({mode}) across the{' '}
                    {summary.ranking.length} covered countries
                  </p>
                </div>
              )}

              {/* Country ranking */}
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  {metric === 'access'
                    ? 'Countries by school access — weakest first'
                    : `Countries by ${gapLabel} gap — widest first`}
                </p>
                <ol className="space-y-1.5">
                  {summary.ranking.map((r, i) => {
                    const barPct =
                      metric === 'access'
                        ? Math.max(r.value, 2)
                        : Math.max((r.value / summary.maxValue) * 100, 2);
                    return (
                      <li key={r.iso}>
                        <button
                          onClick={() => onSelectCountry(r.iso)}
                          className="block w-full rounded-md border border-neutral-200 px-3 py-2 text-left transition-colors hover:border-emerald-300 hover:bg-emerald-50/50"
                        >
                          <div className="mb-1 flex items-baseline justify-between gap-2">
                            <div className="min-w-0 truncate">
                              <span className="mr-1.5 text-xs text-neutral-400">{i + 1}.</span>
                              <span className="text-sm font-medium text-neutral-800">
                                {COUNTRIES[r.iso].name}
                              </span>
                            </div>
                            <span className="shrink-0 text-sm font-bold text-neutral-900">
                              {metric === 'access'
                                ? `${r.value.toFixed(1)}%`
                                : `${r.value.toFixed(0)} pts`}
                            </span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                            <div
                              className="h-full rounded-full bg-emerald-600"
                              style={{ width: `${barPct}%` }}
                            />
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </div>

              {metric === 'wealth_gap' && (
                <p className="text-xs text-neutral-400">
                  Wealth quintiles are country-relative — each country&apos;s own poorest vs
                  wealthiest fifth. Peru&apos;s quintile data is not yet available.
                </p>
              )}

              <p className="text-xs text-neutral-400">
                16 more Latin American countries — data coming soon.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-neutral-100 px-5 py-2">
          <p className="text-xs text-neutral-400">
            Data: IDB Accessibility Platform · FMM + OSRM routing · 2026
          </p>
        </div>
      </aside>
    </div>
  );
}
