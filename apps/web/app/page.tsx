import Link from 'next/link';
import LandingPromptCarousel from './components/LandingPromptCarousel';

const prompts = [
  'Which districts have the weakest high-school walking access?',
  'Where does missing travel-time data exceed 20%?',
  'Compare primary and high-school access in Panama province.',
  'Show districts with more than 1,000 students beyond 30 minutes.',
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
          Ask, Discover, Decide
        </p>

        <h1 className="mt-6 max-w-3xl text-4xl font-medium tracking-[-0.05em] text-[#10211c] sm:text-5xl lg:text-[3.45rem] lg:leading-[1.04]">
          Unlock instant location insights for education policy making.
        </h1>

        <p className="mt-5 max-w-2xl text-base leading-7 text-neutral-500 sm:text-lg">
          District-level school accessibility evidence for education ministries,
          planning teams, and public-sector decision-makers.
        </p>

        <div className="mt-12 w-full max-w-[820px]">
          <LandingPromptCarousel prompts={prompts} />
        </div>

        <p className="mt-6 text-sm font-normal text-neutral-400">
          Panama pilot built on IDB accessibility data.
        </p>
      </section>
    </main>
  );
}

function MapFootprintBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(16,185,129,0.018),transparent_42%)]" />
      <div className="absolute left-1/2 top-1/2 h-[38rem] w-[72rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[rgba(255,255,255,0.55)] blur-3xl" />

      <svg
        viewBox="0 0 1200 900"
        className="absolute left-1/2 top-1/2 h-[52rem] w-[66rem] max-w-none -translate-x-1/2 -translate-y-1/2 opacity-90"
        aria-hidden="true"
      >
        <g fill="rgba(28,78,74,0.018)" stroke="rgba(28,78,74,0.05)" strokeWidth="1.25">
          <path d="M322 170l38-15 28 6 18 22 30 7 25 20 1 20-22 8-27-9-25 2-17 12-20 0-16 17 9 24 25 8 14 16-6 17-21 3-15 15 4 24 18 9 19-4 18 10 10 18 14 7 18 26 14 7 5 22 20 18 13 34 12 17-3 31 11 25-4 35 18 26-7 20-23 4-12-14-2-35-11-12-8-39-16-13-3-28-16-18-12-45-22-15-14-32-19-11-14-30-28-23-12-25-26-10-19-31-23-19-6-23 12-26 22-5 13-12-5-13-24-7-14-19 7-20 26-9 12-16z" />
          <path d="M396 360l23 6 15 22 22 7 20 24-4 27-16 11-2 18 16 31-2 23-15 7-10-19-19-17-5-19-18-23 1-18-15-20-15-10-9-20 2-20 11-10z" />
          <path d="M520 208l18-5 16 12-4 14-23 4-11-11z" />
          <path d="M552 186l13-4 13 7-3 11-14 5-11-8z" />
          <path d="M587 197l16-5 12 9-2 12-17 5-12-8z" />
          <path d="M620 214l14-4 9 8-2 10-13 3-9-7z" />
        </g>
      </svg>
    </div>
  );
}
