import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Services } from './services.js';
import { createApi } from './api.js';
import { log } from './logger.js';
import { sameOriginGuard } from './csrf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TP_PORT) || 3000;

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

const app = express();
app.use(express.json({ limit: '1mb' }));
// Пользовательский контент (картинки/торренты) отдаётся с этого origin —
// запрещаем браузеру угадывать MIME и исполнять его как что-то ещё.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

const services = new Services();
app.use('/api', createApi(services));

// Мягкое завершение с гардом от конкурентных вызовов: /api/shutdown и сигналы
// SIGINT/SIGTERM могут прийти одновременно — close() выполняется один раз.
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await services.close();
  } finally {
    process.exit(0);
  }
}

// Контрольные эндпоинты для панели-супервизора: проверка живости и мягкий стоп.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/shutdown', sameOriginGuard, (_req, res) => {
  res.json({ ok: true });
  void shutdown();
});

// Неизвестные /api/*-маршруты отвечают JSON-404, а не index.html (SPA-fallback ниже)
// — иначе опечатка в пути API маскировалась бы под «успешный» HTML-ответ.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

const webDist = process.env.TP_WEB_DIST
  ? path.resolve(process.env.TP_WEB_DIST)
  : path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

async function main() {
  // При старте чистим кеш: видео-кеши всегда, метаданные — если выросли выше порога.
  try {
    await services.cleanupAtStartup();
  } catch (e) {
    log.warn(`[cache] startup cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    log.info(`torrent-player listening on http://0.0.0.0:${PORT}`);
    for (const ip of lanAddresses()) {
      log.info(`torrent-player available in LAN on http://${ip}:${PORT}`);
    }
  });
  server.on('error', (err) => {
    log.error(`[listen] cannot bind 0.0.0.0:${PORT}: ${err.message}`);
    process.exit(1);
  });
}

// Ошибки (в т.ч. из async-хендлеров, обёрнутых в ah()) всегда отвечаем JSON.
// Детали 500-х не отдаём наружу — только в лог.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const e = err as { status?: number; message?: string } | undefined;
  const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (status >= 500) {
    log.error(`[http] request failed: ${e?.message ?? String(err)}`);
    res.status(status).json({ error: 'internal error' });
    return;
  }
  const msg =
    typeof e?.message === 'string' && e.message ? e.message : status === 413 ? 'body too large' : 'bad request';
  res.status(status).json({ error: msg });
});

void main();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void shutdown();
  });
}
