import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { DATA_DIR, rmDirRobust } from './store.js';
import { FFMPEG_PATH as ffmpegPath } from './media.js';
import { log } from './logger.js';
import { perf } from './perf.js';
import {
  getEncoder,
  getEncoderFallback,
  markEncoderBroken,
  type EncoderConfig,
  type EncoderKind,
  type BitDepth,
} from './encoder.js';
import { Priority } from './scheduler.js';
import { parseHlsDir, matchesKeep } from './cache-dirs.js';
import { lowerChildPriority } from './proc.js';
import { clampQuality, qualityLevelOf } from './quality.js';
import { DownloadLimiter, serveStats } from './download-limiter.js';
import type { StreamManager } from './stream.js';
import type { SubtitleManager } from './subs.js';
import type { MediaInfo } from './types.js';

const HLS_DIR = path.join(DATA_DIR, 'cache', 'hls');
const STREAM_BASE = `http://127.0.0.1:${Number(process.env.TP_PORT) || 3000}`;

// Сегменты 2 с (закрытый GOP в транскоде) — точная перемотка и быстрый seek.
const SEGMENT_SECONDS = 2;
// Лимит суммарного дискового кеша HLS (сегменты не удаляются при seek, поэтому
// нужен потолок — иначе remux до EOF быстро забьёт диск).
const HLS_MAX_BYTES = 20 * 1024 * 1024 * 1024;
// Докачка точки входа перед спавном ffmpeg после перемотки: коротко ждём, пока
// куски позиции seek скачаются, чтобы ffmpeg не вис на feed. Держим МЕНЬШЕ
// клиентского manifestLoadingTimeOut (20с): start() вызывается в запросе плейлиста,
// и слишком долгое ожидание превращается в manifestLoadTimeOut на клиенте. SEEK-
// приоритет теперь сохраняется (см. waitForBytes(..., false)), поэтому даже если не
// успели — ffmpeg дождётся байтов, а не потеряет их.
const SEEK_READY_TIMEOUT_MS = 12_000;
// Ширина критического окна при seek: помечаем больший диапазон как critical,
// чтобы нужные куски доехали первыми (rarest-first их иначе откладывает).
const SEEK_CRITICAL_BYTES = 32 * 1024 * 1024;
// Потолок одновременных ffmpeg-транскодов (защита CPU/GPU/диска при частых seek).
const MAX_CONCURRENT_FFMPEG = 4;
// Если транскод не выдал ни одного нового сегмента дольше этого времени, а источник
// впереди доступен — процесс завис: перезапускаем (и при повторе уходим на фолбэк-кодер).
const STUCK_RESTART_MS = 30_000;
const STUCK_MAX_RESTARTS = 2;

