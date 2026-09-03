// Пути к ffmpeg/ffprobe с возможностью переопределить из окружения.
// По умолчанию — бинарники из npm-пакетов (ffmpeg-static/ffprobe-static),
// через FFMPEG_PATH/FFPROBE_PATH можно указать системный ffmpeg (например,
// собранный с QSV для сервера): тогда версии ffmpeg/ffprobe не рассинхронизированы.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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

// Может быть null, если ffmpeg-static не поставил бинарь.
export const FFMPEG_PATH: string | null = process.env.FFMPEG_PATH || staticFfmpeg() || null;
export const FFPROBE_PATH: string = process.env.FFPROBE_PATH || staticFfprobe();
