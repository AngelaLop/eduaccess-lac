'use client';

/**
 * PlatformEntry — decides the platform's first view and owns the URL bootstrap.
 *
 * No country chosen → the LAC region overview (LacOverview).
 * A country chosen (clicking a country, the in-app switcher, a cross-country
 * Ask, or a ?country= deep-link) → the per-country AppShell.
 *
 * The ?tab= / ?ask= deep-link params are read ONCE here and handed to AppShell
 * as initial props. Any in-app navigation (picking a country, going back to the
 * overview) clears them, so they never re-fire on a remount.
 */

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import AppShell from './AppShell';
import { COUNTRIES, type CountryIso, type PanelTab } from '@/lib/types';

const LacOverview = dynamic(() => import('./LacOverview'), { ssr: false });

interface Boot {
  tab?: PanelTab;
  ask?: string;
}

export default function PlatformEntry() {
  const [country, setCountry] = useState<CountryIso | null>(null);
  const [boot, setBoot] = useState<Boot>({});
  const bootRef = useRef(false);

  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search);
    const c = p.get('country');
    const tab = p.get('tab');
    const ask = p.get('ask');
    const next: Boot = {};
    if (ask && ask.trim()) {
      next.ask = ask;
      next.tab = 'ask';
    } else if (tab === 'ask' || tab === 'insight' || tab === 'simulation') {
      next.tab = tab;
    }
    if (next.tab || next.ask) setBoot(next);
    if (c && c in COUNTRIES) setCountry(c as CountryIso);
  }, []);

  // An explicit in-app country pick is not a deep-link — drop the bootstrap
  // params so a later remount doesn't re-apply a stale ?tab= / ?ask=.
  function pickCountry(c: CountryIso) {
    setBoot({});
    setCountry(c);
  }

  if (country === null) {
    return <LacOverview onSelectCountry={pickCountry} />;
  }
  return (
    <AppShell
      country={country}
      initialTab={boot.tab}
      initialAsk={boot.ask}
      onCountryChange={pickCountry}
      onBackToLac={() => {
        setBoot({});
        setCountry(null);
      }}
    />
  );
}
