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
// Таймаут ffprobe: без него чтение недокачанной головы файла висело бы вечно.
const PROBE_TIMEOUT_MS = 20_000;
// «Сейчас»-окно, помечаемое critical: только чтобы waitForBytes/readBytes быстрее
// получали именно нужные куски. Необратимо (webtorrent), поэтому держим небольшим.
const CRITICAL_WINDOW_BYTES = 8 * 1024 * 1024;
const TORRENT_DIR = path.join(DATA_DIR, 'cache', 'torrents');
// Персист DHT-таблицы: одна общая «адресная книга» узлов на все раздачи. Без неё
// после каждого рестарта DHT стартует с пустой таблицей и набирает узлы через
// медленный ре-бутстрап (~5-10 минут), из-за чего пиры появляются не сразу.
const DHT_NODES_FILE = path.join(DATA_DIR, 'dht-nodes.json');
const DHT_SAVE_INTERVAL_MS = 5 * 60 * 1000;

interface DhtNode {
  host: string;
  port: number;
}

interface DhtLike {
  addNode?: (node: DhtNode) => void;
  toJSON?: () => { nodes?: DhtNode[] };
}

export class StreamManager {
  private client: WebTorrent;
  private entries = new Map<number, Entry>();
  private idleTimer: NodeJS.Timeout;
  private dhtSaveTimer: NodeJS.Timeout;
  private probeCache = new Map<string, MediaInfo>();
  private playWindows = new Map<number, { playFirst: number; playLast: number; bufLast: number }>();

  constructor(private source: StreamManagerSource) {
    this.client = new WebTorrent({ dht: true, tracker: {} });
    this.client.on('error', (err) => {
      log.warn(`[stream] client error: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.restoreDhtNodes();
    this.dhtSaveTimer = setInterval(() => this.saveDhtNodes(), DHT_SAVE_INTERVAL_MS);
    this.dhtSaveTimer.unref();
    this.idleTimer = setInterval(() => this.sweepIdle(), 60_000);
    this.idleTimer.unref();
  }

  // Общий DHT-инстанс WebTorrent (один на все торренты). Доступ не типизирован в
  // @types — достаём вручную, признаём по наличию нужных методов.
  private get dht(): DhtLike | null {
    const d = (this.client as unknown as { dht?: unknown }).dht;
    return d && typeof d === 'object' ? (d as DhtLike) : null;
  }

  private restoreDhtNodes(): void {
    const dht = this.dht;
    if (!dht || typeof dht.addNode !== 'function') return;
    try {
      const raw = fs.readFileSync(DHT_NODES_FILE, 'utf8');
      const parsed = JSON.parse(raw) as { nodes?: DhtNode[] };
      const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
      let added = 0;
      for (const n of nodes) {
        if (n && typeof n.host === 'string' && typeof n.port === 'number' && n.port > 0) {
          dht.addNode({ host: n.host, port: n.port });
          added++;
        }
      }
      if (added > 0) log.info(`[stream] restored ${added} dht nodes`);
    } catch {
      /* первый запуск или повреждённый файл — начнём с пустой таблицы */
    }
  }

  private saveDhtNodes(): void {
    const dht = this.dht;
    if (!dht || typeof dht.toJSON !== 'function') return;
    try {
      const nodes = dht.toJSON().nodes ?? [];
      if (nodes.length === 0) return;
      const tmp = `${DHT_NODES_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ nodes }), 'utf8');
      fs.renameSync(tmp, DHT_NODES_FILE);
    } catch {
      /* не критично: при следующем тике попробуем снова */
    }
  }

