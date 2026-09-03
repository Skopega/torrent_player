import type {
  AuthStatus,
  EnrichEntry,
  HistoryEntry,
  LoginResult,
  MediaInfo,
  SearchResult,
  StreamFile,
  StreamStatus,
  Topic,
  VpnStatus,
} from './types';
async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  async authStatus(): Promise<AuthStatus> {
    return json(await fetch('/api/auth/status'));
  },

  async authProgress(): Promise<'idle' | 'cloudflare' | 'login'> {
    const r = await json<{ phase: 'idle' | 'cloudflare' | 'login' }>(
      await fetch('/api/auth/progress'),
    );
    return r.phase;
  },

  async login(username: string, password: string): Promise<LoginResult> {
    return json(
      await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }),
    );
  },

  async loginWithCookie(cookie: string): Promise<LoginResult> {
    return json(
      await fetch('/api/auth/cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie }),
      }),
    );
  },

  async logout(): Promise<void> {
    await fetch('/api/auth/logout', { method: 'POST' });
  },

  async search(q: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal });
    if (res.status === 401) throw new Error('not_logged_in');
    const body = await json<{ results: SearchResult[] }>(res);
    return body.results;
  },

  async topic(id: number): Promise<Topic> {
    return json(await fetch(`/api/topic/${id}`));
  },

  async enrich(ids: number[]): Promise<Record<string, EnrichEntry>> {
    return json(
      await fetch('/api/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      }),
    );
  },

  async streamFiles(topicId: number): Promise<StreamFile[]> {
    const res = await fetch(`/api/topic/${topicId}/stream/files`);
    const body = await json<{ files: StreamFile[] }>(res);
    return body.files;
  },

  async streamProbe(topicId: number, fileIndex: number): Promise<MediaInfo> {
    return json(await fetch(`/api/topic/${topicId}/stream/${fileIndex}/probe`));
  },

  async streamStatus(
    topicId: number,
    fileIndex?: number,
    opts?: { audio?: number | null; start?: number; pos?: number; res?: number | null },
  ): Promise<StreamStatus> {
    const params = new URLSearchParams();
    if (fileIndex != null) params.set('file', String(fileIndex));
    if (opts?.audio != null) params.set('audio', String(opts.audio));
    if (opts?.start) params.set('start', String(opts.start));
    if (opts?.pos) params.set('pos', String(opts.pos));
    if (opts?.res != null) params.set('res', String(opts.res));
    const q = params.toString();
    return json(await fetch(`/api/topic/${topicId}/stream/status${q ? `?${q}` : ''}`));
  },

  async streamStop(topicId: number): Promise<void> {
    await fetch(`/api/topic/${topicId}/stream/stop`, { method: 'POST' });
  },

  warmStream(topicId: number): void {
    void fetch(`/api/topic/${topicId}/stream/warm`, { method: 'POST' }).catch(() => {});
  },

  hlsStop(topicId: number, fileIndex: number): void {
    void fetch(`/api/topic/${topicId}/stream/${fileIndex}/hls/stop`, { method: 'POST' }).catch(
      () => {},
    );
  },

  async streamStart(topicId: number, fileIndex: number): Promise<void> {
    await fetch(`/api/topic/${topicId}/stream/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIndex }),
    });
  },

  clientLog(data: unknown): void {
    void fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(() => {});
  },

  perfRecord(name: string, ms: number): void {
    void fetch('/api/perf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ms }),
    }).catch(() => {});
  },

  async perfSnapshot(): Promise<Record<string, { count: number; avgMs: number; p95Ms: number }>> {
    return json(await fetch('/api/perf'));
  },

  thumbnailsEnsure(topicId: number, fileIndex: number): void {
    void fetch(`/api/topic/${topicId}/stream/${fileIndex}/thumbnails`, {
      method: 'POST',
    }).catch(() => {});
  },

  async cacheSize(): Promise<number> {
    const body = await json<{ bytes: number }>(await fetch('/api/cache/size'));
    return body.bytes;
  },

  async history(): Promise<HistoryEntry[]> {
    const body = await json<{ history: HistoryEntry[] }>(await fetch('/api/history'));
    return body.history;
  },

  async historyAdd(entry: HistoryEntry): Promise<HistoryEntry[]> {
    const body = await json<{ history: HistoryEntry[] }>(
      await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      }),
    );
    return body.history;
  },

  async historyRemove(id: number): Promise<HistoryEntry[]> {
    const body = await json<{ history: HistoryEntry[] }>(
      await fetch(`/api/history/${id}`, { method: 'DELETE' }),
    );
    return body.history;
  },

  async cacheClear(): Promise<number> {
    const body = await json<{ bytes: number }>(
      await fetch('/api/cache/clear', { method: 'POST' }),
    );
    return body.bytes;
  },

  async vpnStatus(): Promise<VpnStatus> {
    return json(await fetch('/api/vpn/status'));
  },

  async vpnConfig(subscriptionUrl: string): Promise<VpnStatus> {
    return json(
      await fetch('/api/vpn/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionUrl }),
      }),
    );
  },

  async vpnAddConfigs(text: string): Promise<VpnStatus> {
    return json(
      await fetch('/api/vpn/configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
    );
  },

  async vpnCheck(): Promise<{ started: boolean }> {
    return json(await fetch('/api/vpn/check', { method: 'POST' }));
  },

  async vpnSelect(name: string): Promise<VpnStatus> {
    return json(
      await fetch('/api/vpn/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    );
  },

  async vpnRemove(name: string): Promise<VpnStatus> {
    return json(
      await fetch('/api/vpn/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    );
  },

  async vpnEnable(enabled: boolean): Promise<VpnStatus> {
    return json(
      await fetch('/api/vpn/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      }),
    );
  },

  async vpnTest(): Promise<{ ok: boolean; ms: number | null; error: string }> {
    return json(await fetch('/api/vpn/test', { method: 'POST' }));
  },
};

export function posterUrl(url: string): string {
  return `/api/image?url=${encodeURIComponent(url)}`;
}

export function torrentUrl(id: number): string {
  return `/api/topic/${id}/torrent`;
}

export function streamUrl(topicId: number, fileIndex: number): string {
  return `/api/topic/${topicId}/stream/${fileIndex}`;
}

export function hlsPlaylistUrl(
  topicId: number,
  fileIndex: number,
  audio?: number | null,
  startSec?: number,
  res?: number | null,
): string {
  const params: string[] = [];
  if (audio != null) params.push(`audio=${audio}`);
  if (startSec) params.push(`start=${startSec}`);
  if (res != null) params.push(`res=${res}`);
  const q = params.length ? `?${params.join('&')}` : '';
  return `/api/topic/${topicId}/stream/${fileIndex}/playlist.m3u8${q}`;
}

export function subtitleUrl(
  topicId: number,
  fileIndex: number,
  streamIndex: number,
  opts?: { window?: number; dur?: number; shift?: number; rev?: number },
): string {
  const params: string[] = [];
  if (opts?.window && opts.window > 0) params.push(`t=${opts.window}`);
  if (opts?.dur && opts.dur > 0) params.push(`dur=${opts.dur}`);
  if (opts?.shift && opts.shift > 0) params.push(`start=${opts.shift}`);
  if (opts?.rev) params.push(`rev=${opts.rev}`);
  const q = params.length ? `?${params.join('&')}` : '';
  return `/api/topic/${topicId}/stream/${fileIndex}/subtitle/${streamIndex}.vtt${q}`;
}

// Интервал превью (должен совпадать с THUMB_INTERVAL_SEC на сервере, thumbnails.ts).
export const THUMB_INTERVAL_SEC = 10;

export function thumbnailUrl(topicId: number, fileIndex: number, index: number): string {
  const name = `thumb${String(Math.max(0, index)).padStart(6, '0')}.jpg`;
  return `/api/topic/${topicId}/stream/${fileIndex}/thumbnails/${name}`;
}
