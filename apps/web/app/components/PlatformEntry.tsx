'use client';

/**
 * PlatformEntry — decides the platform's first view.
 *
 * No country chosen → the LAC region overview (LacOverview).
 * A country chosen (by clicking a country, the in-app switcher, a
 * cross-country Ask, or a ?country= deep-link) → the per-country AppShell.
 */

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import AppShell from './AppShell';
import { COUNTRIES, type CountryIso } from '@/lib/types';

const LacOverview = dynamic(() => import('./LacOverview'), { ssr: false });

export default function PlatformEntry() {
  const [country, setCountry] = useState<CountryIso | null>(null);
  const bootRef = useRef(false);

  // A ?country= deep-link (e.g. from the landing typewriter) jumps straight
  // into that country, skipping the LAC overview.
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    if (typeof window === 'undefined') return;
    const c = new URLSearchParams(window.location.search).get('country');
    if (c && c in COUNTRIES) setCountry(c as CountryIso);
  }, []);

  if (country === null) {
    return <LacOverview onSelectCountry={(c) => setCountry(c)} />;
  }
  return (
    <AppShell
      country={country}
      onCountryChange={(c) => setCountry(c)}
      onBackToLac={() => setCountry(null)}
    />
  );
}
