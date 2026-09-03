import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import WebTorrent from 'webtorrent';
import type { Torrent, TorrentFile } from 'webtorrent';
import parseTorrent from 'parse-torrent';
import { DATA_DIR } from './store.js';
import { FFPROBE_PATH as ffprobePath } from './media.js';
import { log } from './logger.js';
import {
  extOf,
  isVideoFile,
  mimeFor,
  pieceRange,
  canDirectPlay,
  compareEpisodes,
  isTextSubtitleCodec,
} from './stream-utils.js';
import { TorrentScheduler, Priority } from './scheduler.js';
import { perf } from './perf.js';
import type { MediaInfo, StreamFile, StreamStatus } from './types.js';

// Запас в секундах, который качаем вперёд от плейхеда (переводится в байты по битрейту).
const LOOKAHEAD_SECONDS = 45;
// Фолбэк-битрейт, когда длительность/размер не дают оценку (8 Мбит/с).
const FALLBACK_BITRATE_BPS = 8_000_000;

export interface StreamManagerSource {
  getTorrentBuffer(topicId: number): Promise<Buffer>;
  getMagnet(topicId: number): Promise<string | null>;
}

export interface OpenStreamOptions {
  start?: number;
  end?: number;
  priority?: number;
  // true для ffmpeg-входа: не поднимаем окно через планировщик (ffmpeg читает
  // произвольно/сиками), а полагаемся на stream-selection самого createReadStream.
  feed?: boolean;
}

interface Entry {
  topicId: number;
  torrent: Torrent | null;
  pending: Promise<Torrent> | null;
  loadedAt: number;
  lastUsed: number;
  scheduler: TorrentScheduler | null;
}

const MAX_ACTIVE = 3;
const IDLE_TTL_MS = 15 * 60 * 1000;
const PROBE_BYTES = 8 * 1024 * 1024;
// «Сейчас»-окно, помечаемое critical: только чтобы waitForBytes/readBytes быстрее
// получали именно нужные куски. Необратимо (webtorrent), поэтому держим небольшим.
const CRITICAL_WINDOW_BYTES = 8 * 1024 * 1024;
const TORRENT_DIR = path.join(DATA_DIR, 'cache', 'torrents');

export class StreamManager {
  private client: WebTorrent;
  private entries = new Map<number, Entry>();
  private idleTimer: NodeJS.Timeout;
  private probeCache = new Map<string, MediaInfo>();
  private playWindows = new Map<number, { playFirst: number; playLast: number; bufLast: number }>();

