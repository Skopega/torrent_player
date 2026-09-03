import { useEffect, useRef } from 'react';
import type { SearchResult } from '../types';
import { PosterCard } from './PosterCard';

export function ResultsGrid({
  results,
  onOpen,
  onRevealMore,
  onPrefetch,
}: {
  results: SearchResult[];
  onOpen: (id: number) => void;
  onRevealMore: () => void;
  onPrefetch: (id: number) => void;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onRevealMore();
      },
      { rootMargin: '600px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [onRevealMore, results.length]);

  return (
    <>
      <div className="grid">
        {results.map((r) => (
          <PosterCard key={r.id} r={r} onOpen={onOpen} onPrefetch={onPrefetch} />
        ))}
      </div>
      <div ref={sentinelRef} style={{ height: 1 }} />
    </>
  );
}