  async load(topicId: number, opts: { quiet?: boolean } = {}): Promise<Torrent> {
    const existing = this.entries.get(topicId);
    if (existing) {
      existing.lastUsed = Date.now();
      if (existing.torrent) {
        if (existing.torrent.paused) {
          existing.torrent.resume();
          // stop() снял selection'ы через deselect — возвращаем желаемые диапазоны.
          existing.scheduler?.commit();
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
    entry.pending = this._load(topicId)
      .then((torrent) => {
        entry.torrent = torrent;
        entry.pending = null;
        entry.scheduler = new TorrentScheduler(torrent);
        this.evictIfNeeded();
        return torrent;
      })
      .catch((err) => {
        // Отравленная запись (rejected) навсегда блокировала бы топик — удаляем её,
        // чтобы следующая попытка открыла раздачу заново.
        if (this.entries.get(topicId) === entry) this.entries.delete(topicId);
        throw err;
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

    // Инфо-хэш известен заранее только для .torrent (у магнита — после метаданных).
    let ihash: string | null = null;
    if (Buffer.isBuffer(torrentId)) {
      try {
        ihash = (await parseTorrent(torrentId)).infoHash ?? null;
      } catch {
        ihash = null;
      }
    }
    if (ihash) {
      const dup = this.findClientTorrent(ihash);
      if (dup && !dup.destroyed) {
        // Дубль в клиенте (другой топик на тот же файл, либо «осиротевший» после
        // очистки/гонки): уничтожаем без удаления данных с диска и добавляем заново.
        // Именно это «Cannot add duplicate torrent» очистка кеша не лечит — он живёт
        // в памяти webtorrent-клиента, а не в файлах.
        log.warn(`[stream] duplicate infohash ${ihash} in client — destroying stale copy, disk kept`);
        await this.destroyQuiet(dup, { destroyStore: false });
      }
    }

    return this.addWithRetry(topicId, torrentId, skipVerify, ihash);
  }

  private findClientTorrent(ihash: string): Torrent | undefined {
    const torrents = (this.client as unknown as { torrents: Torrent[] }).torrents ?? [];
    return torrents.find((t) => t.infoHash === ihash);
  }

  private destroyQuiet(t: Torrent, opts?: { destroyStore?: boolean }): Promise<void> {
    if (t.destroyed) return Promise.resolve();
    return new Promise<void>((res) => {
      try {
        t.destroy(opts ?? {}, () => res());
      } catch {
        res();
      }
    });
  }

  // Добавление с авто-лечением дубля: если в момент add в клиент уже попал тот же
  // инфо-хэш (гонка двух параллельных загрузок одного файла под разными топиками) —
  // уничтожаем старую копию (без потери диска) и повторяем один раз.
  private async addWithRetry(
    topicId: number,
    torrentId: Buffer | string,
    skipVerify: boolean,
    ihash: string | null,
  ): Promise<Torrent> {
    const attempt = (): Promise<Torrent> =>
      new Promise<Torrent>((resolve, reject) => {
        let settled = false;
        let torrentRef: Torrent | null = null;

        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            torrentRef?.destroy(() => {});
          } catch {
            /* ignore */
          }
          reject(err instanceof Error ? err : new Error(String(err)));
        };

        const timer = setTimeout(() => {
          fail(new Error('Таймаут загрузки метаданных торрента.'));
        }, 60_000);

        let torrent: Torrent;
        try {
          torrent = this.client.add(torrentId, this.addOptions(skipVerify), (_t) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(_t);
          });
          torrentRef = torrent;
        } catch (e) {
          fail(e);
          return;
        }

        // Причины 0 пиров живут здесь: трекер отвечает failure/warning (напр. «Invalid
        // info_hash», Non-200, сетевые сбои) или просто не даёт пиров. Без этих логов
        // симптом «0 пиров и таймаут метаданных» висит молча.
        torrent.on('warning', (w) => {
          const msg = typeof w === 'string' ? w : w instanceof Error ? w.message : String(w);
          log.warn(`[stream] topic ${topicId} warning: ${msg}`);
        });
        torrent.on('error', (err) => {
          fail(err);
        });
      });

    try {
      return await attempt();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate/i.test(msg) && ihash) {
        const dup = this.findClientTorrent(ihash);
        if (dup) {
          log.warn(`[stream] add raced with duplicate ${ihash} — retry after cleanup`);
          await this.destroyQuiet(dup, { destroyStore: false });
          return attempt();
        }
      }
      throw e;
    }
  }

  // Проверяет, полностью ли раздача уже лежит на диске (тогда не перепроверяем куски).
  private async isCompleteOnDisk(torrentBuf: Buffer): Promise<boolean> {
    try {
      const parsed = await parseTorrent(torrentBuf);
      if (!parsed.infoHash || !parsed.length || !parsed.files?.length) return false;
      const dir = path.join(TORRENT_DIR, `${parsed.name} - ${parsed.infoHash.slice(0, 8)}`);
      const root = path.resolve(dir);
      const stat = fs.promises.stat;
      let total = 0;
      for (const f of parsed.files) {
        try {
          const p = path.resolve(root, f.path);
          // Пути из торрента не должны выходить за пределы каталога раздачи.
          if (p !== root && !p.startsWith(root + path.sep)) return false;
          total += (await stat(p)).size;
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
    // .torrent предпочтителен (известен infoHash → быстрый старт + skipVerify), но не
    // ждём его провала, чтобы потом последовательно дёргать magnet: запускаем оба сразу.
    const [torrentRes, magnetRes] = await Promise.allSettled([
      this.source.getTorrentBuffer(topicId),
      this.source.getMagnet(topicId),
    ]);
    if (torrentRes.status === 'fulfilled') return torrentRes.value;
    const torrentErr = torrentRes.status === 'rejected' ? torrentRes.reason : null;
    if (magnetRes.status === 'fulfilled' && magnetRes.value) {
      if (torrentErr) {
        log.warn(
          `[stream] topic ${topicId}: .torrent download failed (${errMsg(torrentErr)}), using magnet`,
        );
      } else {
        log.warn(`[stream] topic ${topicId}: .torrent unavailable, using magnet`);
      }
      return magnetRes.value;
    }
    if (torrentErr) {
      log.warn(`[stream] topic ${topicId}: .torrent download failed and magnet unavailable`);
      throw torrentErr instanceof Error ? torrentErr : new Error(String(torrentErr));
    }
    log.warn(`[stream] topic ${topicId}: .torrent unavailable, no magnet`);
    throw new Error('Не удалось получить .torrent и magnet.');
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
      this.playWindows.delete(victim.topicId);
      log.info(`[stream] evict topic ${victim.topicId} (over limit)`);
      victim.torrent.destroy({ destroyStore: true }, () => {});
    }
  }

  private sweepIdle() {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.torrent && now - entry.lastUsed > IDLE_TTL_MS) {
        this.entries.delete(id);
        this.playWindows.delete(id);
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
    this._stopTorrent(topicId, t);
    log.info(`[stream] stop topic ${topicId}`);
  }

  private stopAllExcept(topicId: number): void {
    for (const [id, entry] of this.entries) {
      if (id !== topicId && entry.torrent && !entry.torrent.destroyed) {
        this._stopTorrent(id, entry.torrent);
        log.info(`[stream] stop topic ${id} (new active)`);
      }
    }
  }

  // Снимает выбор со всех файлов и паузит торрент. Сообщает планировщику, что
  // реальные selection'ы сняты, чтобы последующий commit()/resume вернул желаемое.
  private _stopTorrent(topicId: number, t: Torrent): void {
    try {
      t.pause();
      const sched = this.schedulerFor(topicId);
      for (const f of t.files) {
        if (f.length > 0) {
          const r = pieceRange(f.offset, 0, f.length - 1, t.pieceLength);
          try {
            f.deselect();
          } catch {
            /* ignore */
          }
          sched?.externalDeselect(r.first, r.last);
        }
      }
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
      const sched = this.schedulerFor(topicId);
      for (let i = 0; i < t.files.length; i++) {
        if (i !== fileIndex) {
          const f = t.files[i];
          if (f.length > 0) {
            const r = pieceRange(f.offset, 0, f.length - 1, t.pieceLength);
            try {
              f.deselect();
            } catch {
              /* ignore */
            }
            sched?.externalDeselect(r.first, r.last);
          }
        }
      }
      // stop() снял selection'ы — возвращаем желаемые (окно плейбека и пр.).
      sched?.commit();
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
    const scheduler = this.schedulerFor(topicId);
    for (let i = 0; i < torrent.files.length; i++) {
      if (i !== fileIndex) {
        const other = torrent.files[i];
        if (other.length > 0) {
          const r = pieceRange(other.offset, 0, other.length - 1, torrent.pieceLength);
          try {
            other.deselect();
          } catch {
            /* ignore */
          }
          // file.deselect() снимает и selection'ы планировщика — синхронизируем applied,
          // чтобы возврат на этот файл пере-выбрал желаемые куски (см. TorrentScheduler).
          scheduler?.externalDeselect(r.first, r.last);
        }
      }
    }

    // Не выбираем весь файл: поднимаем приоритет запрошенного диапазона и окна
    // read-ahead вперёд. Читаемый диапазон отдельно стримится самим
    // file.createReadStream (stream-selection + critical), а уже скачанные куски
    // webtorrent и так убирает из selection — поэтому raise без release не накапливает
    // весь файл, а только тянет окно вперёд от плейхеда.
    const start = opts.start ?? 0;
    const end = Math.min(opts.end ?? file.length - 1, file.length - 1);
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
    if (torrent.destroyed) return;
    const span = Math.max(8, Math.ceil(CRITICAL_WINDOW_BYTES / torrent.pieceLength));
    try {
      torrent.critical(first, Math.min(first + span, last));
    } catch {
      /* ignore */
    }
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
    if (torrent.destroyed) return false;
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
      if (torrent.destroyed) break; // раздача уничтожена — ждать нечего
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
    if (torrent.destroyed) return false;
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
    if (torrent.destroyed) return null;
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
        // Куски так и не доехали: снимаем поднятый приоритет, чтобы он не «перебивал»
        // обычные PLAYBACK-куски до конца жизни торрента.
        scheduler?.releaseAt(first, last, [priority]);
        scheduler?.commit();
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
        scheduler?.releaseAt(first, last, [priority]);
        scheduler?.commit();
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
      const json = await runFfprobe(stream, PROBE_TIMEOUT_MS);
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
    const victims: Array<{ id: number; t: Torrent }> = [];
    for (const [id, entry] of this.entries) {
      if (id === keepTopicId) continue;
      if (entry.torrent && !entry.torrent.destroyed) victims.push({ id, t: entry.torrent });
      else this.entries.delete(id);
      this.playWindows.delete(id);
    }
    for (const key of this.probeCache.keys()) {
      if (!key.startsWith(`${keepTopicId}:`)) this.probeCache.delete(key);
    }
    // Удаляем записи ТОЛЬКО после фактического destroy: если удалить сразу, гонка
    // «новый load того же топика» добавит в клиент тот же инфо-хэш до завершения
    // destroy и получит «Cannot add duplicate torrent».
    if (victims.length > 0) {
      await Promise.all(
        victims.map(({ t }) => this.destroyQuiet(t, { destroyStore: true })),
      );
      for (const { id } of victims) this.entries.delete(id);
      log.info(`[cache] pruned torrent stores of ${victims.length} other topic(s) (keep ${keepTopicId})`);
    }
  }

  async destroy(): Promise<void> {
    clearInterval(this.idleTimer);
    clearInterval(this.dhtSaveTimer);
    this.saveDhtNodes();
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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function runFfprobe(input: Readable, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const proc = spawn(
      ffprobePath,
      ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', '-i', 'pipe:0'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';

    const settle = (err?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        // Снимаем источник/пайп, чтобы не оставить висящий стрим/процесс.
        try {
          proc.stdin.destroy();
        } catch {
          /* ignore */
        }
        try {
          input.destroy();
        } catch {
          /* ignore */
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      settle(new Error('ffprobe timeout'));
    }, timeoutMs);

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    // ffprobe может выйти раньше конца входного потока — писать в закрытый stdin
    // нельзя (EPIPE → uncaughtException).
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => settle(err));
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    input.on('error', () => {
      try {
        input.unpipe(proc.stdin);
      } catch {
        /* ignore */
      }
    });
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
