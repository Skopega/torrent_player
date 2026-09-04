import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { DATA_DIR, rmDirRobust } from './store.js';
import { FFMPEG_PATH as ffmpegPath } from './media.js';
import { log } from './logger.js';
import { parseThumbDir, matchesKeep } from './cache-dirs.js';
import type { StreamManager } from './stream.js';

// Интервал между превью (секунды). Должен совпадать с константой на клиенте
// (web/src/components/Player.tsx), по которой time → index превью.
export const THUMB_INTERVAL_SEC = 10;
// Превью запускаются параллельно воспроизведению, только если транскод опережает
// playhead минимум на столько секунд — чтобы не отбирать ресурсы у плейбека.
export const THUMB_PARALLEL_SEC = 60;
const THUMB_WIDTH = 160;
const THUMB_DIR = path.join(DATA_DIR, 'cache', 'thumbnails');
const STREAM_BASE = 'http://127.0.0.1:3000';
const PROGRESS_LOG_MS = 15000;
const RESUME_CHECK_MS = 10000;
// Жёсткий потолок на один ffmpeg-процесс превью: если он завис (feed не качается,
// декодер зациклился и т.п.), убиваем — иначе глобальная генерация блокируется вечно.
const PROCESS_HARD_TIMEOUT_MS = 150_000;
// Сколько превью генерирует один ffmpeg-запуск (чанк таймлайна). Генерация идёт
// не одним линейным проходом всего файла, а сиками (-ss) от чанка к чанку: это
// позволяет (а) не читать файл целиком и (б) быстро переживать паузы — следующий
// чанк начинается с текущего покрытия, а не с нуля.
const CHUNK_COUNT = 12;
// Окно «ближайшего» превью для ховера: если точный слот ещё не сгенерирован,
// отдаём ближайший существующий в пределах ±этого числа слотов (±5 мин при шаге 10 с).
export const THUMB_NEAREST_WINDOW_SLOTS = 30;
// Сколько первых слотов не генерируем вовсе: самый первый кадр файла почти всегда
// чёрный (фейд из черноты/логотип), и он не должен быть «ближайшим» превью для
// первых минут таймлайна. Слот 0 = t∈[0,10) с, первый реальный кадр обычно уже на 10 с.
const THUMB_SKIP_FIRST_SLOTS = 1;

interface ThumbJob {
  proc: ChildProcess | null;
  dir: string;
  startedAt: number;
  timer: NodeJS.Timeout | null;
  cancelled: boolean;
  // Общее число слотов (ceil(duration/10)); 0 — длительность неизвестна.
  total: number;
  // Уже сгенерированные слоты (сидится с диска при старте/резюме, обновляется по ходу).
  slots: Set<number>;
}

// Причина приостановки генерации (null — можно генерировать).
export type PauseReasonFn = (topicId: number, fileIndex: number) => string | null;

// Точный байт (смещение в файле) позиции `sec` по MKV Cues (null — индекс не готов
// или файл не MKV). Используется, чтобы приоритизировать именно тот диапазон байт,
// который ffmpeg прочитает после -ss (по образцу HLS).
export type SeekByteForFn = (
  topicId: number,
  fileIndex: number,
  sec: number,
) => Promise<number | null>;

// Окно уже перекодированных HLS-сегментов файла: превью для времени внутри
// [startSec, endSec] можно извлечь из локальных сегментов (init.mp4 + seg%05d.m4s,
// длина segSec с) без повторного чтения исходника.
export interface TranscodeWindow {
  startSec: number;
  endSec: number;
  dir: string;
  segSec: number;
}

export type TranscodeWindowsFn = (
  topicId: number,
  fileIndex: number,
) => Promise<TranscodeWindow[]>;

// Фоновый генератор превьюшек (тамбнейлов). Читает исходный файл через тот же
// Direct Play поток (feed=1) и пишет по одному JPEG на каждые THUMB_INTERVAL_SEC.
// Декодирует ТОЛЬКО ключевые кадры (-skip_frame nokey + select через 10 с): это в
// десятки раз быстрее полного декодирования и не грузит CPU. `-threads 2`
// ограничивает нагрузку. Генерация идёт чанками с fast-seek (-ss): перед каждым
// чанком приоритизируются нужные куски (seek-индекс в хвосте + диапазон кластеров),
// поэтому не читается весь файл, а возобновление после паузы продолжается с уже
// сгенерированного покрытия (а не с нуля).
//
// Порядок генерации: сначала слоты в уже перекодированных HLS-окнах (около текущего
// просмотра) — они извлекаются из локальных сегментов бесплатно и без правила паузы,
// затем грубый проход по всему таймлайну (0%, 10%, 20%, …, 90%), мидпоинты и далее
// до плотного заполнения оставшихся слотов. Ховер показывает «ближайшее
// существующее превью» в окне ±THUMB_NEAREST_WINDOW_SLOTS.
//
// Адаптивность: если транскод HLS для этого файла отстаёт от playhead меньше чем
// на THUMB_PARALLEL_SEC — генерация ИЗ ИСХОДНИКА приостанавливается (приоритет —
// отзывчивость перемотки/плавность); извлечение из уже перекодированных сегментов
// при этом продолжается (локальный декод, не конкурирует с транскодом).
export class ThumbnailManager {
  private jobs = new Map<string, ThumbJob>();
  // Очередь файлов, ждущих свободный генератор (несколько разных файлов за раз).
  private pending: string[] = [];
  // Файлы, отложенные правилом параллельности (транскод отстал от playhead).
  private paused = new Set<string>();
  private resumeTimer: NodeJS.Timeout | null = null;
  // Кеш отсортированных слотов на файл для быстрого «ближайшего» превью (2-сек TTL).
  private slotCache = new Map<string, { at: number; slots: number[] }>();
  // Известное общее число слотов на файл (для /thumbnails/meta после завершения).
  private knownTotals = new Map<string, number>();

