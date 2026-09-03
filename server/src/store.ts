import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Topic } from './types.js';

export interface SessionData {
  username: string;
  password: string;
  cookies: string[];
}

export interface HistoryEntry {
  id: number;
  title: string;
  category: string;
  poster: string | null;
  sizeHuman: string;
  seeds: number;
  leech: number;
  resolution: string | null;
  bitrate: string | null;
  duration: string | null;
  date: string;
}

const HISTORY_MAX = 10;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.TP_DATA_DIR
  ? path.resolve(process.env.TP_DATA_DIR)
  : path.resolve(__dirname, '..', '..', 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const POSTERS_FILE = path.join(CACHE_DIR, 'posters.json');
const BITRATES_FILE = path.join(CACHE_DIR, 'bitrates.json');
const RESOLUTIONS_FILE = path.join(CACHE_DIR, 'resolutions.json');
const DURATIONS_FILE = path.join(CACHE_DIR, 'durations.json');
const FAILED_IMAGES_FILE = path.join(CACHE_DIR, 'failed-images.json');
const IMG_DIR = path.join(CACHE_DIR, 'img');
const TOPICS_DIR = path.join(CACHE_DIR, 'topics');

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

// Устойчивое удаление каталога: на Windows файлы могут быть временно залочены
// (ffmpeg/webtorrent ещё не отпустили дескрипторы), поэтому повторяем с паузами.
export function rmDirRobust(dir: string): void {
  let lastErr: unknown = null;
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (e) {
      lastErr = e;
      if (!fs.existsSync(dir)) return;
    }
    const until = Date.now() + 300;
    while (Date.now() < until) {
      /* короткая синхронная пауза перед повтором */
    }
  }
  if (lastErr) throw lastErr;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export class Store {
  private session: SessionData | null;
  private history: HistoryEntry[];
  private posters: Record<string, string>;
  private bitrates: Record<string, string>;
  private resolutions: Record<string, string>;
  private durations: Record<string, string>;
  private failedImages: Set<string>;

  constructor() {
    this.session = readJson<SessionData | null>(SESSION_FILE, null);
    this.history = readJson<HistoryEntry[]>(HISTORY_FILE, []);
    this.posters = readJson<Record<string, string>>(POSTERS_FILE, {});
    this.bitrates = readJson<Record<string, string>>(BITRATES_FILE, {});
    this.resolutions = readJson<Record<string, string>>(RESOLUTIONS_FILE, {});
    this.durations = readJson<Record<string, string>>(DURATIONS_FILE, {});
    this.failedImages = new Set<string>(readJson<string[]>(FAILED_IMAGES_FILE, []));
  }

  getSession(): SessionData | null {
    return this.session;
  }

  setSession(session: SessionData) {
    this.session = session;
    writeJson(SESSION_FILE, session);
  }

  clearSession() {
    this.session = null;
    try {
      fs.rmSync(SESSION_FILE, { force: true });
    } catch {
      /* ignore */
    }
  }

  getHistory(): HistoryEntry[] {
    return this.history;
  }

  addHistory(entry: HistoryEntry): HistoryEntry[] {
    this.history = [entry, ...this.history.filter((e) => e.id !== entry.id)].slice(0, HISTORY_MAX);
    writeJson(HISTORY_FILE, this.history);
    return this.history;
  }

  removeHistory(id: number): HistoryEntry[] {
    this.history = this.history.filter((e) => e.id !== id);
    writeJson(HISTORY_FILE, this.history);
    return this.history;
  }

  getPoster(id: number): string | null {
    return this.posters[String(id)] ?? null;
  }

  setPosters(map: Record<string, string>) {
    this.posters = { ...this.posters, ...map };
    writeJson(POSTERS_FILE, this.posters);
  }

  getBitrate(id: number): string | null {
    return this.bitrates[String(id)] ?? null;
  }

  setBitrates(map: Record<string, string>) {
    this.bitrates = { ...this.bitrates, ...map };
    writeJson(BITRATES_FILE, this.bitrates);
  }

  getResolution(id: number): string | null {
    return this.resolutions[String(id)] ?? null;
  }

  setResolutions(map: Record<string, string>) {
    this.resolutions = { ...this.resolutions, ...map };
    writeJson(RESOLUTIONS_FILE, this.resolutions);
  }

  getDuration(id: number): string | null {
    return this.durations[String(id)] ?? null;
  }

  hasDuration(id: number): boolean {
    return String(id) in this.durations;
  }

  setDurations(map: Record<string, string>) {
    this.durations = { ...this.durations, ...map };
    writeJson(DURATIONS_FILE, this.durations);
  }

  hasFailedImage(key: string): boolean {
    return this.failedImages.has(key);
  }

  setFailedImage(key: string): void {
    this.failedImages.add(key);
    writeJson(FAILED_IMAGES_FILE, [...this.failedImages]);
  }

  loadTopics(): Map<number, Topic> {
    const map = new Map<number, Topic>();
    let files: string[];
    try {
      files = fs.readdirSync(TOPICS_DIR);
    } catch {
      return map;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const id = parseInt(f, 10);
      if (!Number.isFinite(id)) continue;
      try {
        const topic = readJson<Topic | null>(path.join(TOPICS_DIR, f), null);
        if (topic && typeof topic.id === 'number') map.set(id, topic);
      } catch {
        /* skip */
      }
    }
    return map;
  }

  saveTopic(id: number, topic: Topic): void {
    writeJson(path.join(TOPICS_DIR, String(id) + '.json'), topic);
  }

  cacheSize(): number {
    return dirSize(CACHE_DIR);
  }

  // Только метаданные: постеры (img/), json-файлы и кэш тем (topics/).
  // Не включает видео-кеши (торренты, HLS, превью).
  metadataCacheSize(): number {
    let total = dirSize(IMG_DIR) + dirSize(TOPICS_DIR);
    for (const f of [POSTERS_FILE, BITRATES_FILE, RESOLUTIONS_FILE, DURATIONS_FILE, FAILED_IMAGES_FILE]) {
      try {
        total += fs.statSync(f).size;
      } catch {
        /* нет файла */
      }
    }
    return total;
  }

  // Видео-кеши (торренты, HLS-сегменты, превью) удаляются всегда; метаданные
  // (постеры, битрейты, разрешения) сохраняются.
  clearVideoCache(): void {
    for (const sub of ['torrents', 'hls', 'thumbnails']) {
      rmDirRobust(path.join(CACHE_DIR, sub));
    }
  }

  clearCache(): void {
    this.posters = {};
    this.bitrates = {};
    this.resolutions = {};
    this.durations = {};
    this.failedImages = new Set();
    rmDirRobust(CACHE_DIR);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  imagePath(key: string): string {
    return path.join(IMG_DIR, key + '.bin');
  }

  hasImage(key: string): boolean {
    return fs.existsSync(this.imagePath(key));
  }

  writeImage(key: string, buf: Buffer) {
    ensureDir(IMG_DIR);
    fs.writeFileSync(this.imagePath(key), buf);
  }
}
