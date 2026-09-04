// Пути к ffmpeg/ffprobe с возможностью переопределить из окружения.
// По умолчанию — бинарники из npm-пакетов (ffmpeg-static/ffprobe-static),
// через FFMPEG_PATH/FFPROBE_PATH можно указать системный ffmpeg (например,
// собранный с QSV для сервера): тогда версии ffmpeg/ffprobe не рассинхронизированы.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function staticFfmpeg(): string | null {
  try {
    return require('ffmpeg-static') as string | null;
  } catch {
    return null;
  }
}

function staticFfprobe(): string {
  try {
    const p = require('ffprobe-static') as { path?: string };
    return p?.path ?? '';
  } catch {
    return '';
  }
}

// Сборка с QSV из scripts/fetch-ffmpeg.cjs (runtime/ffmpeg). Ставим её выше
// ffmpeg-static: статическая npm-сборка собрана без Intel QSV, поэтому на iGPU
// (UHD 630) транскод иначе всегда падал бы в libx264 (CPU).
function runtimeBin(name: string): string | null {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const p = path.resolve(__dirname, '..', '..', 'runtime', 'ffmpeg', name + exe);
  return fs.existsSync(p) ? p : null;
}

// Может быть null, если ffmpeg-static не поставил бинарь.
export const FFMPEG_PATH: string | null =
  process.env.FFMPEG_PATH || runtimeBin('ffmpeg') || staticFfmpeg() || null;
export const FFPROBE_PATH: string =
  process.env.FFPROBE_PATH || runtimeBin('ffprobe') || staticFfprobe();
