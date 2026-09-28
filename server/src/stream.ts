import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import bencode from 'bencode';
import WebTorrent from 'webtorrent';
import type { Torrent, TorrentFile } from 'webtorrent';
import parseTorrent from 'parse-torrent';
import { ProxyAgent } from 'undici';
import { SafeFSChunkStore, sanitizeTorrentName } from './torrent-store.js';
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
// Размер окна чтения файла. Читаем диапазон окнами, а не одним createReadStream:
// иначе webtorrent создаёт stream-selection на весь диапазон (для feed — весь остаток
// файла, ~11600 кусков), и его piece-picker при sequential-стратегии сканирует тысячи
// кусков на каждого пира каждый тик → забивает main-поток (профиль: ~32% CPU в
// trySelectWire), из-за чего feed к ffmpeg падает до ~3МБ/с и транскод голодает.
const READ_WINDOW_BYTES = 16 * 1024 * 1024;
// Фолбэк-битрейт, когда длительность/размер не дают оценку (8 Мбит/с).
const FALLBACK_BITRATE_BPS = 8_000_000;

export interface StreamManagerSource {
  getTorrentBuffer(topicId: number): Promise<Buffer>;
  getMagnet(topicId: number): Promise<string | null>;
  // URL http-прокси VPN (как у HttpClient/браузера) либо null. Через него гоняем
  // HTTP-анонсы трекеров: родной трекер rutracker за Cloudflare недоступен напрямую
  // (fetch failed), и через VPN-выход announce проходит и отдаёт список пиров.
  getProxyUrl?(): string | null;
  // GET трекерного анонса через «рабочий» путь (VPN + браузерный UA + Cloudflare).
  // Возвращает тело ответа (bencode) либо null. Через него добираем пиров, когда
  // сам webtorrent до трекера не достучался.
  fetchTracker?(url: string): Promise<Buffer | null>;
}

// Локальный источник раздачи (magnet/.torrent, без rutracker): либо готовая
// magnet-строка, либо путь к сохранённому .torrent на диске.
export interface LocalSourceSpec {
  magnet?: string;
  torrentFile?: string;
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
// Короткий TTL негативного кеша probe: не долбим источник на каждый опрос, но даём
// шанс, когда байты головы докачаются.
const PROBE_NEGATIVE_TTL_MS = 10_000;
// Таймаут ffprobe: без него чтение недокачанной головы файла висело бы вечно.
const PROBE_TIMEOUT_MS = 20_000;
// «Сейчас»-окно, помечаемое critical: только чтобы waitForBytes/readBytes быстрее
// получали именно нужные куски. Необратимо (webtorrent), поэтому держим небольшим.
const CRITICAL_WINDOW_BYTES = 8 * 1024 * 1024;
const TORRENT_DIR = path.join(DATA_DIR, 'cache', 'torrents');
// Публичные трекеры в дополнение к родному (часто родной недоступен — напр. bt.t-ru.org
// падает с «fetch failed», и остаётся только DHT, который на малопировых раздачах
// находит 2-3 пира). Дополнительные трекеры помогают добрать пиров. Можно переопределить
// через TP_TRACKERS (через запятую).
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'https://tracker.tamersunion.org:443/announce',
];
const EXTRA_TRACKERS = process.env.TP_TRACKERS
  ? process.env.TP_TRACKERS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_TRACKERS;
