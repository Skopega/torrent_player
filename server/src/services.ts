import { HttpClient, BASE_URL, encodeCp1251 } from './http.js';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { Images } from './images.js';
import { BrowserManager } from './browser.js';
import { StreamManager } from './stream.js';
import { HlsManager } from './hls.js';
import { SubtitleManager } from './subs.js';
import { ThumbnailManager, THUMB_PARALLEL_SEC } from './thumbnails.js';
import { encoderLabel } from './encoder.js';
import { parseSearch, parseTopic } from './rutracker.js';
import { VpnManager } from './vpn/manager.js';
import { log } from './logger.js';
import { perf } from './perf.js';
import { LocalLibrary, type LocalMeta } from './local.js';
import { formatBytes, type SearchResult, type Topic } from './types.js';
import type { HistoryEntry } from './store.js';

function isCfChallenge(html: string): boolean {
  const head = html.slice(0, 30000);
  return /challenge-platform|cf-chl|cf_chl|Just a moment|Checking your browser|Проверка безопасности|cf-browser-verification/i.test(
    head,
  );
}

// Метаданные (постеры/битрейты/разрешения) при старте чистим только если их кеш
// вырос выше этого порога; видео-кеши (торренты/HLS/превью) чистим всегда.
const MAX_METADATA_CACHE_BYTES = 1024 * 1024 * 1024;
// Свежесть топика в памяти: сиды/постер/размер на rutracker меняются — не держим
// вечно устаревший кеш, по истечении TTL перечитываем с сайта.
const TOPIC_TTL_MS = 15 * 60 * 1000;

// Watchdog заброшенных раздач: если закрыли вкладку/браузер, сервер не получает
// стоп-сигнал и продолжал бы транскодить/качать весь фильм до конца. Сторож
// останавливает топик, от которого давно не было клиентских запросов.
const WATCHDOG_INTERVAL_MS = 10_000;
// Нет запросов от браузера дольше этого времени → топик считается брошенным.
// Не меньше ~60 с: браузер троттлит таймеры скрытой вкладки до ~1/мин, иначе
// открытая вкладка с паузой/мьютом в фоне получила бы ложный останов.
const ABANDON_TIMEOUT_MS = 90_000;

const PORT = 3000;

// Занят ли TCP-порт другим процессом (для защиты видео-кеша при двойном старте).
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.listen(port, '0.0.0.0', () => {
      probe.close(() => resolve(false));
    });
  });
}

// Фильтр разделов, в которых ищем раздачи (только эти форумы).
const SEARCH_FORUMS =
  '100,101,104,106,110,1102,1105,1106,1120,1144,1171,119,121,1213,1214,1235,124,1242,1247,1248,1277,1288,1301,1359,1389,1390,1391,140,1408,1417,1449,1457,1459,1460,1463,1493,1498,1531,1535,1537,1539,1543,1574,1576,1577,1642,166,1666,1669,1670,1690,173,175,1803,181,184,185,187,188,189,1900,193,1939,194,1940,1949,195,1950,208,209,2090,2091,2092,2093,2097,2100,2109,212,2183,2198,2199,22,2200,2201,2220,2221,2258,2339,2343,235,2365,2366,2370,2393,2396,2398,2404,2405,242,2459,2491,252,2540,2544,265,266,271,272,273,312,313,325,33,352,372,376,387,4,404,484,489,498,504,505,507,511,514,521,534,536,539,549,572,594,599,607,625,694,7,704,709,717,718,721,775,781,79,80,81,812,815,816,819,820,822,825,84,842,877,9,905,91,911,915,920,921,93,930,934,941,990';