// Асинхронный подсчёт размера каталога: синхронный обход всего HLS-кеша на каждый
// start() блокировал event loop (фризы при перемотке на больших кешах).
async function dirSizeAsync(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else {
        try {
          total += (await fs.promises.stat(p)).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
}

export interface HlsStartOptions {
  audio?: number | null;
  startSec?: number;
  // Потолок высоты вывода (например 720/1080/2160). null/0 = полный размер исходника.
  res?: number | null;
  // Уровень качества транскода 0..6 (0 — максимум). null/undefined = DEFAULT_QUALITY.
  quality?: number | null;
  // Gain исходника до энкода (1 = выключено). Входит в ключ/каталог сессии.
  gain?: number | null;
  // Битность выхода: 8 или 10 (10 => HEVC/AV1). Входит в ключ/каталог сессии.
  bitDepth?: number | null;
}

// gain: 0.10..4.00 с округлением до 0.01 (чтобы не плодить варианты кеша сессий).
export function clampGain(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.min(4, Math.max(0.1, n)) * 100) / 100;
}

export function clampBitDepth(v: unknown): BitDepth {
  return Number(v) === 10 ? 10 : 8;
}

interface HlsSession {
  sessionId: string;
  topicId: number;
  fileIndex: number;
  audio: number | null;
  startSec: number; // абсолютная секунда, округлённая до границы сегмента
  res: number | null;
  // Уровень качества транскода (0..6, см. quality.ts). Влияет на квантайзер/усилие
  // энкодера и входит в ключ сессии/каталог (смена качества = новая сессия).
  quality: number;
  // Gain исходника и битность выхода — часть ключа/каталога сессии.
  gain: number;
  bitDepth: BitDepth;
  dir: string;
  proc: ChildProcess | null;
  state: 'starting' | 'active' | 'finished' | 'error' | 'stopped';
  error?: string;
  startedAt: number;
  gop: number;
  media: MediaInfo;
  encoder: EncoderConfig | null;
  transcodedEndSec: number; // абсолютная секунда, до которой уже накодировано
  fileLength: number; // размер файла (для расчёта prefetch-окна по битрейту)
  prefetchedSec: number; // докуда уже поднят prefetch-приоритет исходника
  // Диапазон байт точки seek, удерживающий SEEK-приоритет (снимаем при остановке,
  // чтобы старые точки перемотки не конкурировали с новой).
  seekRange: { start: number; end: number } | null;
  // Сглаженная скорость транскода (x реального времени) и отношение скорости
  // закачки к потоку файла — для бюджета превью и диагностики.
  speedMul: number;
  feedRatio: number;
  // Сколько раз сессию перезапускали из-за зависшего ffmpeg (0 сегментов, процесс жив).
  restarts: number;
}

interface ProgressTrack {
  end: number;
  at: number;
  warned: boolean;
}

let sessionSeq = 0;

// Округляем startSec до границы сегмента: иначе ключ кеша и позиция HLS-таймлайна
// разъедутся, и субтитры/зелёная зона начнут «плавать» на доли секунды.
function roundStartSec(sec: number): number {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.floor(sec / SEGMENT_SECONDS) * SEGMENT_SECONDS;
}

export class HlsManager {
  private sessions = new Map<string, HlsSession>();
  private byId = new Map<string, HlsSession>();
  private activeByFile = new Map<string, string>();
  private playheads = new Map<string, number>();
  // Когда playhead последний раз двигался и последнее известное состояние паузы.
  // Нужны бюджету превью, чтобы отличить просмотр от паузы.
  private playheadAt = new Map<string, number>();
  private playheadPaused = new Map<string, boolean>();
  // Предыдущий снимок прогресса для сглаженной скорости транскода.
  private ratePrev = new Map<string, { sec: number; at: number; ema: number }>();
  // Дедупликация одновременных start() на один ключ: без неё два запроса создали бы
  // две сессии и два ffmpeg, пишущих в один каталог.
  private inFlight = new Map<string, Promise<HlsSession>>();
  // Каталоги сессий, которые ещё готовятся (созданы, но сессия ещё не в `sessions`).
  // Нужны, чтобы orphan-скан removeCacheExcept не удалил каталог стартующей сессии.
  private preparingDirs = new Set<string>();
  // Число активных HTTP-читателей сессии (playlist/сегменты). Пока читают — нельзя
  // перезаписывать/удалять каталог, иначе клиент получит лавину 404 и «умрёт».
  private readers = new Map<string, number>();
  // Отложенные ре-старты остановленных сессий (ждут, пока уйдут читатели).
  private reusePending = new Map<string, NodeJS.Timeout>();
  // Прогресс транскода на сессию (для детекции «завис» ffmpeg) и prefetch-окно.
  private progress = new Map<string, ProgressTrack>();
  // Кэш «плейлист готов» на сессию: без него каждый HTTP-запрос плейлиста дёргал
  // fs.statSync в цикле и на стойле это било по event loop.
  private playlistReadyCache = new Map<string, { at: number; ready: boolean }>();
  // Последний снимок transcodedEndSec на сессию — для мгновенной (а не накопленной)
  // скорости в snapshot().
  private speedPrev = new Map<string, { sec: number; at: number }>();
  private keepAheadTimer: NodeJS.Timeout;
  // Адаптивный лимит закачки: контур сам находит устойчивую скорость диска.
  private limiter = new DownloadLimiter();
  private limiterTimer: NodeJS.Timeout;
  // Кольцевой буфер времени отдачи сегментов (сигнал давления на диск).
  private serveSamples: number[] = [];
  // Состояние гейта лимита (для телеметрии и логов).
  private limiterMode: 'uncapped' | 'adaptive' = 'uncapped';
  private limiterAheadSec = 0;
  private limiterPlaying = false;
  // Повторные падения HW-кодера (окно 60с): после двух подряд уходим на libx264.
  private encoderFailures = new Map<EncoderKind, { count: number; at: number }>();
  // Защита от наложения тиков лимита (status() асинхронный).
  private limiterBusy = false;

  constructor(
    private stream: StreamManager,
    private subs: SubtitleManager,
  ) {
    // Пока ffmpeg транскодит, держим приоритет байт исходника впереди головы
    // транскода (feed читает последовательно; без этого он встаёт на каждом куске).
    this.keepAheadTimer = setInterval(() => void this.keepAhead(), 4000);
    this.keepAheadTimer.unref();
    // Тик контура лимита: замеряем нагрузку на диск/event loop и подстраиваем cap.
    this.limiterTimer = setInterval(() => void this.limiterTick(), 2000);
    this.limiterTimer.unref();
  }

  // Время отдачи HLS-сегмента (мс) — основной сигнал давления на диск.
  noteServe(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.serveSamples.push(ms);
    if (this.serveSamples.length > 20) this.serveSamples.shift();
  }

  // Состояние гейта лимита + контура — для телеметрии.
  limiterTelemetry(): {
    mode: 'uncapped' | 'adaptive';
    capBps: number;
    pressure: boolean;
    reason: string;
    baselineMs: number;
    aheadSec: number;
    playing: boolean;
  } {
    const st = this.limiter.state;
    return {
      mode: this.limiterMode,
      capBps: st.capBps,
      pressure: st.pressure,
      reason: st.reason,
      baselineMs: st.baselineMs,
      aheadSec: this.limiterAheadSec,
      playing: this.limiterPlaying,
    };
  }

  retainSession(sessionId: string): void {
    this.readers.set(sessionId, (this.readers.get(sessionId) ?? 0) + 1);
  }

  releaseSession(sessionId: string): void {
    const n = (this.readers.get(sessionId) ?? 1) - 1;
    if (n <= 0) this.readers.delete(sessionId);
    else this.readers.set(sessionId, n);
  }

  private key(
    topicId: number,
    fileIndex: number,
    audio: number | null,
    startSec: number,
    res: number | null,
    quality: number,
    gain: number,
    bitDepth: BitDepth,
  ): string {
    return `${topicId}:${fileIndex}:${audio ?? ''}:${startSec}:${res ?? ''}:q${quality}:g${gain}:${bitDepth}bit`;
  }

  private fileKey(topicId: number, fileIndex: number): string {
    return `${topicId}:${fileIndex}`;
  }

  private sessionKey(s: HlsSession): string {
    return this.key(s.topicId, s.fileIndex, s.audio, s.startSec, s.res, s.quality, s.gain, s.bitDepth);
  }

  // Если сессия — активная для своего файла, убирает её из activeByFile.
  private unmapIfActive(s: HlsSession): void {
    const fk = this.fileKey(s.topicId, s.fileIndex);
    if (this.activeByFile.get(fk) === this.sessionKey(s)) this.activeByFile.delete(fk);
  }

  // Удаляет частичный кеш сегментов каталога (init/seg/playlist), оставляя каталог.
  // Вызов перед ре-транскодом: ffmpeg перезаписывает seg%05d с нуля, и старые файлы
  // от более длинного прошлого прогона иначе осиротеют/перемешаются с новыми.
  private clearSegments(dir: string): void {
    try {
      for (const e of fs.readdirSync(dir)) {
        if (e === 'init.mp4' || /^seg\d{5}\.m4s$/.test(e) || e === 'playlist.m3u8' || e === 'playlist.m3u8.tmp') {
          fs.rmSync(path.join(dir, e), { force: true });
        }
      }
      this.windowsCache.clear();
    } catch {
      /* ignore */
    }
  }

  // Освобождает место в кеше HLS: удаляет самые старые неактивные сессии, пока
  // суммарный размер не опустится под лимит. Активные (текущие) сессии не трогаем.
  private async gcCache(keepDir: string): Promise<void> {
    const gcT0 = Date.now();
    const entries = [...this.sessions.entries()].map(([key, s]) => ({
      key,
      dir: s.dir,
      startedAt: s.startedAt,
      active: this.activeByFile.get(this.fileKey(s.topicId, s.fileIndex)) === key,
    }));
    let total = 0;
    for (const e of entries) total += await dirSizeAsync(e.dir);
    const gcMs = Date.now() - gcT0;
    if (gcMs > 200) log.warn(`[cache] gcCache scan took ${gcMs}ms over ${entries.length} session(s)`);
    if (total <= HLS_MAX_BYTES) return;

    entries.sort((a, b) => a.startedAt - b.startedAt);
    for (const e of entries) {
      if (total <= HLS_MAX_BYTES) break;
      if (e.dir === keepDir || e.active) continue;
      const size = await dirSizeAsync(e.dir);
      try {
        fs.rmSync(e.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* ignore */
      }
      const s = this.sessions.get(e.key);
      if (s) {
        this.byId.delete(s.sessionId);
        this.playlistReadyCache.delete(s.sessionId);
      }
      this.sessions.delete(e.key);
      total -= size;
    }
  }

  async start(topicId: number, fileIndex: number, opts: HlsStartOptions = {}): Promise<HlsSession> {
    const audio = opts.audio === undefined ? null : opts.audio;
    const res = opts.res && opts.res > 0 ? opts.res : null;
    const quality = clampQuality(opts.quality);
    const gain = clampGain(opts.gain);
    const bitDepth = clampBitDepth(opts.bitDepth);
    const startSec = roundStartSec(opts.startSec ?? 0);
    const key = this.key(topicId, fileIndex, audio, startSec, res, quality, gain, bitDepth);
    const fkey = this.fileKey(topicId, fileIndex);

    // Два одновременных start() на один ключ не должны создавать две сессии/ffmpeg.
    const inflight = this.inFlight.get(key);
    if (inflight) return inflight;
    const p = this.startInternal(topicId, fileIndex, audio, res, quality, gain, bitDepth, startSec, key, fkey);
    this.inFlight.set(key, p);
    p.then(
      () => {
        if (this.inFlight.get(key) === p) this.inFlight.delete(key);
      },
      () => {
        if (this.inFlight.get(key) === p) this.inFlight.delete(key);
      },
    );
    return p;
  }

  private async startInternal(
    topicId: number,
    fileIndex: number,
    audio: number | null,
    res: number | null,
    quality: number,
    gain: number,
    bitDepth: BitDepth,
    startSec: number,
    key: string,
    fkey: string,
  ): Promise<HlsSession> {
    const startTimer = perf.timer('hls.start.ms');

    // Останавливаем ffmpeg остальных сессий этого файла (CPU), но каталоги кеша НЕ удаляем:
    // повторная перемотка в ту же позицию достанет сегменты из кеша мгновенно.
    this.stopOthers(topicId, fileIndex, key);
    // Ограничиваем число удерживаемых остановленных сессий файла: иначе карты и
    // каталоги кеша растут с каждой перемоткой, и со временем всё деградирует.
    this.pruneStaleSessions(topicId, fileIndex, key);
    // Окно латентности НЕ сбрасываем: медиана устойчива к одиночным замерам, а
    // непрерывная история позволяет заметить давление сразу после перемотки, не
    // давая диску захлебнуться на «разгоне» (была петля uncapped→choke→...).

    const existing = this.sessions.get(key);
    if (existing && existing.state !== 'error') {
      this.activeByFile.set(fkey, key);
      // Finished — полный кеш (мгновенно). stopped — надо перекодировать заново, но
      // каталог перезаписываем ТОЛЬКО когда с него никто не читает (иначе 404-шторм).
      if (existing.state !== 'finished' && existing.proc == null) {
        this.scheduleReuseRestart(existing, key);
      }
      return existing;
    }
    if (existing) {
      this.sessions.delete(key);
      this.byId.delete(existing.sessionId);
    }

    // Начинаем кодировать НОВОЕ видео: удаляем кеш всех остальных видео (других
    // файлов/топиков). Кеш этого же файла (по всем позициям) сохраняем — перемотка
    // назад и повторный вход на то же видео остаются мгновенными.
    void this.removeCacheExcept(topicId, fileIndex).catch((e) =>
      log.warn(`[cache] hls prune failed: ${e instanceof Error ? e.message : e}`),
    );

    if (!ffmpegPath) {
      throw new Error('ffmpeg не найден.');
    }

    const media = await this.stream.probe(topicId, fileIndex);
    const { file } = await this.stream.getFile(topicId, fileIndex);

    const dir = path.join(
      HLS_DIR,
      `${topicId}_${fileIndex}_${audio ?? 'def'}_${startSec}_${res ?? 'full'}_q${quality}_g${gain}_${bitDepth}bit`,
    );
    this.preparingDirs.add(dir);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      this.preparingDirs.delete(dir);
      throw e instanceof Error ? e : new Error(String(e));
    }

    const gop = Math.max(12, Math.round((media.fps ?? 24) * SEGMENT_SECONDS));

    const session: HlsSession = {
      sessionId: `s${++sessionSeq}_${Date.now().toString(36)}`,
      topicId,
      fileIndex,
      audio,
      startSec,
      res,
      quality,
      gain,
      bitDepth,
      dir,
      proc: null,
      state: 'starting',
      startedAt: Date.now(),
      gop,
      media,
      encoder: null,
      transcodedEndSec: startSec,
      fileLength: file.length,
      prefetchedSec: startSec,
      seekRange: null,
      speedMul: 0,
      feedRatio: 0,
      restarts: 0,
    };
    this.sessions.set(key, session);
    this.byId.set(session.sessionId, session);
    this.activeByFile.set(fkey, key);
    this.preparingDirs.delete(dir);

    // Заранее тянем seek-индекс (хвост: MKV Cues / MP4 moov / AVI idx1), чтобы -ss
    // делал быстрый seek, а не полный проход. Не блокируем redirect: ffmpeg сам
    // дождётся недостающих байтов (backpressure через HTTP).
    try {
      await this.stream.prioritizeTail(topicId, fileIndex);
    } catch {
      /* ignore */
    }
    if (startSec > 0) {
      const dur = media.durationSec ?? 0;
      // Точный байт по MKV Cues (для VBR оценка frac*size неточна): приоритизируем
      // реальный кластер и ждём докачки его кусков (с потолком), чтобы ffmpeg не
      // блокировался на feed — иначе транскод «стопорится, потом рывок».
      const exactByte =
        file.length > 0 ? await this.subs.seekByteFor(topicId, fileIndex, startSec).catch(() => null) : null;
      if (exactByte != null) {
        const marginBack = 4 * 1024 * 1024; // ключевой кадр до позиции
        const windowForward = 16 * 1024 * 1024;
        const bs = Math.max(0, exactByte - marginBack);
        const be = Math.min(file.length - 1, exactByte + windowForward);
        try {
          await this.stream.prioritizeRange(topicId, fileIndex, bs, be, Priority.SEEK, SEEK_CRITICAL_BYTES);
          session.seekRange = { start: bs, end: be };
          // НЕ ждём докачки точки seek перед спавном ffmpeg: иначе redirect плейлиста
          // блокируется на несколько секунд (до SEEK_READY_TIMEOUT_MS), и просмотр
          // стартует медленно. Приоритет уже поднят; ffmpeg сам дождётся байтов через
          // HTTP-backpressure. Ждём «в фоне» с сохранением SEEK-приоритета.
          void this.stream
            .waitForBytes(topicId, fileIndex, bs, Math.min(be, bs + 8 * 1024 * 1024), SEEK_READY_TIMEOUT_MS, SEEK_CRITICAL_BYTES, false)
            .catch(() => {});
        } catch {
          /* ignore */
        }
        log.info(`[hls] ${topicId}:${fileIndex} precise seek @${startSec}s -> byte ${exactByte}`);
      } else if (dur > 0 && file.length > 0) {
        const frac = Math.min(1, startSec / dur);
        const byteStart = Math.floor(frac * file.length);
        const byteEnd = Math.min(file.length - 1, byteStart + 8 * 1024 * 1024);
        try {
          await this.stream.prioritizeRange(topicId, fileIndex, byteStart, byteEnd, Priority.SEEK, SEEK_CRITICAL_BYTES);
          session.seekRange = { start: byteStart, end: byteEnd };
          void this.stream
            .waitForBytes(topicId, fileIndex, byteStart, byteEnd, SEEK_READY_TIMEOUT_MS, SEEK_CRITICAL_BYTES, false)
            .catch(() => {});
        } catch {
          /* ignore */
        }
      }
      // Не ждём хвост вслепую, если Cues/seek-индекс уже скачан (повторный seek) —
      // это главная задержка перемотки на тяжёлых файлах.
      const tailStart = Math.max(0, file.length - 4 * 1024 * 1024);
      try {
        const tailReady = await this.stream.areBytesReady(
          topicId,
          fileIndex,
          tailStart,
          file.length - 1,
        );
        if (!tailReady) {
          await this.stream.waitForBytes(
            topicId,
            fileIndex,
            tailStart,
            file.length - 1,
            3000,
            undefined,
            // Хвост (Cues) тоже нужен активному транскоду — не снимаем SEEK.
            false,
          );
        }
      } catch {
        /* ignore */
      }
    }

    // Диагностика перед spawn: готовы ли байты точки входа и хвоста (Cues).
    if (startSec > 0 && media.durationSec) {
      const dur = media.durationSec;
      const approx = Math.min(file.length - 1, Math.floor((startSec / dur) * file.length));
      // Проверяем реальную точку входа (по Cues), а не грубую frac-оценку — иначе
      // диагностика врёт (approx и precise могут отличаться на сотни МБ).
      const headByte = session.seekRange ? session.seekRange.start : approx;
      const headReady = await this.stream
        .areBytesReady(topicId, fileIndex, headByte, Math.min(file.length - 1, headByte + 2 * 1024 * 1024))
        .catch(() => false);
      const tailStart = Math.max(0, file.length - 4 * 1024 * 1024);
      const tailReady = await this.stream
        .areBytesReady(topicId, fileIndex, tailStart, file.length - 1)
        .catch(() => false);
      log.info(
        `[hls] diag start=${startSec}s headByte=${headByte} (approx=${approx}) headReady=${headReady} tailReady=${tailReady} readers=${this.readers.get(session.sessionId) ?? 0}`,
      );
    }

    if (session.state === 'starting') {
      session.state = 'active';
      // Каталог может содержать хвосты от предыдущего (удалённого) прогона с тем же
      // ключом — затираем, чтобы нумерация seg%05d не смешалась со старыми файлами.
      this.clearSegments(session.dir);
      session.transcodedEndSec = startSec;
      void this.spawn(session, startSec);
      log.info(
        `[hls] ${topicId}:${fileIndex} started (transcode, audio=${audio ?? 'default'} start=${startSec} res=${res ?? 'full'})`,
      );
    } else {
      // Сессию остановили во время подготовки (stopFile/stopOthers/abort) — не
      // запускаем ffmpeg и убираем сессию из карт.
      this.sessions.delete(key);
      this.byId.delete(session.sessionId);
      this.unmapIfActive(session);
      this.progress.delete(session.sessionId);
    }
    void this.gcCache(dir).catch((e) =>
      log.warn(`[cache] hls gc failed: ${e instanceof Error ? e.message : e}`),
    );
    startTimer();
    return session;
  }

  // Повторный старт остановленной сессии (тот же ключ): каталог сегментов нельзя
  // перезаписывать, пока с него кто-то читает — иначе клиент получает лавину 404.
  // Ждём, пока читатели уйдут, затем чистим каталог и перекодируем заново с startSec.
  private scheduleReuseRestart(s: HlsSession, key: string): void {
    if (this.reusePending.has(key)) return;
    const run = (): void => {
      this.reusePending.delete(key);
      const cur = this.sessions.get(key);
      if (!cur || cur !== s) return; // сессия сменилась/удалена
      if (cur.proc) return; // уже бежит
      if (cur.state === 'finished') return; // полный кеш — перезапуск не нужен
      if ((this.readers.get(cur.sessionId) ?? 0) > 0) {
        const t = setTimeout(run, 700);
        this.reusePending.set(key, t);
        return;
      }
      cur.state = 'active';
      this.clearSegments(cur.dir);
      cur.transcodedEndSec = cur.startSec;
      cur.prefetchedSec = cur.startSec;
      // Сбрасываем трек прогресса/скорости и метку старта: иначе остаётся «старый»
      // pt.at от прошлого прогона, и keepAhead сразу считает процесс зависшим
      // (ложный recoverStuck → убийство NVENC → падение на медленный libx264).
      cur.startedAt = Date.now();
      cur.restarts = 0;
      this.resetProgress(cur);
      void this.spawn(cur, cur.startSec);
    };
    const t = setTimeout(run, 0);
    this.reusePending.set(key, t);
  }

  // Периодически: prefetch исходника вперёд от головы транскода (feed читает
  // последовательно — без этого он встаёт на каждом недостающем куске) и детекция
  // «зависшего» ffmpeg (транскод не двигается, но процесс жив).
  private async keepAhead(): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.state !== 'active' || !s.proc) continue;
      // Свежий прогресс считаем по сегментам на диске — не зависим от клиентских
      // опросов статуса (иначе на скрытой вкладке прогресс «замерзал»).
      const segs = await this.segmentCount(s.dir);
      if (segs > 0 && s.transcodedEndSec <= s.startSec) {
        log.info(
          `[hls] ${s.topicId}:${s.fileIndex} first segment in ${Date.now() - s.startedAt}ms (@${s.startSec}s, ${s.encoder?.label ?? '?'})`,
        );
      }
      const end = Math.max(s.transcodedEndSec, s.startSec + segs * SEGMENT_SECONDS);
      s.transcodedEndSec = end;

      // Сглаженная скорость транскода (x) и отношение закачки к потоку файла —
      // метрики для бюджета превью и диагностики.
      const nowMs = Date.now();
      const rp = this.ratePrev.get(s.sessionId);
      if (rp) {
        const dt = (nowMs - rp.at) / 1000;
        const inst = dt > 0 ? (end - rp.sec) / dt : 0;
        s.speedMul = rp.ema > 0 ? rp.ema * 0.5 + inst * 0.5 : inst;
      }
      this.ratePrev.set(s.sessionId, { sec: end, at: nowMs, ema: s.speedMul });
      const durSec = s.media.durationSec ?? 0;
      if (durSec > 0 && s.fileLength > 0) {
        try {
          const st = await this.stream.status(s.topicId, s.fileIndex);
          const progress = st.file?.progress ?? st.progress;
          // Файл уже скачан — байты берутся с диска, а не из сети. Если считать
          // feedRatio от downloadSpeed (≈0), бюджет превью навсегда залипнет на
          // минимуме. Поэтому полностью локальному файлу даём «бесконечную» подачу.
          s.feedRatio =
            progress >= 1 ? 99 : st.downloadSpeed / (s.fileLength / durSec);
        } catch {
          /* ignore */
        }
      }

      const pt = this.progress.get(s.sessionId);
      if (pt) {
        if (end > pt.end) {
          pt.end = end;
          pt.at = Date.now();
          pt.warned = false;
          s.restarts = 0;
        } else {
          const idle = Date.now() - pt.at;
          if (!pt.warned && idle > 20000) {
            // Нет прогресса 20с. Раньше условие требовало end > startSec, из-за чего
            // «0 сегментов вообще» (главный симптом зависшей перемотки) не логировался.
            pt.warned = true;
            let files = 0;
            try {
              for (const e of fs.readdirSync(s.dir)) {
                if (/^seg\d{5}\.m4s$/.test(e)) files++;
              }
            } catch {
              /* ignore */
            }
            log.warn(
              `[hls] ${s.topicId}:${s.fileIndex} transcode stuck at ${end.toFixed(0)}s (${files} segs on disk, proc ${s.proc ? 'alive' : 'gone'})`,
            );
          }
          // Процесс жив, но вывода нет: если источник впереди доступен, значит
          // завис кодировщик/декодер — перезапускаем, затем уходим на фолбэк-кодер.
          if (idle > STUCK_RESTART_MS) this.recoverStuck(s);
        }
      } else {
        this.progress.set(s.sessionId, { end, at: Date.now(), warned: false });
      }

      const dur = s.media.durationSec ?? 0;
      if (dur > 0 && s.fileLength > 0) {
        const horizon = Math.min(dur, end + 150);
        while (s.prefetchedSec < horizon) {
          const from = s.prefetchedSec;
          const to = Math.min(dur, from + 150);
        const b0 = Math.floor((from / dur) * s.fileLength);
        const b1 = Math.max(b0, Math.min(s.fileLength - 1, Math.floor((to / dur) * s.fileLength)));
        try {
          // Префетч НИЖЕ приоритета SEEK: иначе после перемотки точка seek и окно
          // префетча (150с) сливаются в один регион SEEK, и webtorrent качает его
          // rarest-first — куски точки seek приезжают последними среди сотен МБ.
          await this.stream.prioritizeRange(s.topicId, s.fileIndex, b0, b1, Priority.BUFFER);
        } catch {
          /* ignore */
        }
          s.prefetchedSec = to;
        }
      }
    }
    for (const id of this.progress.keys()) {
      if (!this.byId.has(id)) this.progress.delete(id);
    }
    for (const id of this.ratePrev.keys()) {
      if (!this.byId.has(id)) this.ratePrev.delete(id);
    }
  }

  // Восстановление зависшего транскода: процесс ffmpeg жив, но сегменты не пишутся.
  // Перезапускаем с начала сессии (перезаписываем каталог); если и это не помогло —
  // уходим на фолбэк-кодер (обычно libx264). Читателей не трогаем (риск 404-шторма).
  private recoverStuck(s: HlsSession): void {
    if (s.state !== 'active' || !s.proc) return;
    if ((this.readers.get(s.sessionId) ?? 0) > 0) return;
    // Процесс стартовал только что — дать ему время выдать первый сегмент
    // (на 4K HEVC это может быть несколько секунд). Без этого повторный seek в
    // точку с существующей сессией ложно «перезапускался» из-за старого pt.at.
    if (Date.now() - s.startedAt < STUCK_RESTART_MS) return;
    // Мало данных впереди — это не зависание кодировщика, а недокачка: ждём.
    if (s.feedRatio > 0 && s.feedRatio < 0.9) return;

    if (s.restarts >= STUCK_MAX_RESTARTS) {
      log.warn(`[hls] ${s.topicId}:${s.fileIndex} transcode stuck — fallback encoder`);
      try {
        s.proc.kill();
      } catch {
        /* ignore */
      }
      s.proc = null;
      this.clearSegments(s.dir);
      s.transcodedEndSec = s.startSec;
      s.prefetchedSec = s.startSec;
      s.startedAt = Date.now();
      this.resetProgress(s);
      this.retryOrFail(s, 1, 'transcode stuck', 'transcode stuck');
      return;
    }

    s.restarts++;
    log.warn(`[hls] ${s.topicId}:${s.fileIndex} transcode stuck — restart #${s.restarts}`);
    try {
      s.proc.kill();
    } catch {
      /* ignore */
    }
    s.proc = null;
    this.clearSegments(s.dir);
    s.transcodedEndSec = s.startSec;
    s.prefetchedSec = s.startSec;
    s.startedAt = Date.now();
    this.resetProgress(s);
    void this.spawn(s, s.startSec);
  }

  // Сбрасывает трек прогресса/скорости сессии (после перезапуска/переиспользования).
  private resetProgress(s: HlsSession): void {
    const pt = this.progress.get(s.sessionId);
    if (pt) {
      pt.end = s.transcodedEndSec;
      pt.at = Date.now();
      pt.warned = false;
    }
    this.ratePrev.delete(s.sessionId);
    this.speedPrev.delete(s.sessionId);
  }

  // Тик лимита закачки. Политика:
  //   * нет активной сессии → UNCAPPED (кеш набирается на полной);
  //   * пока сессия активна (включая перемотку/буферизацию/паузу) → адаптивный
  //     контур по латентности чтения с диска. UNCAPPED достигается сам, когда
  //     давления нет (здоровый диск); при давлении cap снижается. event loop в
  //     триггерах НЕ участвует — это кодировщик/CPU.
  // TP_STREAM_LIMIT_MBPS — жёсткий оверрайд, TP_STREAM_ADAPTIVE=0 — выключить.
  private async limiterTick(): Promise<void> {
    if (this.limiterBusy) return;
    this.limiterBusy = true;
    try {
      const forced = Number(process.env.TP_STREAM_LIMIT_MBPS);
      const forcedOn = Number.isFinite(forced) && forced > 0;
      const adaptiveOn = process.env.TP_STREAM_ADAPTIVE !== '0';

      const active = [...this.sessions.values()].find(
        (s) => s.state === 'active' || s.state === 'starting',
      );

      let playing = false;
      let ahead = 0;
      if (active) {
        const fk = this.fileKey(active.topicId, active.fileIndex);
        const pos = this.playheads.get(fk);
        ahead = active.transcodedEndSec - (pos ?? active.startSec);
        playing = this.isPlaying(active.topicId, active.fileIndex);
      }
      this.limiterAheadSec = ahead;
      this.limiterPlaying = playing;

      // Жёсткий ручной оверрайд имеет приоритет над любым режимом.
      if (forcedOn) {
        this.limiter.reset();
        this.limiterMode = 'uncapped';
        this.stream.setDownloadRate(forced * 1024 * 1024);
        return;
      }
      if (!active || !adaptiveOn) {
        this.limiter.reset();
        this.limiterMode = 'uncapped';
        this.stream.setDownloadRate(-1);
        return;
      }

      // Контур работает ВСЕГДА, пока есть активная сессия (в т.ч. во время перемотки/
      // буферизации). Иначе получается петля: uncapped душит диск → транскод не
      // успевает → буфер не растёт → uncapped навсегда. Uncapped достигается сам:
      // пока давления нет, cap остаётся -1 (здоровый диск); при давлении — снижаем.
      const stats = serveStats(this.serveSamples);

      let observedBps = 0;
      let local = false;
      try {
        const st = await this.stream.status(active.topicId, active.fileIndex);
        observedBps = st.downloadSpeed;
        local = (st.file?.progress ?? st.progress ?? 0) >= 1;
      } catch {
        /* ignore */
      }
      const durSec = active.media.durationSec ?? 0;
      const needBps = durSec > 0 && active.fileLength > 0 ? active.fileLength / durSec : 0;

      const state = this.limiter.tick({
        serveMedMs: stats.med,
        serveMinMs: stats.min,
        serveCount: stats.count,
        observedBps,
        needBps,
        local,
      });
      this.limiterMode = state.capBps < 0 ? 'uncapped' : 'adaptive';
      this.stream.setDownloadRate(state.capBps);
    } finally {
      this.limiterBusy = false;
    }
  }

  // Позиция плейхеда, сообщённая клиентом через /stream/status?pos= (для правила
  // параллельности превью: генерируем их, только когда транскод опережает ≥ N секунд).
  setPlayhead(topicId: number, fileIndex: number, pos: number, paused?: boolean): void {
    if (!Number.isFinite(pos) || pos < 0) return;
    const fk = this.fileKey(topicId, fileIndex);
    const prev = this.playheads.get(fk);
    // Движение вперёд обновляет метку живости (для режима «играет/пауза»).
    if (prev == null || pos > prev + 0.5) this.playheadAt.set(fk, Date.now());
    this.playheads.set(fk, pos);
    if (paused != null) this.playheadPaused.set(fk, paused);
  }

  // Играет ли файл прямо сейчас (для бюджета превью). Явное состояние от клиента
  // в приоритете; иначе — по недавнему движению playhead.
  private isPlaying(topicId: number, fileIndex: number): boolean {
    const fk = this.fileKey(topicId, fileIndex);
    const paused = this.playheadPaused.get(fk);
    if (paused === true) return false;
    if (paused === false) return true;
    // Явного состояния ещё не было: playhead вообще не приходил — считаем, что
    // играет (консервативно, чтобы не отдать 30% превью на старте). Приходил и замер
    // дольше 25 с — пауза.
    if (!this.playheads.has(fk)) return true;
    const at = this.playheadAt.get(fk) ?? 0;
    return Date.now() - at < 25_000;
  }

  // Снимок производительности активной сессии файла: скорость транскода, отношение
  // закачки к потоку, минимум из них («скорость подготовки»), запас вперёд и
  // играет ли сейчас. Используется бюджетом превью и для лога.
  sessionPerf(
    topicId: number,
    fileIndex: number,
  ): { speed: number; feedRatio: number; prep: number; ahead: number; playing: boolean } | null {
    const s = this.activeSession(topicId, fileIndex);
    if (!s) return null;
    const fk = this.fileKey(topicId, fileIndex);
    const pos = this.playheads.get(fk);
    const ahead = s.transcodedEndSec - (pos ?? s.startSec);
    return {
      speed: s.speedMul,
      feedRatio: s.feedRatio,
      prep: Math.min(s.speedMul, s.feedRatio),
      ahead,
      playing: this.isPlaying(topicId, fileIndex),
    };
  }

  // Сколько секунд транскод опережает playhead (null — нет активной сессии).
  transcodeAheadSec(topicId: number, fileIndex: number): number | null {
    const s = this.activeSession(topicId, fileIndex);
    if (!s) return null;
    const pos = this.playheads.get(this.fileKey(topicId, fileIndex));
    return s.transcodedEndSec - (pos ?? s.startSec);
  }

  private async spawn(session: HlsSession, resumeSec: number): Promise<void> {
    if (!ffmpegPath) {
      session.state = 'error';
      session.error = 'ffmpeg не найден.';
      return;
    }
    // Остановили/удалили сессию до старта (stopSession во время подготовки) —
    // процесс не поднимаем.
    if (session.state === 'stopped' || session.state === 'error') return;
    // Отсчёт «завис» и треки прогресса/скорости начинаем с момента запуска процесса.
    session.startedAt = Date.now();
    this.resetProgress(session);
    const { topicId, fileIndex, audio, gop, res } = session;
    const media = session.media;
    const hasVideo = Boolean(media.videoCodec);

    // Аппаратный кодер с фолбэком: если текущий не инициализировался на реальном
    // файле (пробой мы проверили только синтетику), упадём на libx264.
    if (!session.encoder) {
      session.encoder = await getEncoder();
    }
    // Между getEncoder() и spawn сессию могли остановить.
    const stateAfterEncoder: string = session.state;
    if (stateAfterEncoder === 'stopped' || stateAfterEncoder === 'error') return;
    const encoder = session.encoder;

    const args = ['-hide_banner', '-loglevel', 'warning', '-y', '-fflags', '+genpts'];
    args.push(...encoder.hwaccelArgs());
    if (resumeSec > 0) args.push('-ss', String(resumeSec));
    // feed=1 — сервер не кэпирует ответ для ffmpeg (он должен читать файл целиком).
    args.push('-i', `${STREAM_BASE}/api/topic/${topicId}/stream/${fileIndex}?feed=1`);

    if (hasVideo) {
      args.push('-map', '0:v:0');
      // Масштаб/даунскейл, gain и конвертация битности — по кодеру (NVENC держит
      // scale на GPU; gain применяется к исходнику в его битности).
      args.push(
        ...encoder.filterArgs({
          height: media.height,
          res,
          bitDepth: session.bitDepth,
          gain: session.gain,
        }),
      );
      const vArgs = encoder.videoArgs({
        gop,
        segmentSec: SEGMENT_SECONDS,
        quality: qualityLevelOf(session.quality),
        bitDepth: session.bitDepth,
      });
      args.push(...vArgs);
      // Лог эффективных настроек видеокодера.
      log.info(
        `[hls] ${topicId}:${fileIndex} quality=${session.quality} gain=${session.gain} bitDepth=${session.bitDepth} ${encoder.label}: ${vArgs.join(' ')}`,
      );
    }
    if (media.audioCodec) {
      args.push(
        '-map', audio == null ? '0:a:0' : `0:${audio}`,
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      );
    }

    args.push(
      '-sn',
      '-hls_time', String(SEGMENT_SECONDS),
      '-hls_playlist_type', 'event',
      '-hls_list_size', '0',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', 'seg%05d.m4s',
      'playlist.m3u8',
    );

    // Потолок одновременных ffmpeg: лишние (самые старые) транскоды гасим, чтобы
    // серия перемоток не подняла десяток HW-энкодеров и не задушила CPU/GPU/диск.
    const live = [...this.sessions.values()].filter((s) => s.proc && s !== session);
    if (live.length >= MAX_CONCURRENT_FFMPEG) {
      live.sort((a, b) => a.startedAt - b.startedAt);
      const toStop = live.length - MAX_CONCURRENT_FFMPEG + 1;
      for (let i = 0; i < toStop; i++) this.stopSession(live[i]);
      log.warn(`[hls] ${topicId}:${fileIndex} throttled ffmpeg: stopped ${toStop} older transcode(s)`);
    }

    const proc = spawn(ffmpegPath, args, { cwd: session.dir, stdio: ['ignore', 'ignore', 'pipe'] }) as ChildProcess;
    session.proc = proc;
    session.state = 'active';
    // ffmpeg/драйвер грузят CPU — держим его ниже Node, чтобы сегменты отдавались вовремя.
    lowerChildPriority(proc);

    let stderr = '';
    // Троттлинг вывода ffmpeg: декодер HEVC на 4K сыпет сотнями предупреждений в
    // секунду, а синхронная запись в лог блокирует event loop (наблюдали loopLag ~5с).
    // Копим и пишем не чаще раза в секунду.
    let stderrLogAt = 0;
    let stderrPending = '';
    proc.stderr?.on('data', (d) => {
      const text = d.toString();
      stderr = (stderr + text).slice(-2000);
      stderrPending = (stderrPending + text).slice(-2000);
      const now = Date.now();
      if (now - stderrLogAt >= 1000) {
        stderrLogAt = now;
        const msg = stderrPending.trim();
        stderrPending = '';
        if (msg) log.warn(`[hls] ${topicId}:${fileIndex} ffmpeg: ${msg}`);
      }
    });
    proc.on('error', (err) => {
      session.proc = null;
      if (session.state === 'stopped') return;
      this.retryOrFail(session, 1, stderr, err.message);
    });
    proc.on('close', (code) => {
      session.proc = null;
      void this.scanPlaylist(session.dir).then(({ relSec }) => {
        const nowEnd = session.startSec + relSec;
        session.transcodedEndSec = nowEnd;
        if (session.state === 'stopped') return;
        if (code === 0) {
          session.state = 'finished';
          log.info(`[hls] ${topicId}:${fileIndex} finished (cached up to ${nowEnd.toFixed(1)}s)`);
        } else if (relSec === 0) {
          // Ретрай только если не успели произвести ни одного сегмента (фейл на
          // старте: HW-декод/кодер не поднялся на реальном файле).
          this.retryOrFail(session, code ?? 1, stderr, null);
        } else {
          session.state = 'error';
          session.error = stderr.trim() || `ffmpeg exit ${code}`;
          log.warn(`[hls] ${topicId}:${fileIndex} failed mid-way: ${session.error}`);
        }
      });
    });

    log.info(`[hls] ${topicId}:${fileIndex} ffmpeg transcode @${resumeSec.toFixed(1)}s (${encoder.label})`);
  }

  // При падении до первого сегмента пробуем следующий кодер в цепочке (HW→libx264).
  private retryOrFail(session: HlsSession, code: number, stderr: string, spawnMsg: string | null): void {
    const { topicId, fileIndex } = session;
    const failedKind = session.encoder?.kind ?? 'libx264';
    // Считаем повторные падения HW-кодера: если он валится снова и снова (напр. на
    // каждом seek), переключаем авто-выбор на CPU-кодер, чтобы не тратить время/GPU.
    const now = Date.now();
    const prev = this.encoderFailures.get(failedKind);
    const count = prev && now - prev.at < 60_000 ? prev.count + 1 : 1;
    this.encoderFailures.set(failedKind, { count, at: now });
    if (failedKind !== 'libx264' && count >= 2) markEncoderBroken(failedKind);
    const fb = getEncoderFallback(failedKind);
    if (fb) {
      session.encoder = fb;
      log.warn(
        `[hls] ${topicId}:${fileIndex} ${failedKind} early failure (${spawnMsg ?? stderr.trim().slice(0, 300)}), falling back to ${fb.kind}`,
      );
      void this.spawn(session, session.startSec);
      return;
    }
    session.state = 'error';
    session.error = spawnMsg ?? (stderr.trim() || `ffmpeg exit ${code}`);
    log.warn(`[hls] ${topicId}:${fileIndex} failed: ${session.error}`);
  }

  activeSession(topicId: number, fileIndex: number): HlsSession | undefined {
    const key = this.activeByFile.get(this.fileKey(topicId, fileIndex));
    return key ? this.sessions.get(key) : undefined;
  }

  // Список файлов с живой HLS-сессией (для периодической подстройки бюджета превью).
  activeFiles(): Array<{ topicId: number; fileIndex: number }> {
    const out: Array<{ topicId: number; fileIndex: number }> = [];
    for (const s of this.sessions.values()) {
      if (s.state === 'stopped') continue;
      out.push({ topicId: s.topicId, fileIndex: s.fileIndex });
    }
    return out;
  }

  // Текущий транскодированный диапазон активной сессии файла (для диагностики).
  activeTranscodedSec(topicId: number, fileIndex: number): { startSec: number; endSec: number } | null {
    const s = this.activeSession(topicId, fileIndex);
    return s ? { startSec: s.startSec, endSec: s.transcodedEndSec } : null;
  }

  // Окна уже перекодированных данных по файлу (активная + завершённые/остановленные
  // сессии, чьи сегменты лежат на диске). Для извлечения превью без повторного
  // чтения исходника: сегмент = seg%05d.m4s + init.mp4 в dir, длина segSec с.
  private windowsCache = new Map<string, { at: number; windows: Array<{ startSec: number; endSec: number; dir: string; segSec: number }> }>();

  async transcodeWindows(
    topicId: number,
    fileIndex: number,
  ): Promise<Array<{ startSec: number; endSec: number; dir: string; segSec: number }>> {
    const fkey = this.fileKey(topicId, fileIndex);
    const cached = this.windowsCache.get(fkey);
    if (cached && Date.now() - cached.at < 1500) return cached.windows;
    const windows: Array<{ startSec: number; endSec: number; dir: string; segSec: number }> = [];
    for (const s of this.sessions.values()) {
      if (s.topicId !== topicId || s.fileIndex !== fileIndex) continue;
      if (s.state === 'error' || s.startSec >= s.transcodedEndSec) continue;
      windows.push({ startSec: s.startSec, endSec: s.transcodedEndSec, dir: s.dir, segSec: SEGMENT_SECONDS });
    }
    windows.sort((a, b) => a.startSec - b.startSec);
    this.windowsCache.set(fkey, { at: Date.now(), windows });
    return windows;
  }

  // Снимок всех неостановленных сессий со скоростью транскодирования (x реального
  // времени). Нужен для периодического лога производительности.
  snapshot(): Array<{
    topicId: number;
    fileIndex: number;
    state: string;
    startSec: number;
    endSec: number;
    speedMul: number;
  }> {
    const now = Date.now();
    const out: Array<{
      topicId: number;
      fileIndex: number;
      state: string;
      startSec: number;
      endSec: number;
      speedMul: number;
    }> = [];
    for (const s of this.sessions.values()) {
      if (s.state === 'stopped') continue;
      // Мгновенная скорость: дельта transcodedEndSec за интервал между снимками.
      // Накопленная done/elapsed «скакала», когда transcodedEndSec обновлялся кусками.
      const prev = this.speedPrev.get(s.sessionId);
      let speedMul: number;
      if (prev) {
        const dSec = s.transcodedEndSec - prev.sec;
        const dMs = Math.max(1, now - prev.at);
        speedMul = Math.round((dSec / (dMs / 1000)) * 100) / 100;
      } else {
        const elapsed = Math.max(1, (now - s.startedAt) / 1000);
        const done = Math.max(0, s.transcodedEndSec - s.startSec);
        speedMul = Math.round((done / elapsed) * 100) / 100;
      }
      this.speedPrev.set(s.sessionId, { sec: s.transcodedEndSec, at: now });
      out.push({
        topicId: s.topicId,
        fileIndex: s.fileIndex,
        state: s.state,
        startSec: s.startSec,
        endSec: s.transcodedEndSec,
        speedMul,
      });
    }
    for (const id of this.speedPrev.keys()) {
      if (!this.byId.has(id)) this.speedPrev.delete(id);
    }
    return out;
  }

  sessionById(sessionId: string): HlsSession | undefined {
    return this.byId.get(sessionId);
  }

  status(topicId: number, fileIndex: number): { state: string; error?: string } {
    const s = this.activeSession(topicId, fileIndex);
    if (!s) return { state: 'none' };
    return { state: s.state, error: s.error };
  }

  getSession(topicId: number, fileIndex: number): HlsSession | undefined {
    return this.activeSession(topicId, fileIndex);
  }

  private stopSession(s: HlsSession): void {
    // Уже остановлена и процесс убит — повторный вызов (stopOthers при каждой
    // перемотке проходит по всем старым сессиям) не должен логировать и работать.
    if (s.state === 'stopped' && !s.proc) return;
    if (s.proc) {
      try {
        s.proc.kill();
      } catch {
        /* ignore */
      }
      s.proc = null;
    }
    s.state = 'stopped';
    this.unmapIfActive(s);
    // Снимаем SEEK/BUFFER-приоритеты, которые держала эта сессия: иначе после
    // перемотки старые точки/окна продолжают качаться и конкурируют с новой
    // (транскод не получает байты → 0 сегментов → зависший плейбек).
    this.releaseSessionRanges(s);
    this.playlistReadyCache.delete(s.sessionId);
    log.info(`[hls] ${s.topicId}:${s.fileIndex} stopped (cache kept)`);
  }

  // Ограничивает число удерживаемых остановленных сессий файла (кеш для повторных
  // перемоток). Без этого карты сессий и каталоги HLS растут с каждой перемоткой,
  // а вместе с ними — работа keepAhead/snapshot и нагрузка на диск. Активные и
  // читаемые сессии не трогаем.
  private pruneStaleSessions(topicId: number, fileIndex: number, keepKey: string): void {
    const RETAIN = 6;
    const stale: Array<{ key: string; s: HlsSession }> = [];
    for (const [key, s] of this.sessions) {
      if (s.topicId !== topicId || s.fileIndex !== fileIndex) continue;
      if (key === keepKey) continue;
      if (s.state === 'active' || s.state === 'starting') continue;
      if ((this.readers.get(s.sessionId) ?? 0) > 0) continue;
      stale.push({ key, s });
    }
    if (stale.length <= RETAIN) return;
    // Новые — первыми; всё сверх лимита удаляем вместе с каталогом.
    stale.sort((a, b) => b.s.startedAt - a.s.startedAt);
    for (const { key, s } of stale.slice(RETAIN)) {
      this.byId.delete(s.sessionId);
      this.progress.delete(s.sessionId);
      this.ratePrev.delete(s.sessionId);
      this.speedPrev.delete(s.sessionId);
      this.playlistReadyCache.delete(s.sessionId);
      this.sessions.delete(key);
      this.windowsCache.delete(this.fileKey(s.topicId, s.fileIndex));
      try {
        rmDirRobust(s.dir);
      } catch {
        /* ignore */
      }
      log.info(`[cache] pruned stale hls session ${s.dir}`);
    }
  }

  // Освобождает приоритеты исходника, поднятые сессией: точку seek (SEEK) и окно
  // префетча (BUFFER). Вызывается при остановке — чтобы не копить далёкие диапазоны.
  private releaseSessionRanges(s: HlsSession): void {
    if (s.seekRange) {
      void this.stream
        .releasePrioritizedRange(s.topicId, s.fileIndex, s.seekRange.start, s.seekRange.end, [
          Priority.SEEK,
        ])
        .catch(() => {});
      s.seekRange = null;
    }
    const dur = s.media.durationSec ?? 0;
    if (dur > 0 && s.fileLength > 0 && s.prefetchedSec > s.startSec) {
      const toByte = (sec: number): number =>
        Math.max(0, Math.min(s.fileLength - 1, Math.floor((Math.min(sec, dur) / dur) * s.fileLength)));
      const b0 = toByte(s.startSec);
      const b1 = toByte(s.prefetchedSec);
      if (b1 > b0) {
        void this.stream
          .releasePrioritizedRange(s.topicId, s.fileIndex, b0, b1, [Priority.BUFFER])
          .catch(() => {});
      }
    }
  }

  // Ждёт фактического завершения процесса (освобождение файловых дескрипторов),
  // чтобы последующее удаление кеша на Windows не споткнулось о заблокированные файлы.
  private static waitExit(p: ChildProcess, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      p.once('close', () => {
        clearTimeout(t);
        resolve();
      });
      p.once('error', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  stopTopic(topicId: number): void {
    for (const [, s] of this.sessions) {
      // 'starting'-сессии (proc ещё null) тоже останавливаем: иначе после подготовки
      // они всё равно заспавнились бы.
      if (s.topicId === topicId && s.proc) this.stopSession(s);
      else if (s.topicId === topicId && s.state === 'starting') this.stopSession(s);
    }
    // Отложенные ре-старты остановленных сессий топика тоже отменяем: иначе после
    // останова (в т.ч. watchdog'ом) таймер reusePending мог бы перезапустить ffmpeg
    // без зрителя. Ключ reusePending = sessionKey, начинается с `${topicId}:`.
    for (const [key, t] of this.reusePending) {
      if (key.startsWith(`${topicId}:`)) {
        clearTimeout(t);
        this.reusePending.delete(key);
      }
    }
  }

  // Есть ли у топика сессии, которые реально готовятся/транскодируют. Нужно
  // watchdog'у, чтобы останавливать только «живую» нагрузку.
  hasActiveTopic(topicId: number): boolean {
    for (const s of this.sessions.values()) {
      if (s.topicId === topicId && (s.state === 'starting' || s.state === 'active')) return true;
    }
    return false;
  }

  stopFile(topicId: number, fileIndex: number): void {
    const key = this.activeByFile.get(this.fileKey(topicId, fileIndex));
    if (key) {
      const s = this.sessions.get(key);
      if (s) this.stopSession(s);
    }
  }

  stopOthers(topicId: number, fileIndex: number, exceptKey: string): void {
    for (const [key, s] of this.sessions) {
      if (s.topicId === topicId && s.fileIndex === fileIndex && key !== exceptKey) {
        this.stopSession(s);
      }
    }
  }

  // Удаляет кеш HLS всех видео, кроме указанного. keepFileIndex === null — сохраняем
  // все файлы этого топика (вызов при активации нового топика); иначе — только один
  // файл (вызов при старте кодирования/смене серии). Останавливает ffmpeg удаляемых
  // сессий, ждёт их выхода (Windows: файлы залочены, пока процесс жив) и чистит
  // каталоги на диске, включая осиротевшие.
  async removeCacheExcept(keepTopicId: number, keepFileIndex: number | null): Promise<void> {
    const procs: ChildProcess[] = [];
    const doomed: Array<{ key: string; fileKey: string }> = [];

    for (const [key, s] of this.sessions) {
      const keep = matchesKeep({ topicId: s.topicId, fileIndex: s.fileIndex }, keepTopicId, keepFileIndex);
      if (keep) continue;
      if (s.proc) {
        procs.push(s.proc);
        try {
          s.proc.kill();
        } catch {
          /* ignore */
        }
        s.proc = null;
      }
      // 'stopped' — close-обработчик ffmpeg завершится раньше (не пересоздаст каталог
      // через retryOrFail после того, как мы его удалили).
      s.state = 'stopped';
      this.releaseSessionRanges(s);
      doomed.push({ key, fileKey: this.fileKey(s.topicId, s.fileIndex) });
    }

    // Ждём выхода ffmpeg удаляемых сессий, чтобы файлы на Windows были отпущены
    // до удаления каталогов.
    await Promise.all(procs.map((p) => HlsManager.waitExit(p, 1500)));

    for (const { key, fileKey } of doomed) {
      const s = this.sessions.get(key);
      if (!s) continue;
      try {
        rmDirRobust(s.dir);
      } catch {
        /* ignore */
      }
      this.byId.delete(s.sessionId);
      this.playlistReadyCache.delete(s.sessionId);
      if (this.activeByFile.get(fileKey) === key) this.activeByFile.delete(fileKey);
      this.sessions.delete(key);
      this.windowsCache.delete(fileKey);
      log.info(`[cache] pruned hls dir ${s.dir}`);
    }

    // Осиротевшие каталоги (нет живой сессии) — удаляем, если не соответствуют keep.
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(HLS_DIR, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(HLS_DIR, e.name);
      // Каталог сессии, которая ещё готовится (создана, но ещё не в sessions) —
      // не трогаем: её start() продолжит spawn после подготовки.
      if (this.preparingDirs.has(dir)) continue;
      const ref = parseHlsDir(e.name);
      if (ref && matchesKeep(ref, keepTopicId, keepFileIndex)) continue;
      try {
        rmDirRobust(dir);
        log.info(`[cache] pruned orphan hls dir ${e.name}`);
      } catch {
        /* ignore */
      }
    }
  }

  playlistPath(s: HlsSession): string {
    return path.join(s.dir, 'playlist.m3u8');
  }

  // ffmpeg пишет EVENT-плейлист во временный файл .tmp и атомарно переименовывает
  // его в .m3u8. На Windows этот rename может молча падать, и тогда свежий плейлист
  // остаётся только в .tmp. Поэтому читаем оба файла.
  private playlistFiles(s: HlsSession): string[] {
    const p = this.playlistPath(s);
    return [p, `${p}.tmp`];
  }

  // Асинхронно (без statSync): синхронный stat в цикле ожидания плейлиста на
  // каждом запросе бил по event loop при стойле. Результат кэшируем на 250мс.
  private async playlistReady(s: HlsSession): Promise<boolean> {
    const cached = this.playlistReadyCache.get(s.sessionId);
    const now = Date.now();
    if (cached && now - cached.at < 250) return cached.ready;
    let ready = false;
    for (const f of this.playlistFiles(s)) {
      try {
        if ((await fs.promises.stat(f)).size > 0) {
          ready = true;
          break;
        }
      } catch {
        /* not yet */
      }
    }
    this.playlistReadyCache.set(s.sessionId, { at: now, ready });
    return ready;
  }

  // Ждёт, пока ffmpeg запишет первый сегмент (плейлист станет непустым).
  // НЕ убиваем ffmpeg по таймауту: при перемотке в недокачанный регион первый
  // сегмент может появиться позже 20 с (ffmpeg ждёт байты feed'а). Убийство
  // превращало «медленный старт» в livelock stop/restart.
  async waitForPlaylist(s: HlsSession, timeoutMs = 20000): Promise<boolean> {
    const stopTimer = perf.timer('hls.firstSegment.ms');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.playlistReady(s)) {
        stopTimer();
        return true;
      }
      if (s.proc == null && s.state !== 'active') {
        // ffmpeg не запустился (остановка/ошибка) — ждать нечего.
        stopTimer();
        return false;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    stopTimer();
    return this.playlistReady(s);
  }

  // Возвращает самый полный из доступных плейлистов (по числу сегментов #EXTINF).
  async readPlaylist(s: HlsSession): Promise<string | null> {
    const contents = await Promise.all(
      this.playlistFiles(s).map((f) => fs.promises.readFile(f, 'utf8').catch(() => null)),
    );
    let best: string | null = null;
    let bestSegments = -1;
    for (const c of contents) {
      if (c == null || c.trim() === '') continue;
      const n = (c.match(/#EXTINF/g) ?? []).length;
      if (n > bestSegments) {
        bestSegments = n;
        best = c;
      }
    }
    return best;
  }

  // Сумма длительностей сегментов в плейлисте каталога (относительные секунды).
  private async scanPlaylist(dir: string): Promise<{ count: number; relSec: number }> {
    const paths = [path.join(dir, 'playlist.m3u8'), path.join(dir, 'playlist.m3u8.tmp')];
    let relSec = 0;
    let count = 0;
    for (const p of paths) {
      let content: string | null = null;
      try {
        content = await fs.promises.readFile(p, 'utf8');
      } catch {
        continue;
      }
      let t = 0;
      let c = 0;
      for (const m of content.matchAll(/#EXTINF:\s*([\d.]+)/g)) {
        const d = Number.parseFloat(m[1]);
        if (Number.isFinite(d)) {
          t += d;
          c++;
        }
      }
      if (c > count) {
        count = c;
        relSec = t;
      }
    }
    return { count, relSec };
  }

  // Сколько секунд уже перекодировано в конкретной сессии (относительно её старта).
  // Считаем по готовым сегментам на диске, а не по плейлисту: ffmpeg пишет плейлист
  // пачками/через .tmp, поэтому прогресс по плейлисту «скачет», а по seg-файлам — гладкий.
  async transcodedSeconds(
    topicId: number,
    fileIndex: number,
    audio: number | null,
    startSec: number,
    res: number | null,
    quality: number,
    gain: number,
    bitDepth: BitDepth,
  ): Promise<number | null> {
    const s = this.sessions.get(
      this.key(
        topicId,
        fileIndex,
        audio,
        roundStartSec(startSec),
        res,
        quality,
        clampGain(gain),
        clampBitDepth(bitDepth),
      ),
    );
    if (!s) return null;
    const count = await this.segmentCount(s.dir);
    const relSec = count * SEGMENT_SECONDS;
    s.transcodedEndSec = s.startSec + relSec;
    return count > 0 ? relSec : null;
  }

  private async segmentCount(dir: string): Promise<number> {
    let count = 0;
    try {
      const entries = await fs.promises.readdir(dir);
      for (const e of entries) {
        if (/^seg\d{5}\.m4s$/.test(e)) count++;
      }
    } catch {
      /* ignore */
    }
    return count;
  }

  segmentPath(s: HlsSession, name: string): string | null {
    if (name === 'init.mp4') {
      return path.join(s.dir, 'init.mp4');
    }
    if (/^seg\d{5}\.m4s$/.test(name)) {
      return path.join(s.dir, name);
    }
    return null;
  }

  async stopAll(): Promise<void> {
    const procs: ChildProcess[] = [];
    for (const [, s] of this.sessions) {
      if (s.proc) procs.push(s.proc);
      this.stopSession(s);
    }
    this.sessions.clear();
    this.byId.clear();
    this.activeByFile.clear();
    this.windowsCache.clear();
    clearInterval(this.keepAheadTimer);
    clearInterval(this.limiterTimer);
    this.limiter.reset();
    this.serveSamples = [];
    this.limiterMode = 'uncapped';
    this.playlistReadyCache.clear();
    this.encoderFailures.clear();
    for (const t of this.reusePending.values()) clearTimeout(t);
    this.reusePending.clear();
    this.readers.clear();
    this.progress.clear();
    this.speedPrev.clear();
    this.ratePrev.clear();
    this.playheads.clear();
    this.playheadAt.clear();
    this.playheadPaused.clear();
    await Promise.all(procs.map((p) => HlsManager.waitExit(p, 2000)));
  }
}
