'use client';

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { AgeGroup, IndicatorsByDist } from '@/lib/types';

const COLOR_STEPS: [number, string][] = [
  [0, '#7f1d1d'],
  [20, '#dc2626'],
  [40, '#f97316'],
  [60, '#eab308'],
  [80, '#16a34a'],
];

const NO_DATA_COLOR = '#d1d5db';

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

interface Props {
  indicators: IndicatorsByDist;
  activeAgeGroup: AgeGroup;
  highlightedDists: string[];
  selectedDist: string | null;
  onDistrictClick: (codDist: string) => void;
}

export default function PanamaMap({
  indicators,
  activeAgeGroup,
  highlightedDists,
  selectedDist,
  onDistrictClick,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const geojsonRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const readyRef = useRef(false);

  const indicatorsRef = useRef<IndicatorsByDist>(indicators);
  const ageGroupRef = useRef<AgeGroup>(activeAgeGroup);
  const highlightedRef = useRef<string[]>(highlightedDists);
  const selectedRef = useRef<string | null>(selectedDist);
  indicatorsRef.current = indicators;
  ageGroupRef.current = activeAgeGroup;
  highlightedRef.current = highlightedDists;
  selectedRef.current = selectedDist;

  function mergedGeoJSON(gj: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
    const inds = indicatorsRef.current;
    const activeGroup = ageGroupRef.current;

    return {
      ...gj,
      features: gj.features.map((feature) => {
        const code = feature.properties?.cod_dist as string;
        const current = inds[code]?.[activeGroup];
        const hasTravelData = current ? current.data_completeness_pct > 0 : false;

        return {
          ...feature,
          properties: {
            ...feature.properties,
            has_travel_data: hasTravelData ? 1 : 0,
            pct_le30_current: hasTravelData ? current?.pct_le30 ?? null : null,
          },
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
      map.on('mouseenter', 'districts-fill', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'districts-fill', () => {
        map.getCanvas().style.cursor = '';
      });

      readyRef.current = true;

      map.setFilter('districts-highlight', [
        'in',
        ['get', 'cod_dist'],
        ['literal', highlightedRef.current],
      ]);
      map.setFilter('districts-selected', ['==', ['get', 'cod_dist'], selectedRef.current ?? '']);
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

    (map.getSource('districts') as maplibregl.GeoJSONSource | undefined)?.setData(
      mergedGeoJSON(gj)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicators, activeAgeGroup]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    map.setFilter('districts-highlight', [
      'in',
      ['get', 'cod_dist'],
      ['literal', highlightedDists],
    ]);
  }, [highlightedDists]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    map.setFilter('districts-selected', ['==', ['get', 'cod_dist'], selectedDist ?? '']);
  }, [selectedDist]);

  return <div ref={containerRef} className="h-full w-full" />;
}