  constructor(private source: StreamManagerSource) {
    this.client = new WebTorrent({ dht: true, tracker: {} });
    this.client.on('error', (err) => {
      log.warn(`[stream] client error: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.idleTimer = setInterval(() => this.sweepIdle(), 60_000);
    this.idleTimer.unref();
  }

  async load(topicId: number, opts: { quiet?: boolean } = {}): Promise<Torrent> {
    const existing = this.entries.get(topicId);
    if (existing) {
      existing.lastUsed = Date.now();
      if (existing.torrent) {
        if (existing.torrent.paused) {
          existing.torrent.resume();
          log.info(`[stream] resume topic ${topicId} (reload)`);
        }
        return existing.torrent;
      }
      if (existing.pending) return existing.pending;
    }

    if (!opts.quiet) this.stopAllExcept(topicId);

    const entry: Entry = {
      topicId,
      torrent: null,
      pending: null,
      loadedAt: Date.now(),
      lastUsed: Date.now(),
      scheduler: null,
    };
    entry.pending = this._load(topicId).then((torrent) => {
      entry.torrent = torrent;
      entry.pending = null;
      entry.scheduler = new TorrentScheduler(torrent);
      this.evictIfNeeded();
      return torrent;
    });
    this.entries.set(topicId, entry);
    return entry.pending;
  }

  private async _load(topicId: number): Promise<Torrent> {
    const torrentId = await this.resolveTorrentId(topicId);
    const kind = Buffer.isBuffer(torrentId) ? 'torrent' : 'magnet';
    log.info(`[stream] load topic ${topicId} (${kind})`);

    const skipVerify = Buffer.isBuffer(torrentId)
      ? await this.isCompleteOnDisk(torrentId)
      : false;

    return new Promise<Torrent>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Таймаут загрузки метаданных торрента.'));
        }
      }, 60_000);

      let torrent: Torrent;
      try {
        torrent = this.client.add(torrentId, this.addOptions(skipVerify), (t) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(t);
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      torrent.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  // Проверяет, полностью ли раздача уже лежит на диске (тогда не перепроверяем куски).
  private async isCompleteOnDisk(torrentBuf: Buffer): Promise<boolean> {
    try {
      const parsed = await parseTorrent(torrentBuf);
      if (!parsed.infoHash || !parsed.length || !parsed.files?.length) return false;
      const dir = path.join(TORRENT_DIR, `${parsed.name} - ${parsed.infoHash.slice(0, 8)}`);
      let total = 0;
      for (const f of parsed.files) {
        try {
          total += fs.statSync(path.join(dir, f.path)).size;
        } catch {
          return false;
        }
      }
      return total === parsed.length;
    } catch {
      return false;
    }
  }

  private async resolveTorrentId(topicId: number): Promise<Buffer | string> {
    try {
      return await this.source.getTorrentBuffer(topicId);
    } catch (e) {
      log.warn(`[stream] torrent download failed for ${topicId}, trying magnet`);
      const magnet = await this.source.getMagnet(topicId);
      if (magnet) return magnet;
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  private addOptions(skipVerify = false) {
    return {
      deselect: true,
      addUID: true,
      path: TORRENT_DIR,
      storeCacheSlots: 40,
      skipVerify,
    };
  }

  private touch(topicId: number) {
    const entry = this.entries.get(topicId);
    if (entry) entry.lastUsed = Date.now();
  }

  // Прогрев раздачи (фон, без остановки других): загружает торрент и заранее тянет
  // голову (для быстрого probe) и хвост (MKV Cues — для быстрого seek). Низкий
  // приоритет, чтобы не мешать активному плейбеку. Вызывается при открытии раздачи.
  async warm(topicId: number): Promise<void> {
    try {
      const torrent = await this.load(topicId, { quiet: true });
      const pieceLen = torrent.pieceLength;
      const n = torrent.pieces.length;
      if (n <= 0 || pieceLen <= 0) return;
      const headLast = Math.min(n - 1, Math.floor((8 * 1024 * 1024) / pieceLen));
      const tailFirst = Math.max(0, n - Math.ceil((4 * 1024 * 1024) / pieceLen));
      const sched = this.schedulerFor(topicId);
      if (sched) {
        if (headLast >= 0) sched.raise(0, headLast, Priority.PREVIEW);
        if (tailFirst < n) sched.raise(tailFirst, n - 1, Priority.PREVIEW);
        sched.commit();
      }
      log.info(
        `[stream] warm topic ${topicId} (${torrent.pieces.length} pieces, head 0..${headLast}, tail ${tailFirst}..${n - 1})`,
      );
    } catch (e) {
      log.warn(`[stream] warm ${topicId} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private evictIfNeeded() {
    const ready = [...this.entries.values()].filter((e) => e.torrent);
    ready.sort((a, b) => a.lastUsed - b.lastUsed);
    while (ready.length > MAX_ACTIVE) {
      const victim = ready.shift();
      if (!victim || !victim.torrent) break;
      this.entries.delete(victim.topicId);
      log.info(`[stream] evict topic ${victim.topicId} (over limit)`);
      victim.torrent.destroy({ destroyStore: true }, () => {});
    }
  }

  private sweepIdle() {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.torrent && now - entry.lastUsed > IDLE_TTL_MS) {
        this.entries.delete(id);
        log.info(`[stream] evict topic ${id} (idle)`);
        entry.torrent.destroy({ destroyStore: true }, () => {});
      }
    }
  }

  async getFile(topicId: number, fileIndex: number): Promise<{ torrent: Torrent; file: TorrentFile }> {
    const torrent = await this.load(topicId);
    const file = torrent.files[fileIndex];
    if (!file) throw new Error('Файл не найден в раздаче.');
    this.touch(topicId);
    return { torrent, file };
  }

  private schedulerFor(topicId: number): TorrentScheduler | null {
    return this.entries.get(topicId)?.scheduler ?? null;
  }

  // Снимает предыдущее окно воспроизведения (PLAYBACK/BUFFER), не трогая SEEK/SUBTITLE/PREVIEW.
  private releasePlayback(topicId: number): void {
    const scheduler = this.schedulerFor(topicId);
    const w = this.playWindows.get(topicId);
    if (!scheduler || !w) return;
    scheduler.releaseAt(w.playFirst, w.playLast, [Priority.PLAYBACK]);
    if (w.bufLast > w.playLast) {
      scheduler.releaseAt(w.playLast + 1, w.bufLast, [Priority.BUFFER]);
    }
    this.playWindows.delete(topicId);
  }

  // Оценивает битрейт файла (байт/с) для перевода «N секунд вперёд» в байты.
  private async bitrateBps(topicId: number, fileIndex: number, file: TorrentFile): Promise<number> {
    try {
      const media = await this.probe(topicId, fileIndex);
      if (media.durationSec && media.durationSec > 0 && file.length > 0) {
        return (file.length * 8) / media.durationSec;
      }
    } catch {
      /* probe may fail before metadata; fall back */
    }
    return FALLBACK_BITRATE_BPS;
  }

  private async lookaheadBytes(
    topicId: number,
    fileIndex: number,
    file: TorrentFile,
  ): Promise<number> {
    const bps = await this.bitrateBps(topicId, fileIndex, file);
    return Math.floor((bps / 8) * LOOKAHEAD_SECONDS);
  }

  topicIds(): number[] {
    return [...this.entries.keys()];
  }

  stop(topicId: number): void {
    const entry = this.entries.get(topicId);
    const t = entry?.torrent;
    if (!t || t.destroyed) return;
    this._stopTorrent(t);
    log.info(`[stream] stop topic ${topicId}`);
  }

  private stopAllExcept(topicId: number): void {
    for (const [id, entry] of this.entries) {
      if (id !== topicId && entry.torrent && !entry.torrent.destroyed) {
        this._stopTorrent(entry.torrent);
        log.info(`[stream] stop topic ${id} (new active)`);
      }
    }
  }

  private _stopTorrent(t: Torrent): void {
    try {
      t.pause();
      for (const f of t.files) f.deselect();
    } catch {
      /* ignore */
    }
  }

  resume(topicId: number, fileIndex: number): void {
    const entry = this.entries.get(topicId);
    const t = entry?.torrent;
    if (!t || t.destroyed) return;
    try {
      t.resume();
      for (let i = 0; i < t.files.length; i++) {
        if (i !== fileIndex) t.files[i].deselect();
      }
    } catch {
      /* ignore */
    }
    log.info(`[stream] resume topic ${topicId}`);
  }

  async files(topicId: number): Promise<StreamFile[]> {
    const torrent = await this.load(topicId);
    const files: StreamFile[] = torrent.files.map((f, i) => ({
      index: i,
      name: f.name,
      path: f.path,
      length: f.length,
      ext: extOf(f.name),
      mime: mimeFor(f.name),
      isVideo: isVideoFile(f.name),
    }));
    files.sort(
      (a, b) =>
        Number(b.isVideo) - Number(a.isVideo) || compareEpisodes(a.name, b.name),
    );
    return files;
  }

  async openStream(
    topicId: number,
    fileIndex: number,
    opts: OpenStreamOptions = {},
  ): Promise<{ torrent: Torrent; file: TorrentFile; stream: Readable }> {
    const { torrent, file } = await this.getFile(topicId, fileIndex);
    for (let i = 0; i < torrent.files.length; i++) {
      if (i !== fileIndex) torrent.files[i].deselect();
    }

    // Не выбираем весь файл: поднимаем приоритет запрошенного диапазона и окна
    // read-ahead вперёд. Читаемый диапазон отдельно стримится самим
    // file.createReadStream (stream-selection + critical), а уже скачанные куски
    // webtorrent и так убирает из selection — поэтому raise без release не накапливает
    // весь файл, а только тянет окно вперёд от плейхеда.
    const start = opts.start ?? 0;
    const end = Math.min(opts.end ?? file.length - 1, file.length - 1);
    const scheduler = this.schedulerFor(topicId);
    if (scheduler && !opts.feed && end >= start && file.length > 0) {
      // Перемотка/продвижение плейхеда: снимаем прошлое окно, чтобы старый диапазон
      // не продолжал тянуть куски в обход нового приоритета.
      this.releasePlayback(topicId);
      const { first: playFirst, last: playLast } = pieceRange(
        file.offset,
        start,
        end,
        torrent.pieceLength,
      );
      scheduler.raise(playFirst, playLast, Priority.PLAYBACK);
      const lookaheadEnd = Math.min(
        file.length - 1,
        end + (await this.lookaheadBytes(topicId, fileIndex, file)),
      );
      let bufLast = playLast;
      if (lookaheadEnd > end) {
        bufLast = pieceRange(file.offset, end + 1, lookaheadEnd, torrent.pieceLength).last;
        if (bufLast > playLast) scheduler.raise(playLast + 1, bufLast, Priority.BUFFER);
      }
      this.playWindows.set(topicId, { playFirst, playLast, bufLast });
      scheduler.commit();
    }

    const stream = file.createReadStream({
      start: opts.start,
      end: opts.end,
    });
    return { torrent, file, stream };
  }

  private markCritical(torrent: Torrent, first: number, last: number): void {
    const span = Math.max(8, Math.ceil(CRITICAL_WINDOW_BYTES / torrent.pieceLength));
    torrent.critical(first, Math.min(first + span, last));
  }

  async prioritizeRange(
    topicId: number,
    fileIndex: number,
    start: number,
    end: number,
    priority: number = Priority.SEEK,
  ): Promise<void> {
    const { torrent, file } = await this.getFile(topicId, fileIndex);
    const { first, last } = pieceRange(file.offset, start, end, torrent.pieceLength);
    this.schedulerFor(topicId)?.raise(first, last, priority);
    this.schedulerFor(topicId)?.commit();
    this.markCritical(torrent, first, last);
  }

  // Приоритетно качает «хвост» файла, где обычно лежит seek-индекс (MKV Cues,
  // MP4 moov, AVI idx1). Без него ffmpeg при -ss делает полный проход всего файла.
  async prioritizeTail(topicId: number, fileIndex: number, bytes = 4 * 1024 * 1024): Promise<void> {
    const { file } = await this.getFile(topicId, fileIndex);
    if (file.length <= 0) return;
    const tailStart = Math.max(0, file.length - bytes);
    await this.prioritizeRange(topicId, fileIndex, tailStart, file.length - 1, Priority.SEEK);
  }

  // Приоритетно качает диапазон байт, соответствующий окну [startSec, startSec+durSec].
  async prioritizeTimeRange(
    topicId: number,
    fileIndex: number,
    startSec: number,
    durSec: number,
  ): Promise<void> {
    const { file } = await this.getFile(topicId, fileIndex);
    const media = await this.probe(topicId, fileIndex);
    const dur = media.durationSec ?? 0;
    if (dur <= 0 || file.length <= 0) return;
    const startFrac = Math.min(1, Math.max(0, startSec / dur));
    const endFrac = Math.min(1, Math.max(0, (startSec + durSec) / dur));
    const byteStart = Math.floor(startFrac * file.length);
    const byteEnd = Math.max(byteStart, Math.floor(endFrac * file.length) - 1);
    await this.prioritizeRange(topicId, fileIndex, byteStart, byteEnd, Priority.SEEK);
  }

  // Помечает диапазон байт приоритетным и ждёт, пока его куски реально скачаются
  // (с таймаутом). Нужно, чтобы ffmpeg не блокировался на нескачанных данных.
  async waitForBytes(
    topicId: number,
    fileIndex: number,
    start: number,
    end: number,
    timeoutMs = 20_000,
  ): Promise<boolean> {
    const { torrent, file } = await this.getFile(topicId, fileIndex);
    if (file.length <= 0) return true;
    const clampedEnd = Math.min(end, file.length - 1);
    if (clampedEnd < start) return true;
    const { first, last } = pieceRange(file.offset, start, clampedEnd, torrent.pieceLength);
    const scheduler = this.schedulerFor(topicId);
    scheduler?.raise(first, last, Priority.SEEK);
    scheduler?.commit();
    this.markCritical(torrent, first, last);
    const stopTimer = perf.timer('stream.waitForBytes.ms');
    const deadline = Date.now() + timeoutMs;
    const pieces = torrent.pieces;
    const allReceived = () => {
      for (let i = first; i <= last; i++) {
        const piece = pieces[i];
        if (!torrent.bitfield.get(i) && (!piece || piece.missing > 0)) return false;
      }
      return true;
    };
    if (allReceived()) {
      stopTimer();
      return true;
    }
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if (allReceived()) {
        stopTimer();
        return true;
      }
    }
    stopTimer();
    return allReceived();
  }

  // Быстрая проверка, скачаны ли куски диапазона (без ожидания и без выбора).
  async areBytesReady(
    topicId: number,
    fileIndex: number,
    start: number,
    end: number,
  ): Promise<boolean> {
    const { torrent, file } = await this.getFile(topicId, fileIndex);
    const clampedEnd = Math.min(end, file.length - 1);
    if (clampedEnd < start || start >= file.length) return false;
    const { first, last } = pieceRange(file.offset, start, clampedEnd, torrent.pieceLength);
    const pieces = torrent.pieces;
    for (let i = first; i <= last; i++) {
      const piece = pieces[i];
      if (!torrent.bitfield.get(i) && (!piece || piece.missing > 0)) return false;
    }
    return true;
  }

  // Читает байты файла [start, end] с диска, дожидаясь скачивания именно этого
  // диапазона (createReadStream ждёт конкретные байты, а не целые куски).
  // Возвращает null, если данные не успели скачаться за timeoutMs.
  async readBytes(
    topicId: number,
    fileIndex: number,
    start: number,
    end: number,
    timeoutMs = 5000,
    priority: number = Priority.SUBTITLE,
  ): Promise<Buffer | null> {
    const { torrent, file } = await this.getFile(topicId, fileIndex);
    if (file.length <= 0) return null;
    const clampedEnd = Math.min(end, file.length - 1);
    if (clampedEnd < start || start >= file.length) return null;
    // Выбираем и приоритизируем куски диапазона, чтобы читатель мог их получить.
    const { first, last } = pieceRange(file.offset, start, clampedEnd, torrent.pieceLength);
    const scheduler = this.schedulerFor(topicId);
    scheduler?.raise(first, last, priority);
    scheduler?.commit();
    this.markCritical(torrent, first, last);

    return new Promise<Buffer | null>((resolve) => {
      let settled = false;
      const stream = file.createReadStream({ start, end: clampedEnd });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.destroy();
        resolve(null);
      }, timeoutMs);
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      stream.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  async status(topicId: number, fileIndex?: number): Promise<StreamStatus> {
    const entry = this.entries.get(topicId);
    if (!entry?.torrent) {
      return {
        infoHash: '',
        ready: false,
        downloaded: 0,
        downloadSpeed: 0,
        numPeers: 0,
        progress: 0,
        paused: false,
        file: null,
      };
    }
    const t = entry.torrent;
    let file: StreamStatus['file'] = null;
    if (fileIndex != null) {
      const f = t.files[fileIndex];
      if (f) {
        file = { index: fileIndex, length: f.length, downloaded: f.downloaded, progress: f.progress };
      }
    }
    return {
      infoHash: t.infoHash,
      ready: t.ready,
      downloaded: t.downloaded,
      downloadSpeed: t.downloadSpeed,
      numPeers: t.numPeers,
      progress: t.progress,
      paused: t.paused,
      file,
    };
  }

  async probe(topicId: number, fileIndex: number): Promise<MediaInfo> {
    const key = `${topicId}:${fileIndex}`;
    const cached = this.probeCache.get(key);
    if (cached) return cached;

    const { file } = await this.getFile(topicId, fileIndex);
    const ext = extOf(file.name);
    const limit = Math.min(file.length, PROBE_BYTES);
    const stream = file.createReadStream({ start: 0, end: limit - 1 });

    try {
      const stopTimer = perf.timer('stream.probe.ms');
      const json = await runFfprobe(stream);
      stopTimer();
      const media = mapProbe(json, ext);
      this.probeCache.set(key, media);
      return media;
    } catch (e) {
      log.warn(`[stream] ffprobe failed for ${file.name}: ${e instanceof Error ? e.message : e}`);
      return {
        container: ext || null,
        videoCodec: null,
        audioCodec: null,
        width: null,
        height: null,
        durationSec: null,
        fps: null,
        bitrate: null,
        pixFmt: null,
        canDirectPlay: false,
        audioTracks: [],
        subtitleTracks: [],
      };
    } finally {
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  // Останавливает и удаляет с диска все раздачи, но оставляет WebTorrent-клиент живым.
  async clearAll(): Promise<void> {
    for (const [, entry] of this.entries) {
      if (entry.torrent && !entry.torrent.destroyed) {
        await new Promise<void>((res) =>
          entry.torrent?.destroy({ destroyStore: true }, () => res()),
        );
      }
    }
    this.entries.clear();
    this.probeCache.clear();
    this.playWindows.clear();
    log.info('[stream] cleared all torrents');
  }

  // Удаляет с диска (destroyStore) все раздачи, кроме keepTopicId, и чистит их
  // кеши в памяти. Нужно при активации нового видео: кеш предыдущих раздач больше
  // не нужен (требование «при старте нового видео очистить кеш первого»).
  async destroyOthers(keepTopicId: number): Promise<void> {
    const victims: Torrent[] = [];
    for (const [id, entry] of this.entries) {
      if (id === keepTopicId) continue;
      if (entry.torrent && !entry.torrent.destroyed) victims.push(entry.torrent);
      this.entries.delete(id);
      this.playWindows.delete(id);
    }
    for (const key of this.probeCache.keys()) {
      if (!key.startsWith(`${keepTopicId}:`)) this.probeCache.delete(key);
    }
    if (victims.length === 0) return;
    await Promise.all(
      victims.map(
        (t) => new Promise<void>((res) => t.destroy({ destroyStore: true }, () => res())),
      ),
    );
    log.info(`[cache] pruned torrent stores of ${victims.length} other topic(s) (keep ${keepTopicId})`);
  }

  async destroy(): Promise<void> {
    clearInterval(this.idleTimer);
    for (const [, entry] of this.entries) {
      if (entry.torrent) {
        await new Promise<void>((res) => entry.torrent?.destroy(() => res()));
      }
    }
    this.entries.clear();
    this.probeCache.clear();
    await new Promise<void>((res) => this.client.destroy(() => res()));
    log.info('[stream] client destroyed');
  }
}

function runFfprobe(input: Readable): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffprobePath,
      ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', '-i', 'pipe:0'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('ffprobe: некорректный JSON'));
        }
      } else {
        reject(new Error(stderr.trim() || `ffprobe exit ${code}`));
      }
    });
    input.on('error', () => {});
    input.pipe(proc.stdin);
  });
}

