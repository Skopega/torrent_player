import { useEffect, useRef, useState } from 'react';
import { posterUrl } from '../api';

function Placeholder() {
  return (
    <div className="poster-placeholder">
      <svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="9" cy="9" r="2" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    </div>
  );
}

export function SmartImage({ src, alt }: { src: string | null; alt?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retryTimer = useRef<number | null>(null);
  const currentSrc = useRef<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    currentSrc.current = src;
    if (retryTimer.current != null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    setFailed(false);
    setLoaded(false);
    setAttempt(0);
  }, [src]);

  useEffect(() => {
    return () => {
      if (retryTimer.current != null) window.clearTimeout(retryTimer.current);
    };
  }, []);

  if (!src || failed) {
    return (
      <div ref={ref} style={{ width: '100%', height: '100%' }}>
        <Placeholder />
      </div>
    );
  }

  return (
    <div ref={ref} style={{ width: '100%', height: '100%' }}>
      {visible && (
        <img
          key={attempt}
          src={posterUrl(src) + (attempt > 0 ? `&_r=${attempt}` : '')}
          alt={alt}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => {
            if (attempt < 1) {
              retryTimer.current = window.setTimeout(() => {
                retryTimer.current = null;
                // Не ретраить новый src по ошибке старого (src мог смениться за 300 мс).
                if (currentSrc.current === src) setAttempt((a) => a + 1);
              }, 300);
            } else {
              setFailed(true);
            }
          }}
          style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.3s' }}
        />
      )}
    </div>
  );
}