  constructor(
    private stream: StreamManager,
    private pauseReason?: PauseReasonFn,
    private seekByteFor?: SeekByteForFn,
    private transcodeWindows?: TranscodeWindowsFn,
  ) {}

  private key(topicId: number, fileIndex: number): string {
    return `${topicId}:${fileIndex}`;
  }

  private dirFor(topicId: number, fileIndex: number): string {
    return path.join(THUMB_DIR, `${topicId}_${fileIndex}`);
  }

  // Идемпотентный запуск генерации (fire-and-forget). Один поток на файл;
  // глобально держим не более одной активной ffmpeg-генерации.
  ensure(topicId: number, fileIndex: number): void {
    const key = this.key(topicId, fileIndex);
    if (this.jobs.has(key)) return;
    if (this.jobs.size > 0 || this.paused.has(key)) {
      // Одиночные слоты-«последний пришёл» теряли ранее отложенные файлы — храним
      // очередь, чтобы каждый дождался своего запуска.
      if (!this.pending.includes(key)) this.pending.push(key);
      this.scheduleResume();
      return;
    }
    this.tryStart(key);
    if (this.jobs.size === 0 && (this.pending.length || this.paused.size)) this.scheduleResume();
  }

  // Пытается запустить файл: если правило параллельности запрещает — кладёт в paused.
  private tryStart(key: string): boolean {
    const [a, b] = key.split(':').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    const reason = this.pauseReason?.(a, b) ?? null;
    if (reason) {
      log.info(`[thumbs] ${key} deferred (${reason})`);
      this.paused.add(key);
      return false;
    }
    this.startJob(a, b);
    return true;
  }

