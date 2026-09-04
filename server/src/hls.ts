import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { DATA_DIR, rmDirRobust } from './store.js';
import { FFMPEG_PATH as ffmpegPath } from './media.js';
import { log } from './logger.js';
import { perf } from './perf.js';
import { getEncoder, getEncoderFallback, type EncoderConfig } from './encoder.js';
import { Priority } from './scheduler.js';
import { parseHlsDir, matchesKeep } from './cache-dirs.js';
import type { StreamManager } from './stream.js';
import type { SubtitleManager } from './subs.js';
import type { MediaInfo } from './types.js';

const HLS_DIR = path.join(DATA_DIR, 'cache', 'hls');
const STREAM_BASE = 'http://127.0.0.1:3000';

// Сегменты 2 с (закрытый GOP в транскоде) — точная перемотка и быстрый seek.
const SEGMENT_SECONDS = 2;
// Лимит суммарного дискового кеша HLS (сегменты не удаляются при seek, поэтому
// нужен потолок — иначе remux до EOF быстро забьёт диск).
const HLS_MAX_BYTES = 20 * 1024 * 1024 * 1024;

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
}

interface HlsSession {
  sessionId: string;
  topicId: number;
  fileIndex: number;
  audio: number | null;
  startSec: number; // абсолютная секунда, округлённая до границы сегмента
  res: number | null;
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
  private keepAheadTimer: NodeJS.Timeout;

  constructor(
    private stream: StreamManager,
    private subs: SubtitleManager,
  ) {
    // Пока ffmpeg транскодит, держим приоритет байт исходника впереди головы
    // транскода (feed читает последовательно; без этого он встаёт на каждом куске).
    this.keepAheadTimer = setInterval(() => void this.keepAhead(), 4000);
    this.keepAheadTimer.unref();
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
  ): string {
    return `${topicId}:${fileIndex}:${audio ?? ''}:${startSec}:${res ?? ''}`;
  }

  private fileKey(topicId: number, fileIndex: number): string {
    return `${topicId}:${fileIndex}`;
  }