// Трекерные HTTP-анонсы идут с браузерным User-Agent: Cloudflare (перед bt.t-ru.org)
// режет пустой/нестандартный UA.
const TRACKER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// BEP9 `xs=` («exact source») в magnet заставляет webtorrent качать метаданные по
// произвольному URL напрямую (своим fetch'ем мимо SSRF-защиты). Вырезаем эти
// параметры: для обычных раздач метаданные и так приходят от пиров по ut_metadata.
function stripMagnetXs(id: Buffer | string): Buffer | string {
  if (typeof id !== 'string' || !id.toLowerCase().startsWith('magnet:')) return id;
  const q = id.indexOf('?');
  if (q < 0) return id;
  const kept = id
    .slice(q + 1)
    .split('&')
    .filter((p) => p && !/^xs=/i.test(p));
  return id.slice(0, q + 1) + kept.join('&');
}
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
  // Короткий негативный кеш: неудачный probe (байты головы ещё не доехали) не должен
  // перезапускать ffprobe-шторм на каждый опрос, но и «залипать» надолго нельзя —
  // голова может докачаться. TTL короткий.
  private probeNegative = new Map<string, { media: MediaInfo; until: number }>();
  // Дедуп одновременных probe() по ключу: N параллельных вызовов на один файл
  // раньше плодили N×3 ffprobe-процесса.
  private probeInflight = new Map<string, Promise<MediaInfo>>();
  private playWindows = new Map<number, { playFirst: number; playLast: number; bufLast: number }>();
  // Локальные (magnet/.torrent) источники: отрицательные topicId, в приоритете
  // перед rutracker-фетчерами (для них на rutracker не ходим вовсе).
  private localSources = new Map<number, LocalSourceSpec>();
  // Текущий лимит закачки (bytes/s, -1 = без лимита) — чтобы не дёргать throttle зря.
  private currentLimit = -2;
  // Агент VPN-прокси для трекерных HTTP-анонсов (переиспользуем на один URL).
  private trackerAgent: { url: string; agent: ProxyAgent } | null = null;
  // Свой peer_id (20 байт) для ручных анонсов.
  private readonly peerId20 = Buffer.concat([Buffer.from('-TP0001-'), randomBytes(12)]);

  constructor(private source: StreamManagerSource) {
    const torrentPort = Number(process.env.TP_TORRENT_PORT) || undefined;
    // utp-native (webtorrent's optional uTP transport) is orders of magnitude slower
    // than TCP (~4 vs ~55 MB/s measured). Default to TCP-only; TP_UTP=1 re-enables uTP.
    this.client = new WebTorrent({
      dht: true,
      tracker: {},
      utp: process.env.TP_UTP === '1',
      // BEP19 web seeds: недоверенный торрент может прописать url-list на приватные
      // адреса (роутер/NAS/localhost) — webtorrent качает их своим fetch'ем мимо нашей
      // SSRF-защиты. Пиры по TCP/DHT это не затрагивает.
      webSeeds: false,
      ...(torrentPort ? { torrentPort } : {}),
    });
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
      if (existing.torrent && !existing.torrent.destroyed) {
        if (existing.torrent.paused) {
          existing.torrent.resume();
          // stop() снял selection'ы через deselect — возвращаем желаемые диапазоны.
          existing.scheduler?.commit();
          log.info(`[stream] resume topic ${topicId} (reload)`);
        }
        return existing.torrent;
      }
      if (existing.pending) return existing.pending;
      // Торрент уничтожен извне (ошибка store/дубль по infoHash) — запись «мертва»:
      // выбрасываем её, иначе load()/getFile() навсегда возвращали бы сломанный торрент.
      if (existing.torrent) {
        this.entries.delete(topicId);
        this.playWindows.delete(topicId);
        log.warn(`[stream] dropped destroyed torrent for topic ${topicId}`);
      }
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

    this.configureTracker();
    const torrent = await this.addWithRetry(topicId, torrentId, skipVerify, ihash);
    // Добираем пиров ручным анонсом (webtorrent до Cloudflare-трекеров не доходит).
    void this.announceTrackers(torrent);
    return torrent;
  }

  // Настраивает трекерный клиент webtorrent перед добавлением торрента: браузерный
  // User-Agent и (если VPN активен) прокси. Через VPN-выход проходит анонс родного
  // трекера rutracker (он за Cloudflare — напрямую падал «fetch failed»), и мы
  // получаем список пиров, а не полагаемся только на DHT.
  private configureTracker(): void {
    const proxy = this.source.getProxyUrl?.() ?? null;
    const opts: Record<string, unknown> = { userAgent: TRACKER_UA };
    if (proxy) {
      if (this.trackerAgent && this.trackerAgent.url !== proxy) {
        // Прокси сменился (VPN переподключился) — старый агент больше не нужен,
        // закрываем его, чтобы не копить сокеты/дескрипторы.
        try {
          void this.trackerAgent.agent.close();
        } catch {
          /* ignore */
        }
        this.trackerAgent = null;
      }
      if (!this.trackerAgent) {
        try {
          this.trackerAgent = { url: proxy, agent: new ProxyAgent(proxy) };
        } catch {
          this.trackerAgent = null;
        }
      }
      if (this.trackerAgent) {
        opts.proxyOpts = {
          httpAgent: this.trackerAgent.agent,
          httpsAgent: this.trackerAgent.agent,
        };
      }
    } else if (this.trackerAgent) {
      // VPN выключен (proxy стал null) — прокси-агент больше не нужен: закрываем,
      // иначе он с открытыми сокетами утекал до конца процесса.
      try {
        void this.trackerAgent.agent.close();
      } catch {
        /* ignore */
      }
      this.trackerAgent = null;
    }
    (this.client as unknown as { tracker: unknown }).tracker = opts;
  }

  // Ручной анонс на HTTP(S)-трекеры через «рабочий» путь (HttpClient с VPN и
  // браузерным UA). Сам webtorrent до Cloudflare-трекеров не достукивается, а так мы
  // получаем список пиров и подкидываем их в торрент через addPeer.
  private async announceTrackers(t: Torrent): Promise<void> {
    if (typeof this.source.fetchTracker !== 'function') return;
    const announce = (t as unknown as { announce?: string[] }).announce ?? [];
    const httpTrackers = announce.filter((u) => /^https?:/i.test(u));
    if (httpTrackers.length === 0) return;
    const infoHash = Buffer.from(t.infoHash, 'hex');
    const port = Number((this.client as unknown as { torrentPort?: number }).torrentPort) || 0;
    const total = Number((t as unknown as { length?: number }).length) || 0;
    // left = сколько ещё осталось скачать (трекер по нему считает сидов/личеров).
    // Если размер ещё неизвестен (магнит без метаданных) — отдаём ненулевой маркер.
    const left = total > 0 ? Math.max(0, total - (t.downloaded || 0)) : 16384;
    const pct = (b: Buffer) => [...b].map((x) => '%' + x.toString(16).padStart(2, '0')).join('');
    for (const base of httpTrackers) {
      const params =
        `info_hash=${pct(infoHash)}&peer_id=${pct(this.peerId20)}&port=${port}` +
        `&uploaded=0&downloaded=0&left=${left}&compact=1&numwant=200&event=started`;
      const url = base + (base.includes('?') ? '&' : '?') + params;
      try {
        const body = await this.source.fetchTracker(url);
        if (!body) continue;
        const decoded = bencode.decode(body) as {
          'failure reason'?: Buffer;
          peers?: Buffer | Array<Record<string, unknown>>;
          peers6?: Buffer;
        };
        if (decoded['failure reason']) {
          log.warn(`[stream] tracker ${hostOf(base)}: ${decoded['failure reason'].toString()}`);
          continue;
        }
        const added = this.addCompactPeers(t, decoded.peers, decoded.peers6);
        log.info(`[stream] tracker ${hostOf(base)} -> ${added} peers`);
      } catch (e) {
        log.warn(`[stream] tracker ${hostOf(base)} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // Разбирает список пиров из ответа трекера (compact: 6 байт IPv4 / 18 байт IPv6)
  // и добавляет их в торрент. Возвращает число добавленных.
  private addCompactPeers(
    t: Torrent,
    peers?: Buffer | Array<Record<string, unknown>>,
    peers6?: Buffer,
  ): number {
    let n = 0;
    const tAdd = t as unknown as { addPeer(addr: string): void };
    const add = (addr: string): void => {
      try {
        tAdd.addPeer(addr);
        n++;
      } catch {
        /* ignore */
      }
    };
    if (Buffer.isBuffer(peers)) {
      for (let i = 0; i + 6 <= peers.length; i += 6) {
        add(
          `${peers[i]}.${peers[i + 1]}.${peers[i + 2]}.${peers[i + 3]}:${(peers[i + 4] << 8) | peers[i + 5]}`,
        );
      }
    } else if (Array.isArray(peers)) {
      for (const p of peers) {
        const ip = (p.ip as Buffer | undefined)?.toString?.() ?? '';
        const port = p.port as number;
        if (ip && port) add(`${ip}:${port}`);
      }
    }
    if (Buffer.isBuffer(peers6)) {
      for (let i = 0; i + 18 <= peers6.length; i += 18) {
        const parts: string[] = [];
        for (let j = 0; j < 16; j += 2) {
          parts.push(((peers6[i + j] << 8) | peers6[i + j + 1]).toString(16));
        }
        add(`[${parts.join(':')}]:${(peers6[i + 16] << 8) | peers6[i + 17]}`);
      }
    }
    return n;
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
          torrent = this.client.add(stripMagnetXs(torrentId), this.addOptions(skipVerify), (_t) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
              const list = (_t as unknown as { announce?: string[] }).announce ?? [];
              log.info(`[stream] topic ${topicId} trackers (${list.length}): ${list.join(', ')}`);
            } catch {
              /* ignore */
            }
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
          const cause = (w as { cause?: { message?: string; code?: string } } | undefined)?.cause;
          const base = typeof w === 'string' ? w : w instanceof Error ? w.message : String(w);
          const msg = cause ? `${base} [${cause.code ?? ''} ${cause.message ?? ''}]` : base;
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
      const dir = path.join(TORRENT_DIR, `${sanitizeTorrentName(parsed.name)} - ${parsed.infoHash.slice(0, 8)}`);
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
    const local = this.localSources.get(topicId);
    if (local) {
      // Локальная раздача: источник уже задан (magnet или путь к .torrent).
      if (local.torrentFile) {
        try {
          return await fs.promises.readFile(local.torrentFile);
        } catch {
          throw new Error('Локальный .torrent недоступен на диске.');
        }
      }
      if (local.magnet) return local.magnet;
      throw new Error('Локальный источник раздачи не настроен.');
    }

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
      store: SafeFSChunkStore,
      storeCacheSlots: 40,
      skipVerify,
      announce: EXTRA_TRACKERS,
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
      log.info(`[stream] evict topic ${victim.topicId} (over limit, store kept)`);
      victim.torrent.destroy({ destroyStore: false }, () => {});
    }
  }

  private sweepIdle() {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.torrent && now - entry.lastUsed > IDLE_TTL_MS) {
        this.entries.delete(id);
        this.playWindows.delete(id);
        log.info(`[stream] evict topic ${id} (idle, store kept)`);
        entry.torrent.destroy({ destroyStore: false }, () => {});
      }
    }
  }

  async getFile(topicId: number, fileIndex: number): Promise<{ torrent: Torrent; file: TorrentFile }> {
    const torrent = await this.load(topicId);
    if (torrent.destroyed) throw new Error('Торрент раздачи уничтожен. Повторите попытку.');
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

  // Регистрирует локальный источник раздачи (magnet или путь к .torrent на диске).
  // Для отрицательных topicId resolveTorrentId берёт его в приоритете и не ходит
  // на rutracker. Пустой spec (без magnet/torrentFile) — удаляет регистрацию.
  setLocalSource(topicId: number, spec: LocalSourceSpec | null): void {
    if (!spec || (!spec.magnet && !spec.torrentFile)) {
      this.localSources.delete(topicId);
      return;
    }
    this.localSources.set(topicId, spec);
  }

  // Имя загруженной раздачи (для magnet — после получения метаданных). null, если
  // раздача ещё не загружена или имени нет.
  torrentName(topicId: number): string | null {
    const t = this.entries.get(topicId)?.torrent;
    return t && !t.destroyed && t.name ? t.name : null;
  }

  // Раздача загружена и не на паузе (что-то качает/готово к чтению). Для watchdog'а:
  // останавливать только живую нагрузку и не трогать уже остановленные.
  isBusy(topicId: number): boolean {
    const entry = this.entries.get(topicId);
    const t = entry?.torrent;
    return !!t && !t.destroyed && !t.paused;
  }

  // Во время активного HLS-просмотра ограничиваем закачку торрента, чтобы он не
  // забивал HDD и не тормозил отдачу сегментов. `bytesPerSec <= 0` — снять лимит
  // (например, когда просмотра нет: кеш набирается на полной скорости).
  setDownloadRate(bytesPerSec: number): void {
    const rate = bytesPerSec > 0 ? Math.round(bytesPerSec) : -1;
    if (rate === this.currentLimit) return;
    this.currentLimit = rate;
    try {
      (this.client as unknown as { throttleDownload(rate: number): void }).throttleDownload(rate);
      log.info(`[stream] download limit -> ${rate < 0 ? 'unlimited' : `${Math.round(rate / 1048576)} MB/s`}`);
    } catch {
      /* ignore */
    }
  }

  // ДИАГНОСТИКА: сколько кусков помечено webtorrent как «критичные» (необратимо) и
  // сколько активных selections. Помогает ловить деградацию приоритетов после seek.
  criticalStats(topicId: number): { critical: number; total: number; selections: number } {
    const t = this.entries.get(topicId)?.torrent as
      | (Torrent & { _critical?: boolean[]; _selections?: { length: number } })
      | undefined;
    if (!t || t.destroyed) return { critical: 0, total: 0, selections: 0 };
    const c = t._critical;
    let cnt = 0;
    if (c) {
      for (let i = 0; i < c.length; i++) if (c[i]) cnt++;
    }
    return { critical: cnt, total: t.pieces.length, selections: t._selections?.length ?? 0 };
  }

  // Диагностика пиров: сколько соединений, их скорости, кто не отдаёт данные.
  // Нужна, чтобы понять, почему торрент качается медленно (мало пиров или медленные).
  wireStats(topicId: number): { wires: number; speeds: number[]; choking: number; noData: number } {
    const t = this.entries.get(topicId)?.torrent;
    if (!t || t.destroyed) return { wires: 0, speeds: [], choking: 0, noData: 0 };
    const wires = (t as unknown as { wires: Array<{ downloadSpeed(): number; peerChoking?: boolean; downloaded?: number }> }).wires ?? [];
    const speeds = wires
      .map((w) => Math.round(w.downloadSpeed()))
      .sort((a, b) => b - a)
      .slice(0, 8);
    const choking = wires.filter((w) => w.peerChoking).length;
    const noData = wires.filter((w) => (w.downloaded ?? 0) === 0).length;
    return { wires: wires.length, speeds, choking, noData };
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
      // Важно: обнуляем и «желаемые» диапазоны планировщика. Иначе любой следующий
      // load() (status/probe/warm/… ) делает resume()+commit() и заново выбирает
      // старые куски — торрент «сам» продолжал качать в фоне после закрытия плеера.
      sched?.clear();
      sched?.commit();
    } catch {
      /* ignore */
    }
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

    const len = end - start + 1;
    const stream =
      file.length > 0 && len > READ_WINDOW_BYTES
        ? this.windowedRead(file, start, end)
        : file.createReadStream({ start: opts.start, end: opts.end });
    return { torrent, file, stream };
  }

  // Последовательное чтение диапазона окнами по READ_WINDOW_BYTES. Каждое окно —
  // отдельный createReadStream (свой ограниченный stream-selection в webtorrent),
  // который закрывается по завершении окна и снимает свой диапазон. Так piece-picker
  // webtorrent работает с маленькими диапазонами и не сканирует весь остаток файла.
  private windowedRead(file: TorrentFile, start: number, end: number): Readable {
    async function* gen(): AsyncGenerator<Buffer> {
      let pos = start;
      while (pos <= end) {
        const winEnd = Math.min(end, pos + READ_WINDOW_BYTES - 1);
        const rs = file.createReadStream({ start: pos, end: winEnd }) as unknown as AsyncIterable<Buffer>;
        for await (const chunk of rs) yield chunk;
        pos = winEnd + 1;
      }
    }
    return Readable.from(gen());
  }

  private markCritical(
    torrent: Torrent,
    first: number,
    last: number,
    criticalBytes: number = CRITICAL_WINDOW_BYTES,
  ): void {
    if (torrent.destroyed) return;
    const span = Math.max(8, Math.ceil(criticalBytes / torrent.pieceLength));
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
    criticalBytes: number = CRITICAL_WINDOW_BYTES,
  ): Promise<void> {
    const { torrent, file } = await this.getFile(topicId, fileIndex);
    const { first, last } = pieceRange(file.offset, start, end, torrent.pieceLength);
    this.schedulerFor(topicId)?.raise(first, last, priority);
    this.schedulerFor(topicId)?.commit();
    this.markCritical(torrent, first, last, criticalBytes);
  }

  // Снимает поднятый приоритет диапазона (только для кусков, чей текущий приоритет
  // входит в `priorities`). Нужно, чтобы брошенный/завершённый временный диапазон
  // (превью, разовая докачка) не перебивал чтение фида транскода/плейбека вечно.
  async releasePrioritizedRange(
    topicId: number,
    fileIndex: number,
    start: number,
    end: number,
    priorities: number[] = [Priority.SEEK],
  ): Promise<void> {
    // НЕ дёргаем load()/getFile(): release вызывается в т.ч. из стоп-путей, где
    // перезагрузка торрента недопустима. Если раздача не загружена — нечего снимать.
    const torrent = this.entries.get(topicId)?.torrent;
    if (!torrent || torrent.destroyed) return;
    const file = torrent.files[fileIndex];
    if (!file || file.length <= 0) return;
    const scheduler = this.schedulerFor(topicId);
    if (!scheduler) return;
    const clampedEnd = Math.min(end, file.length - 1);
    if (clampedEnd < start) return;
    const { first, last } = pieceRange(file.offset, start, clampedEnd, torrent.pieceLength);
    scheduler.releaseAt(first, last, priorities);
    scheduler.commit();
  }

  // Приоритетно качает «хвост» файла, где обычно лежит seek-индекс (MKV Cues,
  // MP4 moov, AVI idx1). Без него ffmpeg при -ss делает полный проход всего файла.
  async prioritizeTail(topicId: number, fileIndex: number, bytes = 4 * 1024 * 1024): Promise<void> {
    const { file } = await this.getFile(topicId, fileIndex);
    if (file.length <= 0) return;
    const tailStart = Math.max(0, file.length - bytes);
    await this.prioritizeRange(topicId, fileIndex, tailStart, file.length - 1, Priority.SEEK);
  }

  // Помечает диапазон байт приоритетным и ждёт, пока его куски реально скачаются
  // (с таймаутом). Нужно, чтобы ffmpeg не блокировался на нескачанных данных.
  async waitForBytes(
    topicId: number,
    fileIndex: number,
    start: number,
    end: number,
    timeoutMs = 20_000,
    criticalBytes: number = CRITICAL_WINDOW_BYTES,
    releaseOnTimeout = true,
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
    this.markCritical(torrent, first, last, criticalBytes);
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
    const received = allReceived();
    // Не оставляем «повисший» SEEK: брошенный диапазон иначе навсегда перебивает
    // чтение фида (копившиеся таймауты превью и были причиной стопора транскода).
    if (!received && releaseOnTimeout && scheduler && !torrent.destroyed) {
      scheduler.releaseAt(first, last, [Priority.SEEK]);
      scheduler.commit();
    }
    return received;
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
        // Снимаем поднятый приоритет и на успехе: иначе desired растёт монотонно и
        // прочитанные (напр. под субтитры) куски залипают выбранными навсегда.
        scheduler?.releaseAt(first, last, [priority]);
        scheduler?.commit();
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
    const neg = this.probeNegative.get(key);
    if (neg) {
      if (Date.now() < neg.until) return neg.media;
      this.probeNegative.delete(key);
    }
    const inflight = this.probeInflight.get(key);
    if (inflight) return inflight;
    const p = this.probeInternal(key, topicId, fileIndex).finally(() => {
      if (this.probeInflight.get(key) === p) this.probeInflight.delete(key);
    });
    this.probeInflight.set(key, p);
    return p;
  }

  private async probeInternal(key: string, topicId: number, fileIndex: number): Promise<MediaInfo> {
    const { torrent, file } = await this.getFile(topicId, fileIndex);
    const ext = extOf(file.name);
    const limit = Math.min(file.length, PROBE_BYTES);

    // Приоритизируем голову и коротко ждём её байты: без этого на слабом сваме
    // ffprobe не успевает прочитать заголовок за таймаут, длительность теряется —
    // и на таймлайне не видно полной длины файла.
    try {
      const sched = this.schedulerFor(topicId);
      const { first, last } = pieceRange(file.offset, 0, Math.max(0, limit - 1), torrent.pieceLength);
      sched?.raise(first, last, Priority.SEEK);
      sched?.commit();
      await this.waitForBytes(topicId, fileIndex, 0, limit - 1, 12_000, CRITICAL_WINDOW_BYTES, false);
    } catch {
      /* ignore */
    }

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const stream = file.createReadStream({ start: 0, end: limit - 1 });
      try {
        const stopTimer = perf.timer('stream.probe.ms');
        const json = await runFfprobe(stream, PROBE_TIMEOUT_MS);
        stopTimer();
        const media = mapProbe(json, ext);
        this.probeCache.set(key, media);
        return media;
      } catch (e) {
        lastErr = e;
      } finally {
        try {
          stream.destroy();
        } catch {
          /* ignore */
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    log.warn(`[stream] ffprobe failed for ${file.name}: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
    const fallback: MediaInfo = {
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
    this.probeNegative.set(key, { media: fallback, until: Date.now() + PROBE_NEGATIVE_TTL_MS });
    return fallback;
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
    this.probeNegative.clear();
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

  // Удаляет одну раздачу с диска (destroyStore) и чистит её кеши в памяти +
  // регистрацию локального источника. Используется при ручном удалении/вытеснении
  // локальной раздачи из истории (её источник больше не нужен).
  async destroyTopic(topicId: number): Promise<void> {
    const entry = this.entries.get(topicId);
    const t = entry?.torrent;
    const pending = entry?.pending;
    this.entries.delete(topicId);
    this.playWindows.delete(topicId);
    this.localSources.delete(topicId);
    for (const key of [...this.probeCache.keys()]) {
      if (key.startsWith(`${topicId}:`)) this.probeCache.delete(key);
    }
    for (const key of [...this.probeNegative.keys()]) {
      if (key.startsWith(`${topicId}:`)) this.probeNegative.delete(key);
    }
    if (pending && !t) {
      // Метаданные ещё грузятся: когда загрузка завершится, раздача уже удалена —
      // уничтожаем её, чтобы не оставить «осиротевший» торрент в клиенте.
      void pending
        .then((torrent) => {
          if (torrent && !torrent.destroyed) {
            torrent.destroy({ destroyStore: true }, () => {});
          }
        })
        .catch(() => {});
    }
    if (t && !t.destroyed) {
      await new Promise<void>((res) => t.destroy({ destroyStore: true }, () => res()));
    }
    log.info(`[stream] destroy topic ${topicId} (store removed)`);
  }

  async destroy(): Promise<void> {
    clearInterval(this.idleTimer);
    clearInterval(this.dhtSaveTimer);
    this.saveDhtNodes();
    for (const [, entry] of this.entries) {
      if (entry.torrent && !entry.torrent.destroyed) {
        await new Promise<void>((res) => entry.torrent?.destroy(() => res()));
      }
    }
    this.entries.clear();
    this.probeCache.clear();
    this.probeNegative.clear();
    if (this.trackerAgent) {
      try {
        void this.trackerAgent.agent.close();
      } catch {
        /* ignore */
      }
      this.trackerAgent = null;
    }
    // Уже уничтожённый клиент не вызывает колбэк → не ждём вечно (зависание shutdown).
    if (!(this.client as unknown as { destroyed?: boolean }).destroyed) {
      try {
        await new Promise<void>((res) => this.client.destroy(() => res()));
      } catch {
        /* клиент уничтожен параллельно */
      }
    }
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