export class Services {
  readonly vpn = new VpnManager();
  readonly browser = new BrowserManager(this.vpn);
  readonly http = new HttpClient(this.vpn);
  readonly store = new Store();
  readonly local = new LocalLibrary();
  readonly auth = new Auth(this.store, this.browser);
  readonly images = new Images(this.http, this.store);
  readonly stream = new StreamManager({
    getTorrentBuffer: (id) => this.downloadTorrent(id),
    getMagnet: async (id) => (await this.getTopic(id)).magnet,
  });
  readonly subs = new SubtitleManager(this.stream);
  readonly hls = new HlsManager(this.stream, this.subs);
  readonly thumbnails = new ThumbnailManager(
    this.stream,
    // Превью генерируются параллельно, только когда транскод опережает playhead
    // минимум на THUMB_PARALLEL_SEC — иначе приоритет у плавности/перемотки.
    (id, fileIndex) => {
      const ahead = this.hls.transcodeAheadSec(id, fileIndex);
      if (ahead == null) return null; // транскода нет (direct play) — можно
      if (ahead < THUMB_PARALLEL_SEC) {
        return `transcode ahead ${ahead.toFixed(0)}s < ${THUMB_PARALLEL_SEC}s`;
      }
      return null;
    },
    // Точный байт для seek по MKV Cues (как в HLS): превью сикают чанками и
    // приоритизируют реальный кластер, а не оценку frac*size.
    (id, fileIndex, sec) => this.subs.seekByteFor(id, fileIndex, sec),
    // Окна уже перекодированных HLS-сегментов: превью из них извлекаются без
    // повторного чтения исходника (бесплатно и без правила паузы).
    (id, fileIndex) => this.hls.transcodeWindows(id, fileIndex),
  );

  private topicCache = this.store.loadTopics();
  private topicTimes = new Map<number, number>();
  private lastCookieSync = 0;
  private monitorTimer: NodeJS.Timeout;
  private watchdogTimer: NodeJS.Timeout;
  // Последний момент, когда клиент обращался к раздаче (для watchdog'а).
  private clientSeen = new Map<number, number>();
  // Последний файл, для которого уже сделан per-file prune (дедупликация вызовов
  // из direct-play маршрута, который ходит по несколько раз на каждый range-запрос).
  private lastPrunedFile: string | null = null;