  private scheduleResume(): void {
    if (this.resumeTimer) return;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.drain();
    }, RESUME_CHECK_MS);
    this.resumeTimer.unref();
  }

  // Обрабатывает отложенные файлы, когда освободился единственный генератор:
  // сначала ждавшие слота (pending), затем приостановленные правилом (paused).
  private drain(): void {
    if (this.jobs.size > 0) {
      this.scheduleResume();
      return;
    }
    while (this.pending.length && this.jobs.size === 0) {
      const key = this.pending.shift()!;
      if (this.jobs.has(key) || this.paused.has(key)) continue;
      if (this.tryStart(key)) break;
    }
    if (this.jobs.size === 0 && this.paused.size > 0) {
      const key = this.paused.values().next().value as string;
      this.paused.delete(key);
      this.tryStart(key);
    }
    if (this.jobs.size === 0 && (this.pending.length || this.paused.size)) {
      this.scheduleResume();
    }
  }

  // Синхронный вход в джоб: кладём его в jobs до первых await, чтобы ensure() не
  // задублировал генерацию (jobs.size — глобальный лок на одну активную генерацию).
  // Дальше всё делает асинхронный runJob().
  private startJob(topicId: number, fileIndex: number): void {
    const key = this.key(topicId, fileIndex);
    if (this.jobs.has(key)) return;
    const dir = this.dirFor(topicId, fileIndex);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    const job: ThumbJob = {
      proc: null,
      dir,
      startedAt: Date.now(),
      timer: null,
      cancelled: false,
      total: 0,
      slots: new Set(),
    };
    this.jobs.set(key, job);
    void this.runJob(topicId, fileIndex, job);
  }

  // Цикл генерации. Сначала — иерархические (грубые) проходы: 0%, 10%, 20%, …, 90%,
  // затем мидпоинты 5%, 15%, … и так далее, пока шаг не станет ≤ CHUNK_COUNT слотов.
  // После этого — сплошное заполнение оставшихся слотов чанками (текущий runChunk).
  // Каждый шаг: приоритизируем нужный диапазон байт (seek-индекс в хвосте + кластеры
  // по Cues/оценке), ждём его куски и запускаем ffmpeg с -ss к цели. Возобновление
  // после паузы автоматическое: следующий слот считается по иерархии из того, что
  // уже лежит на диске (job.slots сидится с диска при старте).
  private async runJob(topicId: number, fileIndex: number, job: ThumbJob): Promise<void> {
    const key = this.key(topicId, fileIndex);
    if (!ffmpegPath) {
      log.warn(`[thumbs] ffmpeg не найден — превью отключены`);
      if (job.timer) clearInterval(job.timer);
      job.timer = null;
      this.jobs.delete(key);
      // Дать шанс другим ожидающим (иначе очередь «зависнет» до следующего ensure).
      this.drain();
      return;
    }
    try {
      const { file } = await this.stream.getFile(topicId, fileIndex);
      if (file.length <= 0) {
        this.finishJob(topicId, fileIndex, job);
        return;
      }
      const media = await this.stream.probe(topicId, fileIndex);
      const duration = media.durationSec && media.durationSec > 0 ? media.durationSec : 0;
      job.total = duration > 0 ? Math.ceil(duration / THUMB_INTERVAL_SEC) : 0;
      this.knownTotals.set(key, job.total);
      this.seedSlots(topicId, fileIndex, job);
      // Первые слоты (чёрный стартовый кадр) не генерируем — помечаем как готовые.
      for (let s = 0; s < THUMB_SKIP_FIRST_SLOTS; s++) job.slots.add(s);

      // Seek-индекс (MKV Cues / MP4 moov / AVI idx1) лежит в хвосте файла: без него
      // -ss делает полный проход. Поднимаем приоритет хвоста один раз на весь джоб.
      try {
        await this.stream.prioritizeTail(topicId, fileIndex);
      } catch {
        /* ignore */
      }

      log.info(
        `[thumbs] ${key} generating (interval=${THUMB_INTERVAL_SEC}s, chunks=${CHUNK_COUNT}, total=${job.total} slots, hierarchical, keyframes only)`,
      );

      let failures = 0;
      while (!job.cancelled) {
        const target = await this.nextTarget(topicId, fileIndex, job);
        if (target === null) break;

        let kind = target.kind;
        const slot = target.slot;

        if (kind === 'hls' && target.window) {
          // Бесплатно из уже перекодированных HLS-сегментов — без правила паузы
          // (локальный декод, не отбирает ни канал, ни CPU у транскода).
          const startSec = slot * THUMB_INTERVAL_SEC;
          const outcome = await this.runTargetFromHls(
            topicId,
            fileIndex,
            job,
            slot,
            startSec,
            target.window,
          );
          if (job.cancelled) break;
          if (outcome === 'ok') {
            job.slots.add(slot);
            this.noteSlots(topicId, fileIndex, [slot]);
            continue;
          }
          log.info(`[thumbs] ${key} HLS unavailable @${startSec}s, falling back to source`);
          kind = 'sparse';
        }

        // Дальше — исходник: только когда транскод не отстаёт (правило паузы).
        const reason = this.pauseReason?.(topicId, fileIndex) ?? null;
        if (reason) {
          log.info(`[thumbs] ${key} deferred (${reason})`);
          job.cancelled = true;
          break;
        }

        if (kind === 'sparse') {
          // Грубый проход: одиночный кадр в конкретный слот.
          const startSec = slot * THUMB_INTERVAL_SEC;
          const ok = await this.prepareChunk(topicId, fileIndex, job, startSec, file.length, duration);
          if (job.cancelled) break;
          if (!ok) {
            failures++;
            if (failures >= 3) {
              log.warn(`[thumbs] ${key} target @${startSec}s: bytes not ready, aborting`);
              break;
            }
            await this.delay(2000);
            continue;
          }
          failures = 0;
          const outcome = await this.runTarget(topicId, fileIndex, job, slot);
          if (job.cancelled || outcome === 'paused') break;
          if (outcome === 'error') {
            failures++;
            if (failures >= 3) {
              log.warn(`[thumbs] ${key} repeated target errors, aborting`);
              break;
            }
            await this.delay(1000);
            continue;
          }
          // Код 0 не гарантирует запись кадра (например, -ss за конец файла) —
          // не помечаем «дыру» готовой, а завершаем проход.
          const targetFile = path.join(job.dir, `thumb${String(slot).padStart(6, '0')}.jpg`);
          if (!fs.existsSync(targetFile)) {
            log.info(`[thumbs] ${key} no frame written @${startSec}s (end of stream)`);
            break;
          }
          job.slots.add(slot);
          this.noteSlots(topicId, fileIndex, [slot]);
        } else {
          // Плотная фаза / фолбэк без длительности: непрерывный прогон пропущенных
          // слотов (не затираем уже сделанные из HLS/грубых проходов).
          const startIndex = slot;
          const cap = job.total > 0 ? job.total : Number.POSITIVE_INFINITY;
          let endIndex = startIndex + 1;
          while (endIndex < cap && endIndex - startIndex < CHUNK_COUNT && !job.slots.has(endIndex)) {
            endIndex++;
          }
          const startSec = startIndex * THUMB_INTERVAL_SEC;
          const ok = await this.prepareChunk(topicId, fileIndex, job, startSec, file.length, duration);
          if (job.cancelled) break;
          if (!ok) {
            failures++;
            if (failures >= 3) {
              log.warn(`[thumbs] ${key} chunk @${startSec}s: bytes not ready, aborting`);
              break;
            }
            await this.delay(2000);
            continue;
          }
          failures = 0;

          const prevCov = this.coverage(topicId, fileIndex);
          const outcome = await this.runChunk(topicId, fileIndex, job, startSec, startIndex, endIndex);
          if (job.cancelled || outcome === 'paused') break;
          if (outcome === 'error') {
            failures++;
            if (failures >= 3) {
              log.warn(`[thumbs] ${key} repeated chunk errors, aborting`);
              break;
            }
            await this.delay(1000);
            continue;
          }
          // ffmpeg может выйти с кодом 0, записав меньше кадров, чем просили
          // (EOF/обрезанный хвост) — помечаем готовыми только реально созданные файлы.
          const written = this.slotsOnDiskInRange(job.dir, startIndex, endIndex);
          for (const s of written) job.slots.add(s);
          this.noteSlots(topicId, fileIndex, written);
          const cov = this.coverage(topicId, fileIndex);
          if (written.length === 0 || cov <= prevCov) {
            log.info(`[thumbs] ${key} reached end of stream (coverage=${cov})`);
            break;
          }
        }
      }

      this.finishJob(topicId, fileIndex, job);
    } catch (e) {
      log.warn(`[thumbs] ${key} generation failed: ${e instanceof Error ? e.message : e}`);
      this.finishJob(topicId, fileIndex, job);
    }
  }

  // Сидит job.slots с диска (резюме после паузы/рестарта). Слот = номер файла thumbXXXXXX.
  private seedSlots(topicId: number, fileIndex: number, job: ThumbJob): void {
    const dir = this.dirFor(topicId, fileIndex);
    job.slots.clear();
    try {
      for (const e of fs.readdirSync(dir)) {
        const m = /^thumb(\d{6})\.jpg$/.exec(e);
        if (m) job.slots.add(Number(m[1]));
      }
    } catch {
      /* нет каталога */
    }
  }

  // Фактически записанные файлы-слоты в [from, to).
  private slotsOnDiskInRange(dir: string, from: number, to: number): number[] {
    const out: number[] = [];
    try {
      for (const e of fs.readdirSync(dir)) {
        const m = /^thumb(\d{6})\.jpg$/.exec(e);
        if (m) {
          const n = Number(m[1]);
          if (n >= from && n < to) out.push(n);
        }
      }
    } catch {
      /* нет каталога */
    }
    return out.sort((a, b) => a - b);
  }

  // Следующая цель генерации:
  // 1) слоты в уже перекодированных HLS-окнах (бесплатно, из локальных сегментов);
  // 2) грубые проходы (0%,10%,…; мидпоинты) из исходника;
  // 3) первый незаполненный слот (плотная фаза). null — всё готово.
  // При неизвестной длительности — линейный режим от текущего coverage (kind dense).
  private async nextTarget(
    topicId: number,
    fileIndex: number,
    job: ThumbJob,
  ): Promise<{ slot: number; kind: 'hls' | 'sparse' | 'dense'; window?: TranscodeWindow } | null> {
    const N = job.total;
    if (N > 0) {
      if (this.transcodeWindows) {
        let windows: TranscodeWindow[] = [];
        try {
          windows = await this.transcodeWindows(topicId, fileIndex);
        } catch {
          windows = [];
        }
        for (const w of windows) {
          const first = Math.max(
            THUMB_SKIP_FIRST_SLOTS,
            Math.ceil(w.startSec / THUMB_INTERVAL_SEC),
          );
          const last = Math.min(N - 1, Math.floor(w.endSec / THUMB_INTERVAL_SEC));
          for (let s = first; s <= last; s++) {
            if (!job.slots.has(s)) return { slot: s, kind: 'hls', window: w };
          }
        }
      }
      for (let d = 10; d < N; d *= 2) {
        const step = Math.max(1, Math.round(N / d));
        if (step <= CHUNK_COUNT) break;
        for (let k = 0; k < d; k++) {
          const slot = Math.min(N - 1, Math.round((k * N) / d));
          if (!job.slots.has(slot)) return { slot, kind: 'sparse' };
        }
      }
      for (let s = 0; s < N; s++) {
        if (!job.slots.has(s)) return { slot: s, kind: 'dense' };
      }
      return null;
    }
    return {
      slot: Math.max(THUMB_SKIP_FIRST_SLOTS, this.coverage(topicId, fileIndex)),
      kind: 'dense',
    };
  }

  // Свежие слоты в кеш «ближайшего» превью, чтобы ховер сразу видел новые кадры.
  private noteSlots(topicId: number, fileIndex: number, slots: number[]): void {
    const key = this.key(topicId, fileIndex);
    const entry = this.slotCache.get(key);
    if (!entry || slots.length === 0) return;
    for (const s of slots) {
      if (!entry.slots.includes(s)) {
        entry.slots.push(s);
        entry.slots.sort((a, b) => a - b);
      }
    }
    entry.at = Date.now();
  }

  // Готовит байты чанка: по точному кластеру (MKV Cues) или оценке frac*size
  // приоритизирует диапазон и коротко ждёт его куски, чтобы ffmpeg не блокировался.
  // Возвращает false только при ошибке планировщика (не при таймауте ожидания —
  // тогда ffmpeg просто дочитает куски с backpressure).
  private async prepareChunk(
    topicId: number,
    fileIndex: number,
    job: ThumbJob,
    startSec: number,
    fileLen: number,
    duration: number,
  ): Promise<boolean> {
    const key = this.key(topicId, fileIndex);
    const exactByte = this.seekByteFor
      ? await this.seekByteFor(topicId, fileIndex, startSec).catch(() => null)
      : null;
    const marginBack = 4 * 1024 * 1024;
    const windowForward = 16 * 1024 * 1024;
    let bs: number;
    let be: number;
    if (exactByte != null) {
      bs = Math.max(0, exactByte - marginBack);
      be = Math.min(fileLen - 1, exactByte + windowForward);
    } else {
      const dur = duration > 0 ? duration : 1;
      const frac = Math.min(1, Math.max(0, startSec / dur));
      bs = Math.floor(frac * fileLen);
      be = Math.min(fileLen - 1, bs + windowForward);
    }
    try {
      await this.stream.prioritizeRange(topicId, fileIndex, bs, be);
      const ready = await this.stream.waitForBytes(
        topicId,
        fileIndex,
        bs,
        Math.min(be, bs + 8 * 1024 * 1024),
        15000,
      );
      if (!ready) {
        log.warn(`[thumbs] ${key} waitForBytes @${startSec}s timed out (byte ${bs})`);
      }
      return true;
    } catch (e) {
      log.warn(`[thumbs] ${key} prepare @${startSec}s failed: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  // Запускает ffmpeg для одного чанка: -ss (fast-seek) к началу, select отбрасывает
  // кадры раньше startSec и держит интервал THUMB_INTERVAL_SEC, -frames:v ограничивает
  // вывод числом превью чанка, -start_number продолжает нумерацию с текущего покрытия.
  private runChunk(
    topicId: number,
    fileIndex: number,
    job: ThumbJob,
    startSec: number,
    startIndex: number,
    endIndex: number,
  ): Promise<'ok' | 'paused' | 'error'> {
    const key = this.key(topicId, fileIndex);
    const input = `${STREAM_BASE}/api/topic/${topicId}/stream/${fileIndex}?feed=1`;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '2',
      '-y',
      // Декодируем только ключевые кадры (в ~50× меньше работы для H.264/HEVC),
      // а select берёт их не чаще чем раз в THUMB_INTERVAL_SEC. NB: после -ss как
      // входной опции ffmpeg делает fast-seek к ключевому кадру и ПТС перебазируются
      // на 0, поэтому gating по абсолютному времени здесь не работает — и не нужен:
      // select даёт ровный шаг 10 с от точки входа чанка (смещение ≤ интервала
      // ключевых кадров, для превью незаметно).
      '-skip_frame',
      'nokey',
      '-ss',
      String(startSec),
      '-i',
      input,
      '-an',
      '-sn',
      '-vf',
      `select='isnan(prev_selected_t)+gte(t,prev_selected_t+${THUMB_INTERVAL_SEC})',scale=${THUMB_WIDTH}:-2`,
      '-vsync',
      'vfr',
      '-q:v',
      '6',
      '-frames:v',
      String(endIndex - startIndex),
      '-start_number',
      String(startIndex),
      '-f',
      'image2',
      'thumb%06d.jpg',
    ];

    return new Promise<'ok' | 'paused' | 'error'>((resolve) => {
      // ffmpegPath гарантированно не null: runJob() проверяет его до цикла чанков.
      const proc = spawn(ffmpegPath!, args, {
        cwd: job.dir,
        stdio: ['ignore', 'ignore', 'pipe'],
      }) as ChildProcess;
      job.proc = proc;

      let stderr = '';
      proc.stderr?.on('data', (d) => {
        stderr = (stderr + d.toString()).slice(-2000);
      });

      const timer = this.armProgressTimer(topicId, fileIndex, job, proc);
      job.timer = timer;

      const finish = (outcome: 'ok' | 'paused' | 'error'): void => {
        clearInterval(timer);
        if (job.timer === timer) job.timer = null;
        if (job.proc === proc) job.proc = null;
        resolve(outcome);
      };

      proc.on('error', (err) => {
        log.warn(`[thumbs] ${key} spawn error: ${err.message}`);
        finish('error');
      });
      proc.on('close', (code) => {
        if (job.cancelled) {
          finish('paused');
          return;
        }
        if (code === 0) {
          finish('ok');
          return;
        }
        const cov = this.coverage(topicId, fileIndex);
        log.warn(
          `[thumbs] ${key} chunk @${startSec}s exit ${code} coverage=${cov}: ${stderr.trim().slice(0, 300)}`,
        );
        finish('error');
      });
    });
  }

  // Извлекает один кадр в конкретный слот (грубый проход): -ss к времени слота,
  // -frames:v 1, -start_number = слот. Байты слота уже приоритизированы prepareChunk.
  private runTarget(
    topicId: number,
    fileIndex: number,
    job: ThumbJob,
    slot: number,
  ): Promise<'ok' | 'paused' | 'error'> {
    const key = this.key(topicId, fileIndex);
    const startSec = slot * THUMB_INTERVAL_SEC;
    const input = `${STREAM_BASE}/api/topic/${topicId}/stream/${fileIndex}?feed=1`;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '2',
      '-y',
      '-skip_frame',
      'nokey',
      '-ss',
      String(startSec),
      '-i',
      input,
      '-an',
      '-sn',
      '-vf',
      `select='isnan(prev_selected_t)+gte(t,prev_selected_t+${THUMB_INTERVAL_SEC})',scale=${THUMB_WIDTH}:-2`,
      '-vsync',
      'vfr',
      '-q:v',
      '6',
      '-frames:v',
      '1',
      '-start_number',
      String(slot),
      '-f',
      'image2',
      'thumb%06d.jpg',
    ];

    return new Promise<'ok' | 'paused' | 'error'>((resolve) => {
      // ffmpegPath гарантированно не null: runJob() проверяет его до цикла генерации.
      const proc = spawn(ffmpegPath!, args, {
        cwd: job.dir,
        stdio: ['ignore', 'ignore', 'pipe'],
      }) as ChildProcess;
      job.proc = proc;

      let stderr = '';
      proc.stderr?.on('data', (d) => {
        stderr = (stderr + d.toString()).slice(-2000);
      });

      const timer = this.armProgressTimer(topicId, fileIndex, job, proc);
      job.timer = timer;

      const finish = (outcome: 'ok' | 'paused' | 'error'): void => {
        clearInterval(timer);
        if (job.timer === timer) job.timer = null;
        if (job.proc === proc) job.proc = null;
        resolve(outcome);
      };

      proc.on('error', (err) => {
        log.warn(`[thumbs] ${key} spawn error: ${err.message}`);
        finish('error');
      });
      proc.on('close', (code) => {
        if (job.cancelled) {
          finish('paused');
          return;
        }
        if (code === 0) {
          finish('ok');
          return;
        }
        log.warn(
          `[thumbs] ${key} target @${startSec}s exit ${code}: ${stderr.trim().slice(0, 300)}`,
        );
        finish('error');
      });
    });
  }

  // Извлекает кадр для слота из уже перекодированного HLS-сегмента (init.mp4 +
  // seg%05d.m4s, cwd = dir окна). Слот t=slot*10 кратен 2 с → попадает на границу
  // сегмента, кадр = первый кадр сегмента. Локальный декод ~10 мс, без чтения
  // исходника/ожидания байт. 'error' (в т.ч. сегмент ещё не дописан) → фолбэк на исходник.
  private runTargetFromHls(
    topicId: number,
    fileIndex: number,
    job: ThumbJob,
    slot: number,
    t: number,
    window: TranscodeWindow,
  ): Promise<'ok' | 'paused' | 'error'> {
    const key = this.key(topicId, fileIndex);
    const rel = t - window.startSec;
    if (!(rel >= 0) || !(window.segSec > 0)) return Promise.resolve('error');
    const segIdx = Math.floor(rel / window.segSec);
    const segPath = path.join(window.dir, `seg${String(segIdx).padStart(5, '0')}.m4s`);
    const initPath = path.join(window.dir, 'init.mp4');
    if (!fs.existsSync(initPath) || !fs.existsSync(segPath)) {
      return Promise.resolve('error');
    }
    const outPath = path.join(job.dir, `thumb${String(slot).padStart(6, '0')}.jpg`);
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-an',
      '-i',
      `concat:init.mp4|${path.basename(segPath)}`,
      '-frames:v',
      '1',
      '-q:v',
      '6',
      '-f',
      'image2',
      outPath,
    ];
    return new Promise<'ok' | 'paused' | 'error'>((resolve) => {
      // ffmpegPath гарантированно не null: runJob() проверяет его до цикла генерации.
      const proc = spawn(ffmpegPath!, args, {
        cwd: window.dir,
        stdio: ['ignore', 'ignore', 'pipe'],
      }) as ChildProcess;
      job.proc = proc;
      let stderr = '';
      proc.stderr?.on('data', (d) => {
        stderr = (stderr + d.toString()).slice(-2000);
      });
      const finish = (outcome: 'ok' | 'paused' | 'error'): void => {
        if (job.proc === proc) job.proc = null;
        resolve(outcome);
      };
      proc.on('error', (err) => {
        log.warn(`[thumbs] ${key} hls spawn error: ${err.message}`);
        finish('error');
      });
      proc.on('close', (code) => {
        if (job.cancelled) {
          finish('paused');
          return;
        }
        if (code === 0 && fs.existsSync(outPath)) {
          finish('ok');
          return;
        }
        log.warn(
          `[thumbs] ${key} hls extract @${t}s exit ${code}: ${stderr.trim().slice(0, 200)}`,
        );
        finish('error');
      });
    });
  }

  // Общий таймер прогресса + проверка правила параллельности (пауза, если транскод
  // перестал опережать playhead). Вызывается на время жизни одного ffmpeg-процесса.
  private armProgressTimer(
    topicId: number,
    fileIndex: number,
    job: ThumbJob,
    proc: ChildProcess,
  ): NodeJS.Timeout {
    const key = this.key(topicId, fileIndex);
    const procStart = Date.now();
    const timer = setInterval(() => {
      const cov = this.coverage(topicId, fileIndex);
      const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(0);
      log.info(
        `[thumbs] ${key} progress coverage=${cov}/${job.total > 0 ? job.total : '?'} (${cov * THUMB_INTERVAL_SEC}s) elapsed=${elapsed}s`,
      );
      // Правило параллельности: транскод перестал опережать playhead — пауза.
      const reason = this.pauseReason?.(topicId, fileIndex) ?? null;
      if (reason) {
        log.info(`[thumbs] ${key} pausing (${reason})`);
        job.cancelled = true;
        clearInterval(timer);
        job.timer = null;
        try { proc.kill(); } catch { /* ignore */ }
        return;
      }
      // Сторож от зависшего ffmpeg (нет причины для паузы, но процесс «висит»).
      if (Date.now() - procStart > PROCESS_HARD_TIMEOUT_MS) {
        log.warn(`[thumbs] ${key} ffmpeg stuck >${PROCESS_HARD_TIMEOUT_MS / 1000}s — killing`);
        job.cancelled = true;
        clearInterval(timer);
        job.timer = null;
        try { proc.kill(); } catch { /* ignore */ }
      }
    }, PROGRESS_LOG_MS);
    timer.unref();
    return timer;
  }

  // Завершает джоб: если он остановлен извне (stopTopic/stopAll) — просто выходит;
  // если приостановлен (cancelled) — ставит в очередь на возобновление; иначе —
  // лог успеха и запуск следующего отложенного файла.
  private finishJob(topicId: number, fileIndex: number, job: ThumbJob): void {
    const key = this.key(topicId, fileIndex);
    if (job.timer) clearInterval(job.timer);
    job.timer = null;
    const wasActive = this.jobs.has(key);
    if (wasActive) this.jobs.delete(key);
    if (!wasActive) return; // остановлен извне
    if (job.cancelled) {
      // Приостановлен правилом параллельности — вернёмся, когда правило отпустит.
      this.paused.add(key);
      this.scheduleResume();
      return;
    }
    const cov = this.coverage(topicId, fileIndex);
    log.info(
      `[thumbs] ${key} done coverage=${cov} (${cov * THUMB_INTERVAL_SEC}s) elapsed=${((Date.now() - job.startedAt) / 1000).toFixed(0)}s`,
    );
    this.drain();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Валидирует имя файла превью и возвращает его абсолютный путь (null — иначе).
  thumbPath(topicId: number, fileIndex: number, name: string): string | null {
    if (!/^thumb\d{6}\.jpg$/.test(name)) return null;
    return path.join(this.dirFor(topicId, fileIndex), name);
  }

  // Прогрессивное покрытие: сколько превью уже сгенерировано (0..N).
  coverage(topicId: number, fileIndex: number): number {
    const dir = this.dirFor(topicId, fileIndex);
    let count = 0;
    try {
      for (const e of fs.readdirSync(dir)) {
        if (/^thumb\d{6}\.jpg$/.test(e)) count++;
      }
    } catch {
      /* нет каталога */
    }
    return count;
  }

  // Общее число слотов файла (null, пока длительность неизвестна). Берётся из
  // активного джоба или из кеша завершённых.
  total(topicId: number, fileIndex: number): number | null {
    const key = this.key(topicId, fileIndex);
    const job = this.jobs.get(key);
    if (job && job.total > 0) return job.total;
    const known = this.knownTotals.get(key);
    return known != null && known > 0 ? known : null;
  }

  // Ближайший уже сгенерированный слот в окне [index-windowSlots, index+windowSlots]
  // (для ховера: отдаём ближайшее готовое превью, если точного ещё нет).
  // null — в окне пусто или нет вообще ни одного кадра.
  nearestSlot(
    topicId: number,
    fileIndex: number,
    index: number,
    windowSlots: number,
  ): number | null {
    const key = this.key(topicId, fileIndex);
    let slots: number[];
    const cached = this.slotCache.get(key);
    if (cached && Date.now() - cached.at < 2000) {
      slots = cached.slots;
    } else {
      const dir = this.dirFor(topicId, fileIndex);
      const scanned: number[] = [];
      try {
        for (const e of fs.readdirSync(dir)) {
          const m = /^thumb(\d{6})\.jpg$/.exec(e);
          if (m) scanned.push(Number(m[1]));
        }
      } catch {
        /* нет каталога */
      }
      scanned.sort((a, b) => a - b);
      this.slotCache.set(key, { at: Date.now(), slots: scanned });
      slots = scanned;
    }
    if (slots.length === 0) return null;

    const lo = Math.max(0, index - windowSlots);
    const hi = index + windowSlots;
    // Бинарный поиск первой позиции >= lo (lower bound).
    let l = 0;
    let r = slots.length;
    while (l < r) {
      const mid = (l + r) >> 1;
      if (slots[mid] < lo) l = mid + 1;
      else r = mid;
    }
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = l; i < slots.length && slots[i] <= hi; i++) {
      const dist = Math.abs(slots[i] - index);
      if (dist < bestDist) {
        bestDist = dist;
        best = slots[i];
      }
    }
    return best >= 0 ? best : null;
  }

  // Для диагностики: активные/ожидающие генерации и их покрытие.
  jobsSnapshot(): Array<{
    topicId: number;
    fileIndex: number;
    coverage: number;
    running: boolean;
  }> {
    const out: Array<{
      topicId: number;
      fileIndex: number;
      coverage: number;
      running: boolean;
    }> = [];
    const seen = new Set<string>();
    for (const key of this.jobs.keys()) {
      const [topicId, fileIndex] = key.split(':').map(Number);
      out.push({
        topicId,
        fileIndex,
        coverage: this.coverage(topicId, fileIndex),
        running: true,
      });
      seen.add(key);
    }
    for (const key of this.pending) {
      if (seen.has(key)) continue;
      const [topicId, fileIndex] = key.split(':').map(Number);
      if (Number.isFinite(topicId) && Number.isFinite(fileIndex)) {
        out.push({ topicId, fileIndex, coverage: this.coverage(topicId, fileIndex), running: false });
        seen.add(key);
      }
    }
    for (const key of this.paused) {
      if (seen.has(key)) continue;
      const [topicId, fileIndex] = key.split(':').map(Number);
      if (Number.isFinite(topicId) && Number.isFinite(fileIndex)) {
        out.push({ topicId, fileIndex, coverage: this.coverage(topicId, fileIndex), running: false });
      }
    }
    return out;
  }

  private stopJob(job: ThumbJob): void {
    job.cancelled = true;
    if (job.timer) clearInterval(job.timer);
    job.timer = null;
    if (job.proc) {
      try {
        job.proc.kill();
      } catch {
        /* ignore */
      }
    }
  }

  // Убирает из очередей (pending/paused) файлы, удовлетворяющие предикату.
  private pruneQueued(shouldRemove: (topicId: number, fileIndex: number) => boolean): void {
    this.pending = this.pending.filter((key) => {
      const [a, b] = key.split(':').map(Number);
      return !(Number.isFinite(a) && Number.isFinite(b) && shouldRemove(a, b));
    });
    for (const key of [...this.paused]) {
      const [a, b] = key.split(':').map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && shouldRemove(a, b)) this.paused.delete(key);
    }
  }

  stopTopic(topicId: number): void {
    for (const [key, job] of this.jobs) {
      if (key.startsWith(`${topicId}:`)) {
        this.stopJob(job);
        this.jobs.delete(key);
        this.slotCache.delete(key);
        this.knownTotals.delete(key);
      }
    }
    this.pruneQueued((a) => a === topicId);
  }

  stopFile(topicId: number, fileIndex: number): void {
    const key = this.key(topicId, fileIndex);
    const job = this.jobs.get(key);
    if (job) {
      this.stopJob(job);
      this.jobs.delete(key);
    }
    this.pruneQueued((a, b) => a === topicId && b === fileIndex);
    this.slotCache.delete(key);
    this.knownTotals.delete(key);
  }

  stopAll(): void {
    for (const [, job] of this.jobs) this.stopJob(job);
    this.jobs.clear();
    this.pending = [];
    this.paused.clear();
    this.slotCache.clear();
    this.knownTotals.clear();
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }

  // Удаляет кеш превью всех видео, кроме указанного (аналогично hls.removeCacheExcept).
  // keepFileIndex === null — сохраняем все файлы этого топика; иначе — только один файл.
  removeCacheExcept(keepTopicId: number, keepFileIndex: number | null): void {
    const keep = (topicId: number, fileIndex: number) =>
      matchesKeep({ topicId, fileIndex }, keepTopicId, keepFileIndex);

    for (const [key, job] of this.jobs) {
      const [a, b] = key.split(':').map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && keep(a, b)) continue;
      this.stopJob(job);
      this.jobs.delete(key);
      this.slotCache.delete(key);
      this.knownTotals.delete(key);
      try {
        rmDirRobust(job.dir);
        log.info(`[cache] pruned thumbs dir ${job.dir}`);
      } catch {
        /* ignore */
      }
    }
    this.pruneQueued((a, b) => !keep(a, b));

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(THUMB_DIR, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const ref = parseThumbDir(e.name);
      if (ref && keep(ref.topicId, ref.fileIndex)) continue;
      try {
        rmDirRobust(path.join(THUMB_DIR, e.name));
        log.info(`[cache] pruned orphan thumbs dir ${e.name}`);
      } catch {
        /* ignore */
      }
    }
  }
}