function mapProbe(json: unknown, ext: string): MediaInfo {
  type FfStream = {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    channels?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    pix_fmt?: string;
    disposition?: { default?: number; forced?: number };
    tags?: { language?: string; title?: string };
  };
  const j = json as {
    streams?: FfStream[];
    format?: { format_name?: string; duration?: string; bit_rate?: string };
  };
  const video = j.streams?.find((s) => s.codec_type === 'video');
  const audio = j.streams?.find((s) => s.codec_type === 'audio');
  const videoCodec = video?.codec_name ?? null;
  const audioCodec = audio?.codec_name ?? null;
  const duration = Number.parseFloat(j.format?.duration ?? '');
  const fps = parseFrameRate(video?.avg_frame_rate ?? video?.r_frame_rate ?? null);
  const pixFmt = video?.pix_fmt ?? null;
  const bitrateRaw = Number.parseFloat(j.format?.bit_rate ?? '');
  const bitrate = Number.isFinite(bitrateRaw) && bitrateRaw > 0 ? bitrateRaw : null;

  const audioTracks = (j.streams ?? [])
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.codec_type === 'audio')
    .map(({ s, i }) => ({
      index: i,
      codec: s.codec_name ?? null,
      language: s.tags?.language ?? null,
      title: s.tags?.title ?? null,
      channels: s.channels ?? null,
      default: s.disposition?.default === 1,
      forced: s.disposition?.forced === 1,
      isText: false,
    }));

  const subtitleTracks = (j.streams ?? [])
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.codec_type === 'subtitle')
    .map(({ s, i }) => ({
      index: i,
      codec: s.codec_name ?? null,
      language: s.tags?.language ?? null,
      title: s.tags?.title ?? null,
      channels: null,
      default: s.disposition?.default === 1,
      forced: s.disposition?.forced === 1,
      isText: isTextSubtitleCodec(s.codec_name ?? null),
    }));

  return {
    container: j.format?.format_name ?? (ext || null),
    videoCodec,
    audioCodec,
    width: video?.width ?? null,
    height: video?.height ?? null,
    durationSec: Number.isFinite(duration) ? duration : null,
    fps,
    bitrate,
    pixFmt,
    canDirectPlay: canDirectPlay(ext, videoCodec, audioCodec),
    audioTracks,
    subtitleTracks,
  };
}

function parseFrameRate(rate: string | null): number | null {
  if (!rate) return null;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(rate.trim());
  if (m) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (den > 0 && Number.isFinite(num)) return num / den;
  }
  const v = Number.parseFloat(rate);
  return Number.isFinite(v) && v > 0 ? v : null;
}