  constructor() {
    // Темы, поднятые с диска, считаем свежими (кроме того, TTL всё равно обновит).
    for (const id of this.topicCache.keys()) this.topicTimes.set(id, Date.now());
    // Реестр локальных источников приводим в соответствие с историей: источник
    // живёт, только пока есть запись истории (чистим «осиротевшие» после краша
    // между регистрацией и первым просмотром), остальные регистрируем в стриме.
    this.syncLocalSourcesAtStartup();
    // Периодический снимок производительности в лог: метрики этапов + статус
    // закачки/транскода/превью, чтобы анализировать причины фризов постфактум.
    this.monitorTimer = setInterval(() => void this.logPerfSnapshot(), 10_000);
    this.monitorTimer.unref();
    // Закрыли вкладку/браузер — стоп-сигнал не приходит, поэтому периодически
    // гасим раздачи без свежих клиентских запросов (ffmpeg/превью/закачка).
    this.watchdogTimer = setInterval(() => void this.sweepAbandoned(), WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref();
    // Заранее определяем аппаратный кодер (NVENC/QSV), чтобы первый HLS-старт
    // не задерживался на пробе.
    void encoderLabel().then((label) => log.info(`[hls] hardware encoder: ${label}`));
  }

  // --- Локальные magnet/.torrent раздачи --------------------------------------

  // Приводит реестр локальных источников в соответствие с записями истории и
  // регистрирует выжившие источники в StreamManager (для отрицательных topicId
  // они используются до обращения к rutracker).
  private syncLocalSourcesAtStartup(): void {
    const historyLocalIds = this.store
      .getHistory()
      .filter((e) => e.kind === 'local')
      .map((e) => e.id);
    const removed = this.local.sweep(historyLocalIds);
    if (removed.length > 0) {
      log.info(`[local] swept ${removed.length} orphan local source(s)`);
    }
    for (const meta of this.local.list()) this.registerLocalSource(meta);
  }

  private registerLocalSource(meta: LocalMeta): void {
    if (meta.kind === 'magnet') {
      this.stream.setLocalSource(meta.id, { magnet: meta.magnet });
    } else {
      const p = this.local.sourceTorrentPath(meta.id);
      if (p) this.stream.setLocalSource(meta.id, { torrentFile: p });
    }
  }

  // Добавление записи истории через обёртку: локальные источники, вытесненные
  // за общий кап, удаляются с диска (запись пропала — источник больше не нужен).
  historyAdd(entry: HistoryEntry): HistoryEntry[] {
    const before = new Set(this.store.getHistory().map((e) => e.id));
    const after = this.store.addHistory(entry);
    const now = new Set(after.map((e) => e.id));
    for (const id of before) {
      if (!now.has(id) && this.local.getByTopicId(id)) {
        void this.purgeLocal(id).catch((e) => {
          log.warn(`[local] purge evicted ${id} failed: ${e instanceof Error ? e.message : e}`);
        });
      }
    }
    return after;
  }

  // Ручное удаление записи из истории (крестик): для локальных раздач чистим
  // источник целиком (стоп потока + видео-кеш + data/local).
  async removeHistoryEntry(id: number): Promise<HistoryEntry[]> {
    if (this.local.getByTopicId(id)) {
      await this.purgeLocal(id);
    }
    return this.store.removeHistory(id);
  }

  // Полная очистка локальной раздачи: стоп, удаление видео-кеша (HLS/превью/куски),
  // снятие локального источника и удаление персистентного хранилища.
  async purgeLocal(id: number): Promise<void> {
    try {
      await this.stopStream(id);
    } catch {
      /* ignore */
    }
    try {
      this.hls.removeCacheExcept(id, null);
    } catch {
      /* ignore */
    }
    try {
      this.thumbnails.removeCacheExcept(id, null);
    } catch {
      /* ignore */
    }
    await this.stream.destroyTopic(id);
    this.local.remove(id);
    log.info(`[local] purged topic ${id} (source removed)`);
  }

  // Возвращает локальную мету или null (для не-локальных id).
  localMeta(id: number): LocalMeta | null {
    return this.local.getByTopicId(id);
  }

  // Баннер локальной раздачи: файл есть — true, иначе false.
  hasLocalBanner(id: number): boolean {
    return this.localMeta(id)?.hasBanner === true;
  }

  // Регистрирует magnet-ссылку как локальную раздачу. absId выбирается так, чтобы
  // не совпасть с уже существующими записями истории (защита от «наследования»
  // настроек/резюме чужой раздачи при потере/сбросе реестра data/local).
  async addLocalMagnet(magnet: string): Promise<LocalMeta> {
    const meta = await this.local.addMagnet(magnet, undefined, this.nextLocalAbsId());
    this.registerLocalSource(meta);
    return meta;
  }

  // Регистрирует .torrent (байты) как локальную раздачу.
  async addLocalTorrent(buf: Buffer): Promise<LocalMeta> {
    const meta = await this.local.addTorrent(buf, undefined, this.nextLocalAbsId());
    this.registerLocalSource(meta);
    return meta;
  }

  // Минимальный свободный absId: больше всех занятых в реестре И в записях истории
  // (local-записи могут остаться после потери data/local/index.json).
  private nextLocalAbsId(): number {
    let max = 0;
    for (const m of this.local.list()) max = Math.max(max, m.absId);
    for (const e of this.store.getHistory()) {
      if (e.kind === 'local' && e.id < 0) max = Math.max(max, -e.id);
    }
    return max + 1;
  }

  // Переименование локальной раздачи: обновляет реестр и title в истории.
  renameLocal(id: number, name: string): LocalMeta | null {
    const meta = this.local.rename(id, name);
    if (meta) this.store.updateHistory(id, { title: meta.name });
    return meta;
  }

  // «Страницу закрыли»: если запись истории так и не создана (не начали смотреть) —
  // источник удаляем. Возвращает true, если источник был удалён.
  async closeLocal(id: number): Promise<boolean> {
    const inHistory = this.store.getHistory().some((e) => e.id === id);
    if (inHistory) return false;
    if (!this.local.getByTopicId(id)) return false;
    await this.purgeLocal(id);
    return true;
  }

  // Старт просмотра локальной раздачи: создаёт/обновляет запись истории и в фоне
  // запускает генерацию баннера (если его ещё нет).
  async watchLocal(
    id: number,
    opts: { name?: string; fileIndex?: number | null },
  ): Promise<HistoryEntry[]> {
    const meta = this.local.getByTopicId(id);
    if (!meta) throw new Error('Локальная раздача не найдена.');

    let sizeHuman = '';
    let resolution: string | null = null;
    let durationSec: number | null = null;
    try {
      const files = await this.stream.files(id);
      let total = 0;
      for (const f of files) {
        if (f.isVideo) total += f.length;
      }
      sizeHuman = formatBytes(total);
    } catch {
      /* торрент ещё не готов — размер оставим пустым */
    }
    // Авто-имя: введённое пользователем → сохранённое → настоящее имя раздачи
    // (для magnet приходит после получения метаданных).
    const torrentName = this.stream.torrentName(id);
    const typed = typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim() : null;
    const name = typed ?? (meta.name || torrentName || '');
    if (name !== meta.name) {
      this.local.rename(id, name);
      meta.name = name;
    }
    if (opts.fileIndex != null && Number.isFinite(opts.fileIndex)) {
      try {
        const m = await this.stream.probe(id, opts.fileIndex);
        durationSec = m.durationSec;
        const w = m.width ?? 0;
        const h = m.height ?? 0;
        if (w > 0 && h > 0) {
          if (w >= 3200 || h >= 2000) resolution = '4K';
          else if (w >= 2500 || h >= 1400) resolution = '1440p';
          else if (w >= 1900 || h >= 1000) resolution = '1080p';
          else if (w >= 1152 || h >= 700) resolution = '720p';
          else if (w >= 700 || h >= 470) resolution = '480p';
          else resolution = 'SD';
        }
      } catch {
        /* probe может не успеть — разрешение/длительность пропустим */
      }
    }

    const entry: HistoryEntry = {
      id,
      title: name || `Раздача ${Math.abs(id)}`,
      category: 'Локальный торрент',
      poster: meta.hasBanner ? `/api/local/${id}/banner` : null,
      sizeHuman,
      seeds: 0,
      leech: 0,
      resolution,
      bitrate: null,
      duration:
        durationSec != null && durationSec > 0
          ? `${Math.floor(durationSec / 60)}:${String(Math.floor(durationSec % 60)).padStart(2, '0')}`
          : null,
      date: new Date().toISOString().slice(0, 10),
      kind: 'local',
    };
    const history = this.historyAdd(entry);

    if (opts.fileIndex != null && Number.isFinite(opts.fileIndex)) {
      const fi = opts.fileIndex as number;
      if (!this.local.getByTopicId(id)?.hasBanner) {
        void this.generateLocalBanner(id, fi).catch((e) => {
          log.warn(`[local] banner for ${id} failed: ${e instanceof Error ? e.message : e}`);
        });
      }
    }
    return history;
  }

  // Генерирует баннер локальной раздачи из случайного кадра средней полосы
  // таймлайна (первые/последние 10% отбрасываются). Лучший-effort: если кадров
  // ещё нет — оставляем без баннера (следующий watch попробует снова).
  private async generateLocalBanner(id: number, fileIndex: number): Promise<void> {
    const frame = await this.thumbnails.bannerFrame(id, fileIndex);
    if (!frame) return;
    const dest = this.local.bannerPath(id);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(frame, dest);
      this.local.setBanner(id, true);
      this.store.updateHistory(id, { poster: `/api/local/${id}/banner` });
      log.info(`[local] banner set for topic ${id} (file ${fileIndex})`);
    } catch (e) {
      log.warn(`[local] banner copy for ${id} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async logPerfSnapshot(): Promise<void> {
    const topics = this.stream.topicIds();
    const metrics = perf.snapshot();
    const hasMetrics = Object.keys(metrics).some((k) => metrics[k].count > 0);
    if (topics.length === 0 && !hasMetrics) return;

    const parts: string[] = [];

    if (topics.length > 0) {
      const topicParts: string[] = [];
      for (const id of topics) {
        try {
          const s = await this.stream.status(id);
          const dl = (s.downloadSpeed / 1024).toFixed(0);
          const prog = (s.file?.progress ?? s.progress ?? 0).toFixed(2);
          topicParts.push(
            `${id}(dl=${dl}KB/s peers=${s.numPeers} prog=${prog}${s.paused ? ' paused' : ''})`,
          );
        } catch {
          /* ignore */
        }
      }
      if (topicParts.length) parts.push(`topics=[${topicParts.join(' ')}]`);
    }

    const hls = this.hls.snapshot();
    if (hls.length) {
      parts.push(
        `hls=[${hls
          .map(
            (h) =>
              `${h.topicId}:${h.fileIndex} ${h.state} ${h.startSec}->${h.endSec.toFixed(0)}s (${h.speedMul}x)`,
          )
          .join(' ')}]`,
      );
    }

    const thumbs = this.thumbnails.jobsSnapshot();
    if (thumbs.length) {
      parts.push(
        `thumbs=[${thumbs.map((t) => `${t.topicId}:${t.fileIndex} cov=${t.coverage}${t.running ? ' run' : ' queued'}`).join(' ')}]`,
      );
    }

    const slowest = Object.entries(metrics)
      .filter(([, m]) => m.count > 0)
      .sort((a, b) => b[1].avgMs - a[1].avgMs)
      .slice(0, 6)
      .map(
        ([name, m]) =>
          `${name} n=${m.count} avg=${m.avgMs.toFixed(0)} p95=${m.p95Ms.toFixed(0)}`,
      );
    if (slowest.length) parts.push(`slowest=[${slowest.join(' | ')}]`);

    const enc = await encoderLabel().catch(() => 'libx264');
    parts.push(`encoder=${enc}`);

    log.info(`[perf] ${parts.join(' ')}`);
  }

  private async syncCookies(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCookieSync < 5000) return;
    this.lastCookieSync = now;
    let cookies: string[] | null = null;
    try {
      if (this.browser.isReady()) cookies = await this.browser.getCookies();
    } catch {
      /* ignore */
    }
    if (!cookies || cookies.length === 0) {
      cookies = this.store.getSession()?.cookies ?? [];
    }
    this.http.setCookies(cookies);
  }

  async image(url: string): Promise<{ data: Buffer; contentType: string }> {
    await this.syncCookies();
    return this.images.fetch(url);
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const loggedIn = await this.auth.ensureLoggedIn();
    if (!loggedIn) throw new Error('NOT_LOGGED_IN');
    await this.syncCookies();

    // f — разделы, o=10 — сиды, s=2 — по убыванию (сначала лучшие раздачи)
    const url = `${BASE_URL}tracker.php?f=${SEARCH_FORUMS}&nm=${encodeCp1251(query)}&o=10&s=2`;
    log.info(`[services] search "${query}" (sort by seeds, filtered forums)`);
    const html = await this.browser.fetchHtml(url, signal, 'tr.hl-tr');

    const results = parseSearch(html);
    for (const r of results) {
      const cached = this.store.getPoster(r.id);
      if (cached) r.poster = cached;
    }
    log.info(`[services] search "${query}" -> ${results.length} results`);
    return results;
  }

  private async fetchTopicHtmlHttp(id: number): Promise<string> {
    const url = `${BASE_URL}viewtopic.php?t=${id}`;
    const res = await this.http.request(url);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    if (isCfChallenge(res.text)) throw new Error('CF_CHALLENGE');
    return res.text;
  }

  async getTopic(id: number, persistPoster = true): Promise<Topic> {
    const cached = this.topicCache.get(id);
    const at = this.topicTimes.get(id) ?? 0;
    if (cached && Date.now() - at < TOPIC_TTL_MS) return cached;
    if (cached) {
      // Устарел — даём перечитать с сайта (сиды/постер могли измениться).
      this.topicCache.delete(id);
      this.topicTimes.delete(id);
    }

    await this.auth.ensureLoggedIn();
    await this.syncCookies();

    let html: string;
    try {
      html = await this.fetchTopicHtmlHttp(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`[services] topic ${id}: HTTP failed (${msg}), fallback to browser`);
      html = await this.browser.fetchHtml(
        `${BASE_URL}viewtopic.php?t=${id}`,
        undefined,
        'div.post_body',
      );
    }

    const topic = parseTopic(html, id);
    if (persistPoster) {
      if (topic.poster) this.store.setPosters({ [String(id)]: topic.poster });
      if (topic.bitrate) this.store.setBitrates({ [String(id)]: topic.bitrate });
      if (topic.resolution) this.store.setResolutions({ [String(id)]: topic.resolution });
    }
    this.topicCache.set(id, topic);
    this.topicTimes.set(id, Date.now());
    this.store.saveTopic(id, topic);
    return topic;
  }

  async downloadTorrent(id: number): Promise<Buffer> {
    await this.auth.ensureLoggedIn();
    return this.browser.downloadFile(`${BASE_URL}dl.php?t=${id}`);
  }

  // Останавливает все раздачи, кроме выбранной (при открытии нового плеера),
  // и удаляет кеш всех остальных видео (торренты, HLS, превью).
  async activateStream(topicId: number): Promise<void> {
    for (const id of this.stream.topicIds()) {
      if (id !== topicId) {
        this.hls.stopTopic(id);
        this.subs.stopTopic(id);
        this.thumbnails.stopTopic(id);
        this.stream.stop(id);
      }
    }
    await this.pruneOtherVideos(topicId);
  }

  // Удаляет кеш всех видео, кроме указанного топика: HLS-сегменты, превью и
  // скачанные куски торрентов (destroyStore). Кеш указанного топика не трогается —
  // повторный вход на то же видео остаётся мгновенным.
  private async pruneOtherVideos(topicId: number): Promise<void> {
    try {
      await this.hls.removeCacheExcept(topicId, null);
      this.thumbnails.removeCacheExcept(topicId, null);
      await this.stream.destroyOthers(topicId);
      log.info(`[cache] pruned other videos (keep topic ${topicId})`);
    } catch (e) {
      log.warn(`[cache] prune other videos failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Per-file prune: удаляет HLS-сегменты и превью других файлов (серий) этого
  // топика. Вызывается из direct-play маршрута, когда на смену серии не приходит
  // новый HLS-start (который сам вызывает removeCacheExcept). Дедупликация по файлу.
  pruneFileCache(topicId: number, fileIndex: number): void {
    const key = `${topicId}:${fileIndex}`;
    if (this.lastPrunedFile === key) return;
    this.lastPrunedFile = key;
    void Promise.allSettled([
      this.hls.removeCacheExcept(topicId, fileIndex),
      Promise.resolve(this.thumbnails.removeCacheExcept(topicId, fileIndex)),
    ]);
  }

  // Фоновый прогрев при открытии раздачи: грузит торрент и тянет голову+хвост,
  // чтобы первый probe и перемотка были быстрыми. Не останавливает текущий плейбек.
  async warmStream(topicId: number): Promise<void> {
    await this.stream.warm(topicId);
  }

  // Клиент (браузер) обратился к раздаче — отмечаем живость для watchdog'а.
  noteClientActivity(topicId: number): void {
    this.clientSeen.set(topicId, Date.now());
  }

  // Останавливает раздачи, от которых давно не было клиентских запросов: убивает
  // ffmpeg/превью и паузит торрент (кеш сегментов/кусков сохраняется — быстрый
  // возврат к тому же видео). Внутренние запросы ffmpeg-feed (?feed=1) живость
  // не обновляют, иначе транскод «оживлял» бы сам себя.
  private async sweepAbandoned(): Promise<void> {
    const now = Date.now();
    const live = new Set(this.stream.topicIds());
    // Записи о топиках, которых уже нет в памяти (остановлены/удалены иначе, чем
    // через stopStream), выбрасываем, чтобы карта не росла бесконечно.
    for (const id of [...this.clientSeen.keys()]) {
      if (!live.has(id)) this.clientSeen.delete(id);
    }
    for (const id of live) {
      const lastSeen = this.clientSeen.get(id) ?? 0;
      if (now - lastSeen < ABANDON_TIMEOUT_MS) continue;
      // Гасим только «живую» нагрузку: уже остановленные топики не трогаем, чтобы
      // не логировать повторные стопы каждые 10 с.
      const busy = this.hls.hasActiveTopic(id) || this.stream.isBusy(id);
      if (!busy) continue;
      log.info(
        `[watchdog] topic ${id} idle ${Math.round((now - lastSeen) / 1000)}s > ${ABANDON_TIMEOUT_MS / 1000}s — stopping (cache kept)`,
      );
      try {
        await this.stopStream(id);
      } catch (e) {
        log.warn(`[watchdog] stop topic ${id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  async stopStream(topicId: number): Promise<void> {
    this.clientSeen.delete(topicId);
    this.hls.stopTopic(topicId);
    this.subs.stopTopic(topicId);
    this.thumbnails.stopTopic(topicId);
    this.stream.stop(topicId);
  }

  async clearCache(): Promise<void> {
    await this.hls.stopAll();
    this.subs.stopAll();
    this.thumbnails.stopAll();
    await this.stream.clearAll();
    this.topicCache.clear();
    this.topicTimes.clear();
    this.store.clearCache();
  }

  // Очистка только видео-кешей (торренты, HLS, превью); метаданные сохраняются.
  async clearVideoCache(): Promise<void> {
    await this.hls.stopAll();
    this.subs.stopAll();
    this.thumbnails.stopAll();
    await this.stream.clearAll();
    this.store.clearVideoCache();
  }

  // Очистка при старте сервера: видео-кеши (торренты/HLS/превью) удаляем всегда;
  // метаданные (постеры/битрейты/разрешения) — только если их кеш вырос выше порога.
  // Если порт 3000 уже занят (работает другой инстанс — например, панель-супервизор
  // только что подняла нас повторно) — видео-кеш не трогаем: он может принадлежать
  // живому серверу, который в этот момент стримит.
  async cleanupAtStartup(): Promise<void> {
    const metaBytes = await this.store.metadataCacheSizeAsync();
    if (metaBytes > MAX_METADATA_CACHE_BYTES) {
      this.store.clearCache();
      this.topicCache.clear();
    this.topicTimes.clear();
      log.info(
        `[cache] startup: metadata cache ${(metaBytes / 1024 / 1024).toFixed(0)} MB > 1 GB — full clear`,
      );
    } else if (await isPortInUse(PORT)) {
      log.info(
        `[cache] startup: port ${PORT} in use by another instance — video cache left intact`,
      );
    } else {
      this.store.clearVideoCache();
      log.info(
        `[cache] startup: video cache cleared, metadata kept (${(metaBytes / 1024 / 1024).toFixed(1)} MB)`,
      );
    }
  }

  async enrich(
    ids: number[],
  ): Promise<Record<string, { poster?: string; bitrate?: string; resolution?: string; duration?: string }>> {
    const out: Record<string, { poster?: string; bitrate?: string; resolution?: string; duration?: string }> =
      {};
    // Локальные (отрицательные id) не обогащаются: источник — не rutracker.
    ids = ids.filter((id) => id > 0);
    const todo = ids.filter(
      (id) =>
        !this.store.getPoster(id) ||
        !this.store.getBitrate(id) ||
        !this.store.getResolution(id) ||
        !this.store.hasDuration(id),
    );

    await this.auth.ensureLoggedIn();
    await this.syncCookies();

    const concurrency = 5;
    let cursor = 0;
    const durationsChecked: Record<string, string> = {};
    const workers = Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
      while (cursor < todo.length) {
        const id = todo[cursor++];
        try {
          const topic = await this.getTopic(id, false);
          const entry: { poster?: string; bitrate?: string; resolution?: string; duration?: string } =
            {};
          if (topic.poster) entry.poster = topic.poster;
          if (topic.bitrate) entry.bitrate = topic.bitrate;
          if (topic.resolution) entry.resolution = topic.resolution;
          if (topic.duration) entry.duration = topic.duration;
          if (entry.poster || entry.bitrate || entry.resolution || entry.duration)
            out[String(id)] = entry;
          durationsChecked[String(id)] = topic.duration ?? '';
        } catch {
          /* skip */
        }
      }
    });
    await Promise.all(workers);

    const postersFound: Record<string, string> = {};
    const bitratesFound: Record<string, string> = {};
    const resolutionsFound: Record<string, string> = {};
    for (const [id, entry] of Object.entries(out)) {
      if (entry.poster) postersFound[id] = entry.poster;
      if (entry.bitrate) bitratesFound[id] = entry.bitrate;
      if (entry.resolution) resolutionsFound[id] = entry.resolution;
    }
    if (Object.keys(postersFound).length > 0) this.store.setPosters(postersFound);
    if (Object.keys(bitratesFound).length > 0) this.store.setBitrates(bitratesFound);
    if (Object.keys(resolutionsFound).length > 0) this.store.setResolutions(resolutionsFound);
    if (Object.keys(durationsChecked).length > 0)
      this.store.setDurations(durationsChecked);

    for (const id of ids) {
      const cached = this.store.getPoster(id);
      if (cached && !out[String(id)]?.poster) {
        out[String(id)] = { ...out[String(id)], poster: cached };
      }
      const cachedBitrate = this.store.getBitrate(id);
      if (cachedBitrate && !out[String(id)]?.bitrate) {
        out[String(id)] = { ...out[String(id)], bitrate: cachedBitrate };
      }
      const cachedResolution = this.store.getResolution(id);
      if (cachedResolution && !out[String(id)]?.resolution) {
        out[String(id)] = { ...out[String(id)], resolution: cachedResolution };
      }
      const cachedDuration = this.store.getDuration(id);
      if (cachedDuration && !out[String(id)]?.duration) {
        out[String(id)] = { ...out[String(id)], duration: cachedDuration };
      }
    }
    return out;
  }

  async close(): Promise<void> {
    clearInterval(this.monitorTimer);
    clearInterval(this.watchdogTimer);
    await this.hls.stopAll();
    this.subs.stopAll();
    this.thumbnails.stopAll();
    await this.stream.destroy();
    await this.vpn.close();
    await this.browser.close();
  }
}
