import { Router, raw as rawBody } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import fs from 'node:fs';
import { ImageFetchError } from './images.js';
import { Readable } from 'node:stream';
import type { Services } from './services.js';
import { log } from './logger.js';
import { mimeFor, parseRangeHeader } from './stream-utils.js';
import { formatWindowVtt } from './mkv.js';
import { perf } from './perf.js';
import { assertSafeHttpUrl } from './url-safe.js';
import { sameOriginGuard } from './csrf.js';
import { THUMB_INTERVAL_SEC, THUMB_NEAREST_WINDOW_SLOTS } from './thumbnails.js';
import { clampQuality } from './quality.js';
import { clampGain, clampBitDepth } from './hls.js';

// Кэп на один Direct Play ответ: браузер просит `bytes=0-` (весь файл), но мы
// отдаём только ограниченный кусок, чтобы WebTorrent не выбирал весь файл сразу.
const MAX_READ_BYTES = 16 * 1024 * 1024;

// Express 4 не ловит reject из async-хендлеров. Обёртка переправляет ошибку в
// error-middleware (index.ts), который отвечает JSON и не роняет процесс.
function ah(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function createApi(services: Services): Router {
  const api = Router();

  // Активный поиск: запуск нового отменяет предыдущий, чтобы не копить очередь
  // (старый запрос не держит общую очередь браузера).
  let activeSearch: AbortController | null = null;

  // Троттлинг клиентских логов: при стойле hls.js шлёт десятки ошибок в секунду,
  // и синхронный вывод в лог сам по себе бьёт по event loop. Пишем не чаще 1/с с
  // числом подавленных, а тяжёлое обогащение — не чаще 1/5с.
  let clientLogAt = 0;
  let clientLogSuppressed = 0;
  let clientEnrichAt = 0;

  // Живость раздачи для серверного watchdog'а: любой запрос браузера к топику
  // обновляет «последнюю активность». Внутренний ffmpeg-feed (?feed=1) — не в счёт,
  // иначе транскод поддерживал бы сам себя и сторож никогда не сработал бы.
  api.use('/topic/:id', (req, _res, next) => {
    if (req.query.feed !== '1') services.noteClientActivity(Number(req.params.id));
    next();
  });

  api.post('/client-log', ah(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const now = Date.now();
    if (now - clientLogAt >= 1000) {
      const sup = clientLogSuppressed > 0 ? ` (+${clientLogSuppressed} suppressed)` : '';
      clientLogAt = now;
      clientLogSuppressed = 0;
      log.warn(
        `[client] ${String(b.msg ?? 'error')} :: ${JSON.stringify(b).slice(0, 4000)}${sup}`,
      );
    } else {
      clientLogSuppressed++;
    }

    // Обогащаем диагностические события (сталл/таймаут/ошибка) состоянием сервера:
    // скорость закачки, пиры, прогресс, битрейт, докуда накодировано — чтобы видеть,
    // какой этап тормозит. Не чаще 1/5с, чтобы не долбить status/probe на каждый churn.
    const detail = `${String(b.details ?? '')} ${String(b.event ?? '')} ${String(b.type ?? '')}`;
    if (/stall|timeout|error|buffer|fatal/i.test(detail) && now - clientEnrichAt >= 5000) {
      clientEnrichAt = now;
      const id = Number(b.topicId);
      const fi = Number(b.fileIndex);
      if (Number.isFinite(id) && Number.isFinite(fi)) {
        try {
          const [status, media] = await Promise.all([
            services.stream.status(id, fi),
            services.stream.probe(id, fi).catch(() => null),
          ]);
          const hls = services.hls.activeTranscodedSec(id, fi);
          const dl = (status.downloadSpeed / 1024).toFixed(0);
          const prog = (status.file?.progress ?? status.progress ?? 0).toFixed(2);
          log.warn(
            `[client-enrich] topic=${id} file=${fi} dl=${dl}KB/s peers=${status.numPeers} prog=${prog} bitrate=${media?.bitrate ?? '?'}bps dur=${media?.durationSec != null ? media.durationSec.toFixed(0) + 's' : '?'} hls=${hls ? `${hls.startSec}->${hls.endSec.toFixed(0)}s` : 'none'}`,
          );
        } catch {
          /* ignore */
        }
      }
    }

    res.json({ ok: true });
  }));

  // Диагностические маршруты/логи — только при TP_DIAG=1 (не в обычном запуске).
  const DIAG = process.env.TP_DIAG === '1';
  if (DIAG) {
    api.get('/__diag/exit', (_req, res) => {
      res.json({ ok: true });
      setTimeout(() => process.exit(0), 200);
    });
  }

  // Метрики производительности: сервер пишет сам, клиент шлёт свои (seek/stall).
  api.get('/perf', (_req, res) => {
    res.json(perf.snapshot());
  });

  api.post('/perf', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = String(b.name ?? '');
    const ms = Number(b.ms);
    if (name && Number.isFinite(ms) && ms >= 0) {
      perf.time(name, ms);
    }
    res.json({ ok: true });
  });

  api.post('/perf/reset', (_req, res) => {
    perf.reset();
    res.json({ ok: true });
  });

  api.get('/auth/status', ah(async (_req, res) => {
    const session = services.store.getSession();
    if (!session || !session.username) {
      res.json({ loggedIn: false, username: null });
      return;
    }
    const loggedIn = await services.auth.ensureLoggedIn();
    res.json({ loggedIn, username: loggedIn ? session.username : null });
  }));

  // Фаза текущего логина для кнопки в UI: 'cloudflare' | 'login' | 'idle'.
  api.get('/auth/progress', (_req, res) => {
    res.json({ phase: services.browser.getLoginPhase() });
  });

  api.post('/auth/login', ah(async (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (!username || !password) {
      res.status(400).json({ ok: false, error: 'Нужны логин и пароль.' });
      return;
    }
    const result = await services.auth.login(String(username), String(password));
    res.json(result);
  }));

  api.post('/auth/cookies', ah(async (req, res) => {
    const { cookie } = (req.body ?? {}) as { cookie?: unknown };
    if (!cookie) {
      res.status(400).json({ ok: false, error: 'Нужна cookie-строка.' });
      return;
    }
    const result = await services.auth.loginWithCookie(String(cookie));
    res.json(result);
  }));

  api.post('/auth/logout', ah(async (_req, res) => {
    await services.auth.logout();
    res.json({ ok: true });
  }));

  api.get('/search', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) {
      res.json({ results: [] });
      return;
    }
    // Новый поиск отменяет предыдущий — иначе старый висел бы в очереди браузера
    // и новый запрос ждал бы его окончания.
    activeSearch?.abort();
    const ac = new AbortController();
    activeSearch = ac;
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });
    try {
      const results = await services.search(q, ac.signal);
      if (activeSearch === ac) activeSearch = null;
      res.json({ results });
    } catch (e) {
      if (ac.signal.aborted) return;
      const msg = e instanceof Error ? e.message : 'search error';
      if (msg === 'NOT_LOGGED_IN') {
        res.status(401).json({ error: 'not_logged_in' });
      } else {
        res.status(502).json({ error: msg });
      }
    }
  });

  api.get('/topic/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'bad id' });
      return;
    }
    try {
      const topic = await services.getTopic(id);
      res.json(topic);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'topic error';
      res.status(502).json({ error: msg });
    }
  });

  api.get('/topic/:id/torrent', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'bad id' });
      return;
    }
    try {
      const buf = await services.downloadTorrent(id);
      res.setHeader('Content-Type', 'application/x-bittorrent');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="rutracker_${id}.torrent"`,
      );
      res.send(buf);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'torrent error';
      res.status(502).json({ error: msg });
    }
  });

  api.get('/topic/:id/stream/files', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'bad id' });
      return;
    }
    try {
      await services.activateStream(id);
      const files = await services.stream.files(id);
      res.json({ files });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'stream error';
      res.status(502).json({ error: msg });
    }
  });

  api.post('/topic/:id/stream/stop', ah(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'bad id' });
      return;
    }
    await services.stopStream(id);
    res.json({ ok: true });
  }));

  api.post('/topic/:id/stream/:fileIndex/hls/stop', async (req, res) => {
    const id = Number(req.params.id);
    const fileIndex = Number(req.params.fileIndex);
    if (!Number.isFinite(id) || !Number.isFinite(fileIndex)) {
      res.status(400).json({ error: 'bad params' });
      return;
    }
    services.hls.stopFile(id, fileIndex);
    res.json({ ok: true });
  });

  api.post('/topic/:id/stream/warm', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'bad id' });
      return;
    }
    void services.warmStream(id).catch(() => {});
    res.json({ ok: true });
  });

  api.get('/topic/:id/stream/status', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'bad id' });
      return;
    }
    const fileIndex = req.query.file !== undefined ? Number(req.query.file) : undefined;
    const audioRaw = req.query.audio;
    const audio =
      audioRaw !== undefined && audioRaw !== '' && Number.isFinite(Number(audioRaw))
        ? Number(audioRaw)
        : null;
    const startRaw = req.query.start;
    const startSec =
      startRaw !== undefined && startRaw !== '' && Number.isFinite(Number(startRaw)) && Number(startRaw) > 0
        ? Number(startRaw)
        : 0;
    const resRaw = req.query.res;
    const resVal =
      resRaw !== undefined && resRaw !== '' && Number.isFinite(Number(resRaw)) && Number(resRaw) > 0
        ? Number(resRaw)
        : null;
    const qualityVal = clampQuality(req.query.quality);
    const gainVal = clampGain(req.query.gain);
    const bdVal = clampBitDepth(req.query.bd);
    const posRaw = req.query.pos;
    const pos =
      posRaw !== undefined && posRaw !== '' && Number.isFinite(Number(posRaw)) && Number(posRaw) > 0
        ? Number(posRaw)
        : null;
    const pausedRaw = req.query.paused;
    const paused =
      pausedRaw === '1' ? true : pausedRaw === '0' ? false : undefined;
    try {
      const hasFile = Number.isFinite(fileIndex as number);
      const status = await services.stream.status(
        id,
        hasFile ? (fileIndex as number) : undefined,
      );
      if (hasFile && pos != null) {
        services.hls.setPlayhead(id, fileIndex as number, pos, paused);
      }
      let transcodedSec: number | null = null;
      if (hasFile) {
        transcodedSec = await services.hls.transcodedSeconds(
          id,
          fileIndex as number,
          audio,
          startSec,
          resVal,
          qualityVal,
          gainVal,
          bdVal,
        );
      }
      res.json({ ...status, transcodedSec });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'stream error';
      res.status(502).json({ error: msg });
    }
  });

  api.get('/topic/:id/stream/:fileIndex/probe', async (req, res) => {
    const id = Number(req.params.id);
    const fileIndex = Number(req.params.fileIndex);
    if (!Number.isFinite(id) || !Number.isFinite(fileIndex)) {
      res.status(400).json({ error: 'bad params' });
      return;
    }
    try {
      const media = await services.stream.probe(id, fileIndex);
      res.json(media);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'probe error';
      res.status(502).json({ error: msg });
    }
  });

  // Запускает фоновую генерацию превьюшек (идемпотентно).
  api.post('/topic/:id/stream/:fileIndex/thumbnails', (req, res) => {
    const id = Number(req.params.id);
    const fileIndex = Number(req.params.fileIndex);
    if (!Number.isFinite(id) || !Number.isFinite(fileIndex)) {
      res.status(400).json({ error: 'bad params' });
      return;
    }
    services.thumbnails.ensure(id, fileIndex);
    res.json({ ok: true });
  });

  // Метаданные превью: интервал, текущее покрытие и общее число слотов (если известно).
  api.get('/topic/:id/stream/:fileIndex/thumbnails/meta', (req, res) => {
    const id = Number(req.params.id);
    const fileIndex = Number(req.params.fileIndex);
    if (!Number.isFinite(id) || !Number.isFinite(fileIndex)) {
      res.status(400).json({ error: 'bad params' });
      return;
    }
    res.json({
      intervalSec: THUMB_INTERVAL_SEC,
      count: services.thumbnails.coverage(id, fileIndex),
      total: services.thumbnails.total(id, fileIndex),
      slots: services.thumbnails.slots(id, fileIndex),
    });
  });

  // Отдаёт JPEG-превью. Если точный слот ещё не сгенерирован — отдаём ближайшее
  // существующее в окне ±THUMB_NEAREST_WINDOW_SLOTS слотов напрямую (без 302, чтобы
  // не плодить лишний запрос и не ловить гонку «файл появился между проверками»).
  // Если в окне пусто — 404 (клиент скрывает превью).
  api.get('/topic/:id/stream/:fileIndex/thumbnails/:name', (req, res) => {
    const id = Number(req.params.id);
    const fileIndex = Number(req.params.fileIndex);
    if (!Number.isFinite(id) || !Number.isFinite(fileIndex)) {
      res.status(400).json({ error: 'bad params' });
      return;
    }
    const serveThumb = (p: string): void => {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      const rs = fs.createReadStream(p);
      // Файл может быть удалён конкурентной чисткой кеша — не роняем процесс.
      rs.on('error', () => {
        if (!res.writableEnded) res.destroy();
      });
      rs.pipe(res);
    };
    const name = String(req.params.name);
    const p = services.thumbnails.thumbPath(id, fileIndex, name);
    if (p && fs.existsSync(p)) {
      serveThumb(p);
      return;
    }
    const m = /^thumb(\d{6})\.jpg$/.exec(name);
    if (!m) {
      res.status(404).end();
      return;
    }
    const index = Number(m[1]);
    const near = services.thumbnails.nearestSlot(
      id,
      fileIndex,
      index,
      THUMB_NEAREST_WINDOW_SLOTS,
    );
    if (near == null) {
      res.status(404).end();
      return;
    }
    const nearPath = services.thumbnails.thumbPath(
      id,
      fileIndex,
      `thumb${String(near).padStart(6, '0')}.jpg`,
    );
    if (nearPath && fs.existsSync(nearPath)) {
      serveThumb(nearPath);
      return;
    }
    res.status(404).end();
  });

  api.get('/topic/:id/stream/:fileIndex/playlist.m3u8', async (req, res) => {
    const id = Number(req.params.id);
    const fileIndex = Number(req.params.fileIndex);
    if (!Number.isFinite(id) || !Number.isFinite(fileIndex)) {
      res.status(400).json({ error: 'bad params' });
      return;
    }
    const audioRaw = req.query.audio;
    const audioNum = Number(audioRaw);
    const audio =
      audioRaw !== undefined && audioRaw !== '' && Number.isFinite(audioNum)
        ? audioNum
        : null;
    const startRaw = req.query.start;
    const startNum = Number(startRaw);
    const startSec =
      startRaw !== undefined && startRaw !== '' && Number.isFinite(startNum) && startNum > 0
        ? startNum
        : 0;
    const resRaw = req.query.res;
    const resNum = Number(resRaw);
    const resVal =
      resRaw !== undefined && resRaw !== '' && Number.isFinite(resNum) && resNum > 0
        ? resNum
        : null;
    const qualityVal = clampQuality(req.query.quality);
    const gainVal = clampGain(req.query.gain);
    const bdVal = clampBitDepth(req.query.bd);
    try {
      const session = await services.hls.start(id, fileIndex, {
        audio,
        startSec,
        res: resVal,
        quality: qualityVal,
        gain: gainVal,
        bitDepth: bdVal,
      });
      // При старте нового HLS-сеанса превью других файлов/топиков больше не нужны —
      // чистим их (аналогично pruneFileCache для Direct Play). Текущий файл сохраняется.
      services.thumbnails.removeCacheExcept(id, fileIndex);
      res.redirect(302, `/api/topic/${id}/stream/${fileIndex}/${session.sessionId}/playlist.m3u8`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'hls error';
      res.status(502).json({ error: msg });
    }
  });

  api.get('/topic/:id/stream/:fileIndex/subtitle/:streamIndex.vtt', async (req, res) => {
    const id = Number(req.params.id);
    const fileIndex = Number(req.params.fileIndex);
    const streamIndex = Number(req.params.streamIndex);
    if (!Number.isFinite(id) || !Number.isFinite(fileIndex) || !Number.isFinite(streamIndex)) {
      res.status(400).json({ error: 'bad params' });
      return;
    }

    try {
      const media = await services.stream.probe(id, fileIndex);
      const sub = media.subtitleTracks.find((t) => t.index === streamIndex);
      if (!sub) {
        log.warn(
          `[sub] ${id}:${fileIndex}:${streamIndex} not found; tracks=${media.subtitleTracks
            .map((t) => `${t.index}:${t.codec}${t.isText ? '' : '(img)'}`)
            .join(',')}`,
        );
        res.status(404).end();
        return;
      }
      if (!sub.isText) {
        res.status(415).json({ error: 'subtitle_not_text' });
        return;
      }

      const tNum = Number(req.query.t);
      const t = Number.isFinite(tNum) && tNum > 0 ? tNum : 0;
      const durNum = Number(req.query.dur);
      const dur = Number.isFinite(durNum) && durNum > 0 ? Math.min(durNum, 3600) : 600;
      const startNum = Number(req.query.start);
      const start = Number.isFinite(startNum) && startNum > 0 ? startNum : 0;

      // Прямой парсинг MKV: достаём куи окна из кластеров (без ffmpeg). done —
      // когда все кластеры окна скачаны; до этого отдаём частичные куи.
      const trackPosition = media.subtitleTracks.indexOf(sub);
      const { cues, done } = await services.subs.extractWindow(
        id,
        fileIndex,
        trackPosition,
        t,
        dur,
        sub.language,
      );
      const vtt = formatWindowVtt(cues, t, dur, start);
      const coverage = cues.reduce((m, c) => Math.max(m, c.end), t);
      log.info(
        `[sub] ${id}:${fileIndex}:${streamIndex} t=${t} dur=${dur} shift=${start} vtt=${vtt.length}B cues=${(vtt.match(/-->/g) ?? []).length} cov=${coverage} done=${done}`,
      );
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Sub-Extracted-Until', String(coverage));
      res.setHeader('X-Sub-Window-Done', done ? '1' : '0');
      res.send(vtt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'subtitle error';
      log.warn(`[sub] ${id}:${fileIndex}:${streamIndex} error: ${msg}`);
      res.status(502).json({ error: msg });
    }
  });

  api.get('/topic/:id/stream/:fileIndex/:sessionId/playlist.m3u8', async (req, res) => {
    const id = Number(req.params.id);
    const fileIndex = Number(req.params.fileIndex);
    const sessionId = String(req.params.sessionId);
    if (!Number.isFinite(id) || !Number.isFinite(fileIndex)) {
      res.status(400).json({ error: 'bad params' });
      return;
    }
    const session = services.hls.sessionById(sessionId);
    if (!session || session.topicId !== id || session.fileIndex !== fileIndex) {
      res.status(404).end();
      return;
    }
    try {
      const ready = await services.hls.waitForPlaylist(session, 10000);
      if (!ready) {
        // Сессия ещё жива (ffmpeg ждёт байты после перемотки в недокачанный регион) —
        // отдаём валидный пустой live-плейлист вместо 404, чтобы hls.js продолжал
        // опрашивать, а не падал фатально (manifestLoadError). Если ffmpeg уже
        // остановлен/упал — 404.
        if (session.state === 'active' || session.state === 'starting') {
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.setHeader('Cache-Control', 'no-cache');
          res.send(
            '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n',
          );
          return;
        }
        res.status(404).end();
        return;
      }
      const content = await services.hls.readPlaylist(session);
      if (!content) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'hls error';
      res.status(502).json({ error: msg });
    }
  });

  api.get('/topic/:id/stream/:fileIndex/:sessionId/:seg', async (req, res) => {
    const id = Number(req.params.id);
    const fileIndex = Number(req.params.fileIndex);
    const sessionId = String(req.params.sessionId);
    if (!Number.isFinite(id) || !Number.isFinite(fileIndex)) {
      res.status(400).json({ error: 'bad params' });
      return;
    }
    const seg = String(req.params.seg);
    const session = services.hls.sessionById(sessionId);
    const p =
      session && session.topicId === id && session.fileIndex === fileIndex
        ? services.hls.segmentPath(session, seg)
        : null;
    if (!session || !p) {
      log.warn(
        `[hls-seg] ${id}:${fileIndex} ${seg} 404 session=${session ? session.state : 'missing'} path=${p ?? 'null'} (sessionId=${sessionId.slice(0, 8)})`,
      );
      res.status(404).end();
      return;
    }
    // stat асинхронно: синхронный statSync на загруженном диске блокирует event loop
    // и сам задерживает последующие fs.open (наблюдали open=1.7с, serve=6с).
    let size = -1;
    try {
      size = (await fs.promises.stat(p)).size;
    } catch {
      log.warn(
        `[hls-seg] ${id}:${fileIndex} ${seg} 404 nofile state=${session.state} proc=${session.proc ? 'alive' : 'gone'}`,
      );
      res.status(404).end();
      return;
    }
    if (session.state !== 'active') {
      log.warn(
        `[hls-seg] ${id}:${fileIndex} ${seg} serve from ${session.state} session (proc=${session.proc ? 'alive' : 'gone'})`,
      );
    }
    // Пока читаем сегменты сессии, каталог нельзя перезаписывать/удалять
    // (reuse-рестарт ждёт ухода читателей) — иначе клиенту прилетает лавина 404.
    services.hls.retainSession(session.sessionId);
    const startedAt = Date.now();
    let openAt = 0;
    let firstByteAt = 0;
    let readEndAt = 0;
    let bytes = 0;
    let released = false;
    const onDone = (why: string) => {
      if (released) return;
      released = true;
      services.hls.releaseSession(session.sessionId);
      const ms = Date.now() - startedAt;
      perf.time('hls.seg.serve.ms', ms);
      services.hls.noteServe(ms);
      if (ms > 1000) {
        log.warn(
          `[hls-seg] ${id}:${fileIndex} ${seg} slow serve ${ms}ms ttfb=${firstByteAt ? firstByteAt - startedAt : -1}ms open=${openAt ? openAt - startedAt : -1}ms readDone=${readEndAt ? readEndAt - startedAt : -1}ms bytes=${bytes}/${size} why=${why} state=${session.state}`,
        );
      }
    };
    res.on('finish', () => onDone('finish'));
    res.on('close', () => onDone('close'));
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    const rs = fs.createReadStream(p, { highWaterMark: 1 << 20 });
    rs.on('open', () => {
      openAt = Date.now();
    });
    rs.on('data', (c: string | Buffer) => {
      if (!firstByteAt) firstByteAt = Date.now();
      bytes += typeof c === 'string' ? Buffer.byteLength(c) : c.length;
    });
    rs.on('end', () => {
      readEndAt = Date.now();
    });
    rs.on('error', () => {
      if (!res.writableEnded) res.destroy();
    });
    rs.pipe(res);
  });

  api.get('/topic/:id/stream/:fileIndex', async (req, res) => {
    const id = Number(req.params.id);
    const fileIndex = Number(req.params.fileIndex);
    if (!Number.isFinite(id) || !Number.isFinite(fileIndex)) {
      res.status(400).json({ error: 'bad params' });
      return;
    }

    let stream: Readable | null = null;
    res.on('close', () => {
      if (!res.writableEnded && stream) stream.destroy();
    });

    try {
      const { file } = await services.stream.getFile(id, fileIndex);
      const size = file.length;
      const range = parseRangeHeader(req.headers.range as string | undefined, size);
      const contentType = mimeFor(file.name);

      if (range.kind === 'invalid') {
        res.setHeader('Content-Range', `bytes */${size}`);
        res.status(416).end();
        return;
      }

      const start = range.kind === 'partial' ? range.start : undefined;
      // Браузеру кэпируем ответ (чтобы `bytes=0-` не качал весь файл), а ffmpeg
      // (input для транскода/remux) должен читать файл целиком — иначе он падает
      // с «Stream ends prematurely» и останавливает кодирование.
      const isFeed = req.query.feed === '1';
      // Смена серии при Direct Play (без нового HLS-start): кеш предыдущей серии
      // больше не нужен. Дедупликация по файлу внутри pruneFileCache.
      if (!isFeed) services.pruneFileCache(id, fileIndex);
      const end =
        range.kind === 'partial'
          ? isFeed
            ? range.end
            : Math.min(range.end, start! + MAX_READ_BYTES)
          : undefined;

      if (isFeed && DIAG) {
        log.info(
          `[feed-req] ${id}:${fileIndex} range=${JSON.stringify(req.headers.range ?? 'none')} start=${start ?? 0} end=${end ?? 'EOF'}`,
        );
      }
      const opened = await services.stream.openStream(id, fileIndex, { start, end, feed: isFeed });
      stream = opened.stream;

      // ДИАГНОСТИКА (TP_DIAG=1): пропускная способность feed к ffmpeg (байт/с) — чтобы
      // отличать «транскод голодает по входу» от «медленный кодек».
      if (isFeed && DIAG) {
        let feedBytes = 0;
        let feedLastBytes = 0;
        let feedLast = Date.now();
        const feedT0 = Date.now();
        stream.on('data', (c: string | Buffer) => {
          feedBytes += typeof c === 'string' ? Buffer.byteLength(c) : c.length;
        });
        const feedTimer = setInterval(() => {
          const now = Date.now();
          const dt = (now - feedLast) / 1000;
          const inst = dt > 0 ? (feedBytes - feedLastBytes) / 1048576 / dt : 0;
          feedLastBytes = feedBytes;
          feedLast = now;
          log.info(
            `[feed] ${id}:${fileIndex} inst=${inst.toFixed(1)}MB/s avg=${(feedBytes / 1048576 / ((now - feedT0) / 1000)).toFixed(1)}MB/s total=${(feedBytes / 1048576).toFixed(0)}MB`,
          );
        }, 5000);
        const stopFeedLog = () => clearInterval(feedTimer);
        res.on('finish', stopFeedLog);
        res.on('close', stopFeedLog);
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');

      if (range.kind === 'partial') {
        res.status(206);
        res.setHeader('Content-Length', String(end! - start! + 1));
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      } else {
        res.status(200);
        res.setHeader('Content-Length', String(size));
      }

      // Торрент может быть остановлен/уничтожен во время стрима — не даём ошибке
      // стрима уронить процесс (unhandled 'error').
      stream.on('error', () => {
        if (!res.writableEnded) {
          try {
            res.destroy();
          } catch {
            /* ignore */
          }
        }
      });
      stream.pipe(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'stream error';
      res.status(404).json({ error: msg });
    }
  });

  api.get('/history', (_req, res) => {
    res.json({ history: services.store.getHistory() });
  });

  api.post('/history', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const id = Number(b.id);
    const title = String(b.title ?? '').trim();
    if (!Number.isFinite(id) || !title) {
      res.status(400).json({ error: 'bad entry' });
      return;
    }
    const entry = {
      id,
      title,
      category: String(b.category ?? ''),
      poster: b.poster == null ? null : String(b.poster),
      sizeHuman: String(b.sizeHuman ?? ''),
      seeds: Number(b.seeds) || 0,
      leech: Number(b.leech) || 0,
      resolution: b.resolution == null ? null : String(b.resolution),
      bitrate: b.bitrate == null ? null : String(b.bitrate),
      duration: b.duration == null ? null : String(b.duration),
      date: String(b.date ?? ''),
    };
    res.json({ history: services.historyAdd(entry) });
  });

  api.delete('/history/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'bad id' });
      return;
    }
    try {
      const history = await services.removeHistoryEntry(id);
      res.json({ history });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'history error';
      res.status(502).json({ error: msg });
    }
  });

  api.get('/history/:id/resume', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'bad id' });
      return;
    }
    res.json(services.store.getHistoryResume(id));
  });

  api.post('/history/:id/resume', (req, res) => {
    const id = Number(req.params.id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const fileIndex = b.fileIndex == null ? null : Number(b.fileIndex);
    const position = b.position == null ? null : Number(b.position);
    if (
      !Number.isFinite(id) ||
      (fileIndex !== null && !Number.isFinite(fileIndex)) ||
      (position !== null && !Number.isFinite(position))
    ) {
      res.status(400).json({ error: 'bad resume' });
      return;
    }
    if (fileIndex !== null && position !== null) {
      services.store.setHistoryResume(id, fileIndex, position);
    }
    res.json({ ok: true });
  });

  api.post('/history/:id/volume', (req, res) => {
    const id = Number(req.params.id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const volume = b.volume == null ? null : Number(b.volume);
    const muted = b.muted === true;
    if (
      !Number.isFinite(id) ||
      volume == null ||
      !Number.isFinite(volume) ||
      volume < 0 ||
      volume > 1
    ) {
      res.status(400).json({ error: 'bad volume' });
      return;
    }
    services.store.setHistoryVolume(id, volume, muted);
    res.json({ ok: true });
  });

  api.post('/history/:id/tracks', (req, res) => {
    const id = Number(req.params.id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const audioTrack = b.audioTrack == null ? null : Number(b.audioTrack);
    const subtitleTrack = b.subtitleTrack == null ? null : Number(b.subtitleTrack);
    const valid = (v: number | null) => v == null || (Number.isFinite(v) && v >= 0);
    if (!Number.isFinite(id) || !valid(audioTrack) || !valid(subtitleTrack)) {
      res.status(400).json({ error: 'bad tracks' });
      return;
    }
    services.store.setHistoryTracks(id, audioTrack, subtitleTrack);
    res.json({ ok: true });
  });

  api.post('/history/:id/res', (req, res) => {
    const id = Number(req.params.id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const resCeiling = b.resCeiling == null ? null : Number(b.resCeiling);
    const valid = (v: number | null) => v == null || (Number.isFinite(v) && v > 0);
    if (!Number.isFinite(id) || !valid(resCeiling)) {
      res.status(400).json({ error: 'bad res' });
      return;
    }
    services.store.setHistoryRes(id, resCeiling);
    res.json({ ok: true });
  });

  api.post('/history/:id/quality', (req, res) => {
    const id = Number(req.params.id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const raw = b.qualityLevel == null ? null : Number(b.qualityLevel);
    const valid = raw == null || (Number.isInteger(raw) && raw >= 0 && raw < 7);
    if (!Number.isFinite(id) || !valid) {
      res.status(400).json({ error: 'bad quality' });
      return;
    }
    services.store.setHistoryQuality(id, raw);
    res.json({ ok: true });
  });

  api.post('/history/:id/gain', (req, res) => {
    const id = Number(req.params.id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const raw = b.gain == null ? null : Number(b.gain);
    const valid = raw == null || (Number.isFinite(raw) && raw > 0 && raw <= 4);
    if (!Number.isFinite(id) || !valid) {
      res.status(400).json({ error: 'bad gain' });
      return;
    }
    services.store.setHistoryGain(id, raw);
    res.json({ ok: true });
  });

  // --- Локальные magnet/.torrent раздачи ---------------------------------------

  function parseLocalId(req: Request): number | null {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id >= 0) return null;
    return id;
  }

  // Регистрация magnet-ссылки из поля поиска.
  api.post('/local/magnet', ah(async (req, res) => {
    const magnet = String((req.body ?? {}).magnet ?? '').trim();
    if (!magnet) {
      res.status(400).json({ error: 'Нужна magnet-ссылка.' });
      return;
    }
    try {
      const meta = await services.addLocalMagnet(magnet);
      res.json({ id: meta.id, name: meta.name });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'magnet error';
      res.status(400).json({ error: msg === 'bad_magnet' ? 'Это не похоже на magnet-ссылку.' : msg });
    }
  }));

  // Регистрация .torrent (raw body) из drag-n-drop.
  api.post('/local/torrent', rawBody({ type: () => true, limit: '20mb' }), ah(async (req, res) => {
    const buf = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      res.status(400).json({ error: 'Пустой .torrent файл.' });
      return;
    }
    try {
      const meta = await services.addLocalTorrent(buf);
      res.json({ id: meta.id, name: meta.name });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'torrent error';
      res.status(400).json({ error: msg === 'bad_torrent' ? 'Файл не похож на .torrent.' : msg });
    }
  }));

  api.get('/local/:id', (req, res) => {
    const id = parseLocalId(req);
    const meta = id != null ? services.local.getByTopicId(id) : null;
    if (!meta) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ id: meta.id, name: meta.name, kind: meta.kind, hasBanner: meta.hasBanner });
  });

  api.post('/local/:id/name', (req, res) => {
    const id = parseLocalId(req);
    if (id == null) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const name = String((req.body ?? {}).name ?? '').trim();
    if (!name) {
      res.status(400).json({ error: 'Нужно имя.' });
      return;
    }
    const meta = services.renameLocal(id, name);
    if (!meta) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ id: meta.id, name: meta.name });
  });

  // Старт просмотра: создаёт/обновляет запись истории (+ фоновая генерация баннера).
  api.post('/local/:id/watch', ah(async (req, res) => {
    const id = parseLocalId(req);
    if (id == null) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (!services.local.getByTopicId(id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = b.name == null ? undefined : String(b.name);
    let fileIndex: number | null = null;
    if (b.fileIndex != null) {
      const fi = Number(b.fileIndex);
      if (!Number.isFinite(fi) || fi < 0) {
        res.status(400).json({ error: 'bad fileIndex' });
        return;
      }
      fileIndex = fi;
    }
    const history = await services.watchLocal(id, { name, fileIndex });
    res.json({ ok: true, history });
  }));

  // Страницу закрыли до начала просмотра — источник удаляется (записи истории нет).
  api.post('/local/:id/close', ah(async (req, res) => {
    const id = parseLocalId(req);
    if (id == null) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const removed = await services.closeLocal(id);
    res.json({ ok: true, removed });
  }));

  // Баннер локальной раздачи (постер в карточке истории).
  api.get('/local/:id/banner', (req, res) => {
    const id = parseLocalId(req);
    const meta = id != null ? services.local.getByTopicId(id) : null;
    const p = meta ? services.local.bannerPath(meta.id) : null;
    if (!p || !fs.existsSync(p)) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    const rs = fs.createReadStream(p);
    rs.on('error', () => {
      if (!res.writableEnded) res.destroy();
    });
    rs.pipe(res);
  });

  api.get('/cache/size', async (_req, res) => {
    res.json({ bytes: await services.store.cacheSizeAsync() });
  });

  api.post('/cache/clear', sameOriginGuard, async (_req, res) => {
    try {
      const before = await services.store.cacheSizeAsync();
      await services.clearCache();
      const after = await services.store.cacheSizeAsync();
      res.json({ bytes: after, freed: Math.max(0, before - after) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'cache clear error';
      res.status(502).json({ error: msg });
    }
  });

  api.post('/cache/clear-video', sameOriginGuard, async (_req, res) => {
    try {
      const before = await services.store.cacheSizeAsync();
      await services.clearVideoCache();
      const after = await services.store.cacheSizeAsync();
      res.json({ bytes: after, freed: Math.max(0, before - after) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'video cache clear error';
      res.status(502).json({ error: msg });
    }
  });

  api.post('/enrich', ah(async (req, res) => {
    const ids: number[] = (req.body?.ids ?? [])
      .map((n: unknown) => Number(n))
      .filter((n: number) => Number.isFinite(n) && n > 0);
    const out = await services.enrich(ids);
    res.json(out);
  }));

  // Фолбэк при неудаче: пусть браузер попробует загрузить картинку напрямую, но
  // только если это безопасный публичный URL (не private/loopback — open redirect/SSRF).
  async function browserFallbackUrl(url: string): Promise<string | null> {
    if (!/^https?:\/\//i.test(url)) return null;
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    if (/rutracker\.(org|cc)$/i.test(host)) return null; // rutracker — не редиректим
    try {
      await assertSafeHttpUrl(url);
      return url;
    } catch {
      return null;
    }
  }

  api.get('/image', async (req, res) => {
    const url = String(req.query.url ?? '');
    if (!url) {
      res.status(400).end();
      return;
    }
    try {
      const { data, contentType } = await services.image(url);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(data);
    } catch (e) {
      // Источник вернул 4xx (или картинка уже в негативном кеше): серверный fetch
      // бот-детектится и отдаёт 404, но картинка часто грузится напрямую в браузере.
      if (e instanceof ImageFetchError) {
        const target = await browserFallbackUrl(url);
        if (target) {
          res.redirect(302, target);
        } else {
          res.status(e.status).end();
        }
        return;
      }
      log.error(`[api] image fetch failed: ${e instanceof Error ? e.message : String(e)} :: ${url}`);
      const target = await browserFallbackUrl(url);
      if (target) {
        res.redirect(302, target);
      } else {
        res.status(404).end();
      }
    }
  });

  api.get('/vpn/status', (_req, res) => {
    res.json(services.vpn.status());
  });

  api.post('/vpn/config', async (req, res) => {
    const subscriptionUrl = String((req.body as { subscriptionUrl?: unknown } | undefined)?.subscriptionUrl ?? '').trim();
    if (!/^https?:\/\//i.test(subscriptionUrl)) {
      res.status(400).json({ error: 'Нужна ссылка на подписку (http/https).' });
      return;
    }
    services.vpn.setSubscription(subscriptionUrl);
    try {
      await services.vpn.refreshNodes();
      res.json(services.vpn.status());
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'subscription error';
      res.status(502).json({ error: msg });
    }
  });

  api.post('/vpn/configs', (req, res) => {
    const text = String((req.body as { text?: unknown } | undefined)?.text ?? '').trim();
    if (!text) {
      res.status(400).json({ error: 'Вставьте vless-конфиги.' });
      return;
    }
    try {
      const added = services.vpn.addManualConfigs(text);
      if (added === 0) {
        res.status(400).json({ error: 'Новых vless-конфигов не добавлено (уже есть или формат не распознан).' });
        return;
      }
      res.json(services.vpn.status());
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'configs error';
      res.status(502).json({ error: msg });
    }
  });

  api.post('/vpn/check', (_req, res) => {
    try {
      services.vpn.checkNodes();
      res.json({ started: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'check error';
      res.status(502).json({ error: msg });
    }
  });

  api.post('/vpn/select', (req, res) => {
    const name = String((req.body as { name?: unknown } | undefined)?.name ?? '');
    if (!name) {
      res.status(400).json({ error: 'Нужно имя ноды.' });
      return;
    }
    try {
      services.vpn.selectNode(name);
      res.json(services.vpn.status());
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'select error';
      res.status(502).json({ error: msg });
    }
  });

  api.post('/vpn/remove', (req, res) => {
    const name = String((req.body as { name?: unknown } | undefined)?.name ?? '');
    if (!name) {
      res.status(400).json({ error: 'Нужно имя ноды.' });
      return;
    }
    try {
      const removed = services.vpn.removeNode(name);
      if (!removed) {
        res.status(404).json({ error: 'Нода не найдена.' });
        return;
      }
      res.json(services.vpn.status());
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'remove error';
      res.status(502).json({ error: msg });
    }
  });

  api.post('/vpn/enable', (req, res) => {
    const enabled = Boolean((req.body as { enabled?: unknown } | undefined)?.enabled);
    services.vpn.setEnabled(enabled);
    res.json(services.vpn.status());
  });

  api.post('/vpn/test', ah(async (_req, res) => {
    const r = await services.vpn.test();
    res.json(r);
  }));

  return api;
}
