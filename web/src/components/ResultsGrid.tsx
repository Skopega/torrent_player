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
  // Держим последний колбэк в ref: иначе новый identity onRevealMore на каждом
  // рендере родителя пересоздаёт observer, тот сразу срабатывает на observe() и
  // вызывает scheduleEnrich по кругу (обогащение всего списка вместо «по скроллу»).
  const onRevealRef = useRef(onRevealMore);
  useEffect(() => {
    onRevealRef.current = onRevealMore;
  });

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onRevealRef.current();
      },
      { rootMargin: '600px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [results.length]);

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
