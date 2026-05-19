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

        <p className="mt-5 flex items-center justify-center gap-1.5 text-xs font-normal text-neutral-400">
          May 2026 ·
          <a
            href="https://github.com/AngelaLop/eduaccess-lac"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 transition-colors hover:text-neutral-700"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="h-3.5 w-3.5">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
            AngelaLop
          </a>
        </p>
      </section>
    </main>
  );
}

