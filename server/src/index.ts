import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Services } from './services.js';
import { createApi } from './api.js';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

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

const services = new Services();
app.use('/api', createApi(services));

// Контрольные эндпоинты для панели-супервизора: проверка живости и мягкий стоп.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/shutdown', (_req, res) => {
  res.json({ ok: true });
  void services.close().finally(() => process.exit(0));
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

void main();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void services.close().finally(() => process.exit(0));
  });
}
