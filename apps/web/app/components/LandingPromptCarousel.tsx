'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

interface Props {
  prompts: readonly string[];
}

export default function LandingPromptCarousel({ prompts }: Props) {
  const safePrompts = useMemo(
    () => (prompts.length > 0 ? [...prompts] : ['Ask about school access in Panama.']),
    [prompts]
  );
  const [promptIndex, setPromptIndex] = useState(0);
  const [displayText, setDisplayText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    const currentPrompt = safePrompts[promptIndex] ?? '';
    const completedTyping = displayText === currentPrompt;
    const fullyDeleted = displayText.length === 0;

    let delay = isDeleting ? 34 : 58;

    if (!isDeleting && completedTyping) delay = 1550;
    if (isDeleting && fullyDeleted) delay = 320;

    const timer = window.setTimeout(() => {
      if (!isDeleting && completedTyping) {
        setIsDeleting(true);
        return;
      }

      if (isDeleting && fullyDeleted) {
        setIsDeleting(false);
        setPromptIndex((current) => (current + 1) % safePrompts.length);
        return;
      }

      setDisplayText((current) =>
        isDeleting
          ? current.slice(0, Math.max(0, current.length - 1))
          : currentPrompt.slice(0, current.length + 1)
      );
    }, delay);

    return () => window.clearTimeout(timer);
  }, [displayText, isDeleting, promptIndex, safePrompts]);

  return (
    <div className="mx-auto w-full">
      <div className="flex items-center gap-3 rounded-full bg-white px-4 py-3 shadow-[0_22px_54px_rgba(16,33,28,0.055)] sm:gap-4 sm:px-5 sm:py-3.5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#f2f7f4] text-emerald-700 sm:h-11 sm:w-11">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="h-4.5 w-4.5"
            aria-hidden="true"
          >
            <path d="M21 21l-4.35-4.35" />
            <circle cx="11" cy="11" r="6.25" />
          </svg>
        </div>

        <div className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-0.5 overflow-hidden">
            <p className="truncate text-sm text-neutral-700 sm:text-base">
              {displayText}
            </p>
            <span
              className="h-5 w-px shrink-0 bg-emerald-600 animate-[blink-caret_1s_step-end_infinite]"
              aria-hidden="true"
            />
          </div>
        </div>

        <Link
          href="/platform"
          className="shrink-0 rounded-full bg-emerald-700 px-[18px] py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-800 sm:px-5"
        >
          Ask
        </Link>
      </div>
    </div>
  );
}
