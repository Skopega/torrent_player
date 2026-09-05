import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { AuthStatus, EnrichEntry, HistoryEntry, SearchResult, SortDir, SortKey, Topic } from './types';
import { HistoryCard } from './components/HistoryCard';
import { LoginDropdown } from './components/LoginDropdown';
import { CacheButton } from './components/CacheButton';
import { ProxyDropdown } from './components/ProxyDropdown';
import { ResultsGrid } from './components/ResultsGrid';
import { DetailPage } from './components/DetailPage';
import { FilterBar } from './components/FilterBar';

type View = { name: 'home' } | { name: 'detail'; id: number };

function parseHash(): View {
  const m = window.location.hash.match(/^#\/topic\/(\d+)/);
  if (m) return { name: 'detail', id: Number(m[1]) };
  return { name: 'home' };
}

const RES_RANK: Record<string, number> = {
  '4K': 5,
  '1440p': 4,
  '1080p': 3,
  '720p': 2,
  '576p': 1,
  '480p': 1,
  '360p': 0,
};

function matchesResolution(res: string | null, preset: string): boolean {
  if (!res) return false;
  const rank = RES_RANK[res] ?? 0;
  if (preset === '1080p+') return rank > 3;
  if (preset === '1080p') return rank === 3;
  if (preset === '720p') return rank === 2;
  return true;
}

function bitrateToMbps(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/([\d.]+)\s*(Mbps|Kbps)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return m[2].toLowerCase() === 'mbps' ? v : v / 1000;
}

export default function App() {
  const [view, setView] = useState<View>(parseHash);
  const [auth, setAuth] = useState<AuthStatus>({ loggedIn: false, username: null });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extra, setExtra] = useState<Record<string, EnrichEntry>>({});
  const [resolutionFilter, setResolutionFilter] = useState<string | null>(null);
  const [sizeRange, setSizeRange] = useState<[number, number] | null>(null);
  const [bitrateRange, setBitrateRange] = useState<[number, number] | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('seeds');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [headerHidden, setHeaderHidden] = useState(false);
  const scheduledRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .history()
      .then(setHistory)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const ids = history
      .filter((e) => !e.duration && !e.enrichTried)
      .map((e) => e.id);
    if (ids.length === 0) return;
    api
      .enrich(ids)
      .then((m) => {
        setHistory((prev) =>
          prev.map((e): HistoryEntry => {
            if (e.duration || e.enrichTried) return e;
            const d = m[String(e.id)]?.duration;
            return { ...e, duration: d ?? e.duration, enrichTried: true };
          }),
        );
      })
      .catch(() => {});
  }, [history]);

  const addToHistory = useCallback((topic: Topic) => {
    const entry: HistoryEntry = {
      id: topic.id,
      title: topic.title,
      category: topic.category,
      poster: topic.poster,
      sizeHuman: topic.sizeHuman,
      seeds: topic.seeds,
      leech: topic.leech,
      resolution: topic.resolution,
      bitrate: topic.bitrate,
      duration: topic.duration,
      date: topic.dateAdded,
    };
    void api.historyAdd(entry).then(setHistory).catch(() => {});
  }, []);

  const removeFromHistory = useCallback((id: number) => {
    void api.historyRemove(id).then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    const onHash = () => setView(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    api.authStatus().then(setAuth).catch(() => {});
  }, []);

  // На телефонах прячем шапку при прокрутке вниз (чтобы не следовала за экраном).
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 800px)');
    let lastY = window.scrollY;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        ticking = false;
        if (!mq.matches) {
          setHeaderHidden(false);
          return;
        }
        const y = window.scrollY;
        const delta = y - lastY;
        if (Math.abs(delta) > 4) {
          if (delta > 0 && y > 120) setHeaderHidden(true);
          else setHeaderHidden(false);
          lastY = y;
        }
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (searchOpen) setHeaderHidden(false);
  }, [searchOpen]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (view.name === 'detail') setSearchOpen(false);
  }, [view.name]);

  const runSearch = useCallback(async (raw: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const id = ++requestIdRef.current;

    const q = raw.trim();
    if (!q) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }

    // Если находимся на странице раздачи — вернуться на главную, чтобы
    // показать сетку результатов.
    if (window.location.hash.startsWith('#/topic/')) {
      window.location.hash = '/';
    }

    setLoading(true);
    setError(null);
    try {
      const res = await api.search(q, controller.signal);
      if (id !== requestIdRef.current) return;
      setResults(res);
    } catch (e) {
      if (id !== requestIdRef.current || controller.signal.aborted) return;
      const msg = e instanceof Error ? e.message : 'search error';
      // НЕ зануляем results: иначе HomeView покажет «Ничего не найдено» и скроет ошибку.
      setError(msg === 'not_logged_in' ? 'not_logged_in' : msg);
    } finally {
      if (id === requestIdRef.current) setLoading(false);
    }
  }, []);

  const goHome = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    requestIdRef.current++;
    setQuery('');
    setResults(null);
    setError(null);
    setLoading(false);
    setSearchOpen(false);
    window.location.hash = '/';
  }, []);

  const onChangeQuery = useCallback((value: string) => {
    setQuery(value);
    abortRef.current?.abort();
    abortRef.current = null;
    requestIdRef.current++;
    setLoading(false);
  }, []);

  const scheduleEnrich = useCallback(
    (count: number) => {
      if (!results || results.length === 0) return;
      const from = scheduledRef.current;
      const to = Math.min(results.length, from + count);
      if (to <= from) return;
      scheduledRef.current = to;
      const ids = results.slice(from, to).map((r) => r.id);
      api.enrich(ids).then((m) => setExtra((p) => ({ ...p, ...m })));
    },
    [results],
  );

  const prefetchedRef = useRef<Set<number>>(new Set());
  const pendingRef = useRef<number[]>([]);
  const hoverTimerRef = useRef<number | null>(null);

  const prefetch = useCallback(
    (id: number) => {
      if (extra[String(id)] || prefetchedRef.current.has(id)) return;
      prefetchedRef.current.add(id);
      pendingRef.current.push(id);
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = window.setTimeout(() => {
        const ids = pendingRef.current.splice(0);
        if (ids.length) api.enrich(ids).then((m) => setExtra((p) => ({ ...p, ...m })));
      }, 120);
    },
    [extra],
  );

  useEffect(() => {
    scheduledRef.current = 0;
    prefetchedRef.current = new Set();
    pendingRef.current = [];
    setExtra({});
    setResolutionFilter(null);
    setSizeRange(null);
    setBitrateRange(null);
    if (results && results.length > 0) scheduleEnrich(12);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  const enrichedResults =
    results?.map((r) => {
      const e = extra[String(r.id)];
      return {
        ...r,
        poster: r.poster ?? e?.poster ?? null,
        bitrate: e?.bitrate ?? null,
        resolution: e?.resolution ?? r.resolution ?? null,
        duration: r.duration ?? e?.duration ?? null,
      };
    }) ?? null;

  const sizeBounds = useMemo<[number, number]>(() => {
    if (!results || results.length === 0) return [0, 1];
    const max = Math.max(...results.map((r) => r.size / 1024 ** 3));
    return [0, Math.ceil(Math.max(max, 1))];
  }, [results]);

  const bitrateBounds = useMemo<[number, number]>(() => {
    if (!enrichedResults || enrichedResults.length === 0) return [0, 1];
    const vals = enrichedResults
      .map((r) => bitrateToMbps(r.bitrate))
      .filter((v): v is number => v != null && v > 0);
    const max = vals.length ? Math.max(...vals) : 0;
    return [0, Math.ceil(Math.max(max, 1))];
  }, [enrichedResults]);

  const filteredResults = useMemo(() => {
    if (!enrichedResults) return null;
    return enrichedResults.filter((r) => {
      if (r.seeds <= 0) return false;
      if (resolutionFilter && !matchesResolution(r.resolution, resolutionFilter)) return false;
      if (sizeRange) {
        const gb = r.size / 1024 ** 3;
        if (gb < sizeRange[0] || gb > sizeRange[1]) return false;
      }
      if (bitrateRange) {
        const mbps = bitrateToMbps(r.bitrate);
        if (mbps == null || mbps < bitrateRange[0] || mbps > bitrateRange[1]) return false;
      }
      return true;
    });
  }, [enrichedResults, resolutionFilter, sizeRange, bitrateRange]);

  const sortValue = (r: SearchResult): number => {
    switch (sortKey) {
      case 'size':
        return r.size;
      case 'bitrate':
        return bitrateToMbps(r.bitrate) ?? -1;
      case 'resolution':
        return RES_RANK[r.resolution ?? ''] ?? 0;
      case 'seeds':
      default:
        return r.seeds;
    }
  };

  const sortedResults = useMemo(() => {
    if (!filteredResults) return null;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filteredResults].sort((a, b) => (sortValue(a) - sortValue(b)) * dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredResults, sortKey, sortDir]);

  const openTopic = (id: number) => {
    window.location.hash = `/topic/${id}`;
  };

  return (
    <>
      <header className={`header ${searchOpen ? 'search-open' : ''} ${headerHidden && !searchOpen ? 'hidden' : ''}`}>
        <div className="brand" onClick={goHome}>
          Torrent Player
        </div>
        <button
          className="home-btn"
          aria-label="Домой"
          title="Домой"
          onClick={goHome}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 10.5 12 3l9 7.5" />
            <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
          </svg>
        </button>
        <button
          className="search-toggle"
          aria-label="Поиск"
          title="Поиск"
          onClick={() => setSearchOpen(true)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
        </button>
        <div className="search-wrap">
          <div className="search">
            <button
              className="search-close"
              aria-label="Закрыть поиск"
              title="Закрыть поиск"
              onClick={() => setSearchOpen(false)}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
            <input
              ref={searchInputRef}
              value={query}
              onChange={(e) => onChangeQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runSearch(query);
              }}
              placeholder="Поиск"
            />
            <button
              className="search-go"
              aria-label="Найти"
              title="Найти"
              onClick={() => runSearch(query)}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
            </button>
          </div>
        </div>
        <div className="header-right">
          <CacheButton />
          <ProxyDropdown />
          <LoginDropdown auth={auth} onAuth={setAuth} />
        </div>
      </header>

      <main className="main">
        {view.name === 'detail' ? (
          <DetailPage id={view.id} onBack={() => (window.location.hash = '/')} onWatched={addToHistory} />
        ) : (
          <>
            {results && results.length > 0 && (
              <FilterBar
                resolution={resolutionFilter}
                onResolution={setResolutionFilter}
                sizeBounds={sizeBounds}
                sizeRange={sizeRange ?? sizeBounds}
                onSizeRange={setSizeRange}
                bitrateBounds={bitrateBounds}
                bitrateRange={bitrateRange ?? bitrateBounds}
                onBitrateRange={setBitrateRange}
                sortKey={sortKey}
                sortDir={sortDir}
                onSortKey={setSortKey}
                onSortDir={setSortDir}
              />
            )}
            <HomeView
              loading={loading}
              error={error}
              results={sortedResults}
              history={history}
              onOpen={openTopic}
              onRemoveHistory={removeFromHistory}
              onRevealMore={() => scheduleEnrich(18)}
              onPrefetch={prefetch}
            />
          </>
        )}
      </main>
    </>
  );
}

function HomeView({
  loading,
  error,
  results,
  history,
  onOpen,
  onRemoveHistory,
  onRevealMore,
  onPrefetch,
}: {
  loading: boolean;
  error: string | null;
  results: SearchResult[] | null;
  history: HistoryEntry[];
  onOpen: (id: number) => void;
  onRemoveHistory: (id: number) => void;
  onRevealMore: () => void;
  onPrefetch: (id: number) => void;
}) {
  if (error === 'not_logged_in') {
    return (
      <div className="state">
        <p>Нужно войти в аккаунт rutracker.org.</p>
        <p>Нажмите «Войти» в правом верхнем углу.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="state">
        <p>Ошибка поиска: {error}</p>
      </div>
    );
  }

  if (results) {
    return (
      <>
        {loading && <div className="state">Обновление…</div>}
        {results.length === 0 ? (
          <div className="state">Ничего не найдено</div>
        ) : (
          <ResultsGrid
            results={results}
            onOpen={onOpen}
            onRevealMore={onRevealMore}
            onPrefetch={onPrefetch}
          />
        )}
      </>
    );
  }

  if (loading) {
    return (
      <div className="state state-loading">
        <div className="spinner" />
        Поиск…
      </div>
    );
  }

  return (
    <>
      {history.length > 0 && (
        <section className="history-section">
          <h2 className="section-title">История</h2>
          <div className="grid">
            {history.map((e) => (
              <HistoryCard key={e.id} e={e} onOpen={onOpen} onRemove={onRemoveHistory} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
