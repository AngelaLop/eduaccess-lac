'use client';

export default function ScopeCard({ countryName }: { countryName: string }) {
  return (
    <section className="px-4 pb-3 pt-3 text-xs text-neutral-600">
      <p className="text-sm font-medium text-neutral-800">
        Ask about {countryName}&apos;s school access.
      </p>
      <p className="mt-1.5">
        Walking and motorized travel-time access across every district, for{' '}
        <strong>three education levels</strong> (primary, lower- and upper-secondary).
        Rank, filter, or compare.
      </p>
      <p className="mt-1.5 text-[11px] leading-snug text-neutral-400">
        Outside {countryName} or non-access questions: I&apos;ll suggest a related one I
        can answer, or you can switch the country selector.
      </p>
    </section>
  );
}
