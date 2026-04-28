'use client';

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { IndicatorsByDist } from '@/lib/types';

const COLOR_STEPS: [number, string][] = [
  [0,  '#7f1d1d'],
  [20, '#dc2626'],
  [40, '#f97316'],
  [60, '#eab308'],
  [80, '#16a34a'],
];

const choroplethFill: maplibregl.ExpressionSpecification = [
  'step',
  ['coalesce', ['get', 'pct_le30_hs'], 0],
  COLOR_STEPS[0][1],
  ...COLOR_STEPS.slice(1).flatMap(([t, c]) => [t, c]),
] as unknown as maplibregl.ExpressionSpecification;

interface Props {
  indicators: IndicatorsByDist;
  highlightedDists: string[];
  selectedDist: string | null;
  onDistrictClick: (codDist: string) => void;
}

export default function PanamaMap({
  indicators,
  highlightedDists,
  selectedDist,
  onDistrictClick,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const geojsonRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const readyRef = useRef(false);

  // Refs keep the load callback from seeing stale prop values
  const indicatorsRef = useRef<IndicatorsByDist>(indicators);
  const highlightedRef = useRef<string[]>(highlightedDists);
  const selectedRef = useRef<string | null>(selectedDist);
  indicatorsRef.current = indicators;
  highlightedRef.current = highlightedDists;
  selectedRef.current = selectedDist;

  function mergedGeoJSON(gj: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
    const inds = indicatorsRef.current;
    return {
      ...gj,
      features: gj.features.map((f) => {
        const code = f.properties?.cod_dist as string;
        const hs = inds[code]?.highschool;
        return {
          ...f,
          properties: { ...f.properties, pct_le30_hs: hs?.pct_le30 ?? null },
        };
      }),
    };
  }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: [-80.0, 8.5],
      zoom: 6.5,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

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

      map.addLayer({
        id: 'districts-highlight',
        type: 'line',
        source: 'districts',
        filter: ['in', ['get', 'cod_dist'], ['literal', []]],
        paint: { 'line-color': '#d97706', 'line-width': 3 },
      });

      map.addLayer({
        id: 'districts-selected',
        type: 'fill',
        source: 'districts',
        filter: ['==', ['get', 'cod_dist'], ''],
        paint: { 'fill-color': '#d97706', 'fill-opacity': 0.25 },
      });

      map.on('click', 'districts-fill', (e) => {
        const code = e.features?.[0]?.properties?.cod_dist as string | undefined;
        if (code) onDistrictClick(code);
      });
      map.on('mouseenter', 'districts-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'districts-fill', () => { map.getCanvas().style.cursor = ''; });

      readyRef.current = true;

      // Flush any state that arrived before the map was ready
      map.setFilter('districts-highlight', [
        'in', ['get', 'cod_dist'], ['literal', highlightedRef.current],
      ]);
      map.setFilter('districts-selected', [
        '==', ['get', 'cod_dist'], selectedRef.current ?? '',
      ]);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const gj = geojsonRef.current;
    if (!map || !gj || !readyRef.current) return;
    (map.getSource('districts') as maplibregl.GeoJSONSource | undefined)
      ?.setData(mergedGeoJSON(gj));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicators]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setFilter('districts-highlight', ['in', ['get', 'cod_dist'], ['literal', highlightedDists]]);
  }, [highlightedDists]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setFilter('districts-selected', ['==', ['get', 'cod_dist'], selectedDist ?? '']);
  }, [selectedDist]);

  return <div ref={containerRef} className="w-full h-full" />;
}