  private sessionKey(s: HlsSession): string {
    return this.key(s.topicId, s.fileIndex, s.audio, s.startSec, s.res);
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
    const entries = [...this.sessions.entries()].map(([key, s]) => ({
      key,
      dir: s.dir,
      startedAt: s.startedAt,
      active: this.activeByFile.get(this.fileKey(s.topicId, s.fileIndex)) === key,
    }));
    let total = 0;
    for (const e of entries) total += await dirSizeAsync(e.dir);
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
      if (s) this.byId.delete(s.sessionId);
      this.sessions.delete(e.key);
      total -= size;
    }
  }

  async start(topicId: number, fileIndex: number, opts: HlsStartOptions = {}): Promise<HlsSession> {
    const audio = opts.audio === undefined ? null : opts.audio;
    const res = opts.res && opts.res > 0 ? opts.res : null;
    const startSec = roundStartSec(opts.startSec ?? 0);
    const key = this.key(topicId, fileIndex, audio, startSec, res);
    const fkey = this.fileKey(topicId, fileIndex);

    // Два одновременных start() на один ключ не должны создавать две сессии/ffmpeg.
    const inflight = this.inFlight.get(key);
    if (inflight) return inflight;
    const p = this.startInternal(topicId, fileIndex, audio, res, startSec, key, fkey);
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
    startSec: number,
    key: string,
    fkey: string,
  ): Promise<HlsSession> {
    const startTimer = perf.timer('hls.start.ms');

    // Останавливаем ffmpeg остальных сессий этого файла (CPU), но каталоги кеша НЕ удаляем:
    // повторная перемотка в ту же позицию достанет сегменты из кеша мгновенно.
    this.stopOthers(topicId, fileIndex, key);

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

    const dir = path.join(HLS_DIR, `${topicId}_${fileIndex}_${audio ?? 'def'}_${startSec}_${res ?? 'full'}`);
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
      // реальный кластер и коротко ждём его, чтобы ffmpeg не блокировался.
      const exactByte =
        file.length > 0 ? await this.subs.seekByteFor(topicId, fileIndex, startSec).catch(() => null) : null;
      if (exactByte != null) {
        const marginBack = 4 * 1024 * 1024; // ключевой кадр до позиции
        const windowForward = 16 * 1024 * 1024;
        const bs = Math.max(0, exactByte - marginBack);
        const be = Math.min(file.length - 1, exactByte + windowForward);
        try {
          await this.stream.prioritizeRange(topicId, fileIndex, bs, be);
          await this.stream.waitForBytes(topicId, fileIndex, bs, Math.min(be, bs + 8 * 1024 * 1024), 8000);
        } catch {
          /* ignore */
        }
        log.info(`[hls] ${topicId}:${fileIndex} precise seek @${startSec}s -> byte ${exactByte}`);
      } else if (dur > 0 && file.length > 0) {
        const frac = Math.min(1, startSec / dur);
        const byteStart = Math.floor(frac * file.length);
        const byteEnd = Math.min(file.length - 1, byteStart + 8 * 1024 * 1024);
        try {
          await this.stream.prioritizeRange(topicId, fileIndex, byteStart, byteEnd);
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
      const headReady = await this.stream
        .areBytesReady(topicId, fileIndex, approx, Math.min(file.length - 1, approx + 2 * 1024 * 1024))
        .catch(() => false);
      const tailStart = Math.max(0, file.length - 4 * 1024 * 1024);
      const tailReady = await this.stream
        .areBytesReady(topicId, fileIndex, tailStart, file.length - 1)
        .catch(() => false);
      log.info(
        `[hls] diag start=${startSec}s approxByte=${approx} headReady=${headReady} tailReady=${tailReady} readers=${this.readers.get(session.sessionId) ?? 0}`,
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
      const end = s.transcodedEndSec;
      const pt = this.progress.get(s.sessionId);
      if (pt) {
        if (end > pt.end) {
          pt.end = end;
          pt.at = Date.now();
          pt.warned = false;
        } else if (!pt.warned && Date.now() - pt.at > 20000 && end > s.startSec) {
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
  }

  // Позиция плейхеда, сообщённая клиентом через /stream/status?pos= (для правила
  // параллельности превью: генерируем их, только когда транскод опережает ≥ N секунд).
  setPlayhead(topicId: number, fileIndex: number, pos: number): void {
    if (!Number.isFinite(pos) || pos < 0) return;
    this.playheads.set(this.fileKey(topicId, fileIndex), pos);
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
      // Конвертация формата (10-bit -> 8-bit) и даунскейл — силами кодера.
      // NVENC держит это на GPU (scale_cuda), остальные — прежний CPU-scale.
      args.push(...encoder.filterArgs({ height: media.height, res }));
      args.push(...encoder.videoArgs(gop, SEGMENT_SECONDS));
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

    const proc = spawn(ffmpegPath, args, { cwd: session.dir, stdio: ['ignore', 'ignore', 'pipe'] }) as ChildProcess;
    session.proc = proc;
    session.state = 'active';

    let stderr = '';
    proc.stderr?.on('data', (d) => {
      const text = d.toString();
      stderr = (stderr + text).slice(-2000);
      if (text.trim()) log.warn(`[hls] ${topicId}:${fileIndex} ffmpeg: ${text.trim()}`);
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
      const elapsed = Math.max(1, (now - s.startedAt) / 1000);
      const done = Math.max(0, s.transcodedEndSec - s.startSec);
      out.push({
        topicId: s.topicId,
        fileIndex: s.fileIndex,
        state: s.state,
        startSec: s.startSec,
        endSec: s.transcodedEndSec,
        speedMul: Math.round((done / elapsed) * 100) / 100,
      });
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
    log.info(`[hls] ${s.topicId}:${s.fileIndex} stopped (cache kept)`);
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

  private playlistReady(s: HlsSession): boolean {
    for (const f of this.playlistFiles(s)) {
      try {
        if (fs.statSync(f).size > 0) return true;
      } catch {
        /* not yet */
      }
    }
    return false;
  }

  // Ждёт, пока ffmpeg запишет первый сегмент (плейлист станет непустым).
  // НЕ убиваем ffmpeg по таймауту: при перемотке в недокачанный регион первый
  // сегмент может появиться позже 20 с (ffmpeg ждёт байты feed'а). Убийство
  // превращало «медленный старт» в livelock stop/restart.
  async waitForPlaylist(s: HlsSession, timeoutMs = 20000): Promise<boolean> {
    const stopTimer = perf.timer('hls.firstSegment.ms');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.playlistReady(s)) {
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
  async transcodedSeconds(
    topicId: number,
    fileIndex: number,
    audio: number | null,
    startSec: number,
    res: number | null,
  ): Promise<number | null> {
    const s = this.sessions.get(this.key(topicId, fileIndex, audio, roundStartSec(startSec), res));
    if (!s) return null;
    const { count, relSec } = await this.scanPlaylist(s.dir);
    s.transcodedEndSec = s.startSec + relSec;
    return count > 0 ? relSec : null;
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
    for (const t of this.reusePending.values()) clearTimeout(t);
    this.reusePending.clear();
    this.readers.clear();
    this.progress.clear();
    await Promise.all(procs.map((p) => HlsManager.waitExit(p, 2000)));
  }
}
