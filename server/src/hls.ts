import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { DATA_DIR, rmDirRobust } from './store.js';
import { FFMPEG_PATH as ffmpegPath } from './media.js';
import { log } from './logger.js';
import { perf } from './perf.js';
import { getEncoder, getEncoderFallback, type EncoderConfig } from './encoder.js';
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
}

let sessionSeq = 0;

// Округляем startSec до границы сегмента: иначе ключ кеша и позиция HLS-таймлайна
// разъедутся, и субтитры/зелёная зона начнут «плавать» на доли секунды.
function roundStartSec(sec: number): number {
  return Math.max(0, Math.floor(sec / SEGMENT_SECONDS) * SEGMENT_SECONDS);
}

export class HlsManager {
  private sessions = new Map<string, HlsSession>();
  private byId = new Map<string, HlsSession>();
  private activeByFile = new Map<string, string>();
  private playheads = new Map<string, number>();

  constructor(
    private stream: StreamManager,
    private subs: SubtitleManager,
  ) {}

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

  // Освобождает место в кеше HLS: удаляет самые старые неактивные сессии, пока
  // суммарный размер не опустится под лимит. Активные (текущие) сессии не трогаем.
  private gcCache(keepDir: string): void {
    const entries = [...this.sessions.entries()].map(([key, s]) => ({
      key,
      dir: s.dir,
      startedAt: s.startedAt,
      active: this.activeByFile.get(this.fileKey(s.topicId, s.fileIndex)) === key,
    }));
    let total = entries.reduce((sum, e) => sum + dirSize(e.dir), 0);
    if (total <= HLS_MAX_BYTES) return;

    entries.sort((a, b) => a.startedAt - b.startedAt);
    for (const e of entries) {
      if (total <= HLS_MAX_BYTES) break;
      if (e.dir === keepDir || e.active) continue;
      const size = dirSize(e.dir);
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
    const startTimer = perf.timer('hls.start.ms');
    const audio = opts.audio === undefined ? null : opts.audio;
    const res = opts.res && opts.res > 0 ? opts.res : null;
    const startSec = roundStartSec(opts.startSec ?? 0);
    const key = this.key(topicId, fileIndex, audio, startSec, res);
    const fkey = this.fileKey(topicId, fileIndex);

    // Останавливаем ffmpeg остальных сессий этого файла (CPU), но каталоги кеша НЕ удаляем:
    // повторная перемотка в ту же позицию достанет сегменты из кеша мгновенно.
    this.stopOthers(topicId, fileIndex, key);

    const existing = this.sessions.get(key);
    if (existing && existing.state !== 'error') {
      this.activeByFile.set(fkey, key);
      // Finished — полный кеш (мгновенно); stopped — перекодируем заново с этого места.
      if (existing.state !== 'finished' && existing.proc == null) {
        existing.state = 'active';
        void this.spawn(existing, existing.startSec);
      }
      return existing;
    }
    if (existing) this.sessions.delete(key);

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
    fs.mkdirSync(dir, { recursive: true });

    const gop = Math.max(12, Math.round((media.fps ?? 24) * SEGMENT_SECONDS));

    const { relSec } = await this.scanPlaylist(dir);
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
      transcodedEndSec: startSec + relSec,
    };
    this.sessions.set(key, session);
    this.byId.set(session.sessionId, session);
    this.activeByFile.set(fkey, key);

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
          await this.stream.waitForBytes(topicId, fileIndex, bs, Math.min(be, bs + 8 * 1024 * 1024), 2000);
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

    session.state = 'active';
    void this.spawn(session, startSec);
    log.info(
      `[hls] ${topicId}:${fileIndex} started (transcode, audio=${audio ?? 'default'} start=${startSec} res=${res ?? 'full'})`,
    );
    this.gcCache(dir);
    startTimer();
    return session;
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
    const { topicId, fileIndex, audio, gop, res } = session;
    const media = session.media;
    const hasVideo = Boolean(media.videoCodec);

    // Аппаратный кодер с фолбэком: если текущий не инициализировался на реальном
    // файле (пробой мы проверили только синтетику), упадём на libx264.
    if (!session.encoder) {
      session.encoder = await getEncoder();
    }
    const encoder = session.encoder;

    const args = ['-hide_banner', '-loglevel', 'warning', '-y', '-fflags', '+genpts'];
    args.push(...encoder.hwaccelArgs());
    if (resumeSec > 0) args.push('-ss', String(resumeSec));
    // feed=1 — сервер не кэпирует ответ для ffmpeg (он должен читать файл целиком).
    args.push('-i', `${STREAM_BASE}/api/topic/${topicId}/stream/${fileIndex}?feed=1`);

    if (hasVideo) {
      args.push('-map', '0:v:0');
      // Снижение разрешения, если пользователь выбрал потолок ниже исходника.
      const height = media.height;
      if (res && height && res < height) {
        args.push('-vf', `scale=-2:${res}`);
      }
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
      if (s.topicId === topicId && s.proc) {
        this.stopSession(s);
      }
    }
  }

  stopFile(topicId: number, fileIndex: number): void {
    const key = this.activeByFile.get(this.fileKey(topicId, fileIndex));
    if (key) {
      const s = this.sessions.get(key);
      if (s && s.proc) this.stopSession(s);
    }
  }

  stopOthers(topicId: number, fileIndex: number, exceptKey: string): void {
    for (const [key, s] of this.sessions) {
      if (s.topicId === topicId && s.fileIndex === fileIndex && key !== exceptKey && s.proc) {
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
      const ref = parseHlsDir(e.name);
      if (ref && matchesKeep(ref, keepTopicId, keepFileIndex)) continue;
      try {
        rmDirRobust(path.join(HLS_DIR, e.name));
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
  async waitForPlaylist(s: HlsSession, timeoutMs = 20000): Promise<boolean> {
    const stopTimer = perf.timer('hls.firstSegment.ms');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.playlistReady(s)) {
        stopTimer();
        return true;
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
    await Promise.all(procs.map((p) => HlsManager.waitExit(p, 2000)));
  }
}
