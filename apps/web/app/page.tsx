import Link from 'next/link';
import LandingPromptCarousel from './components/LandingPromptCarousel';
import MapFootprintBackdrop from './components/MapFootprintBackdrop';
import type { CountryIso } from '@/lib/types';

// One prompt per country — the typewriter rotates through Latin America, and
// each prompt deep-links straight into that country's platform view.
const prompts: { text: string; country: CountryIso }[] = [
  { text: 'Which Panama districts have the weakest high-school walking access?', country: 'PAN' },
  { text: 'How long does it take Colombian children to get to school?', country: 'COL' },
  { text: "Rank Costa Rica's provinces by 15-minute school access.", country: 'CRI' },
  { text: 'Which Ecuador districts leave the most students beyond 30 minutes?', country: 'ECU' },
  { text: 'Compare primary and upper-secondary access across Peru.', country: 'PER' },
];

export default function Page() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-[#f8faf8] text-[#10211c]">
      <MapFootprintBackdrop />

      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6 sm:px-8">
        <div className="flex items-center gap-2.5 text-sm font-semibold uppercase tracking-[0.22em] text-emerald-700">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.85"
            className="h-4.5 w-4.5"
            aria-hidden="true"
          >
            <path d="M12 21s6-5.76 6-11a6 6 0 1 0-12 0c0 5.24 6 11 6 11Z" />
            <circle cx="12" cy="10" r="2.3" />
          </svg>
          <p>EduAccess LAC</p>
        </div>

        <Link
          href="/platform"
          className="text-sm font-medium text-neutral-600 transition-colors hover:text-emerald-800"
        >
          Open platform
        </Link>
      </header>

      <section className="relative z-10 mx-auto flex min-h-[calc(100vh-88px)] w-full max-w-5xl flex-col items-center justify-center px-6 pb-24 pt-8 text-center sm:px-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.34em] text-neutral-400">
          Ask · Discover · Decide
        </p>

        <h1 className="mt-6 max-w-3xl text-4xl font-medium tracking-[-0.05em] text-[#10211c] sm:text-5xl lg:text-[3.45rem] lg:leading-[1.04]">
          How accessible are schools across Latin America?
        </h1>

        <p className="mt-5 max-w-2xl text-base leading-7 text-neutral-500 sm:text-lg">
          Five Latin American countries mapped by walking and motorized access.
          Ask the AI a question, and get the answer plus the data and confidence behind it.
        </p>

        <div className="mt-12 w-full max-w-[820px]">
          <LandingPromptCarousel prompts={prompts} />
        </div>

        <Link
          href="/platform?country=PAN&tab=simulation"
          className="group mt-8 inline-flex items-center gap-2 text-sm font-normal text-neutral-500 transition-colors hover:text-emerald-700"
        >
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            className="h-3 w-3 shrink-0 text-emerald-600 transition-colors group-hover:text-emerald-700"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
          <span>Watch how many kids walk to school in 60 minutes (in 20 seconds)</span>
        </Link>

        <p className="mt-3 text-sm font-normal text-neutral-400">
          Panama · Colombia · Costa Rica · Ecuador · Peru, built on IDB accessibility data.
        </p>
      </section>
    </main>
  );
}

