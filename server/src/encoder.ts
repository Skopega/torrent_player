// Выбор видеокодека для транскода: аппаратный (NVENC/QSV) с фолбэком на libx264.
// Автоопределение делается один раз (лениво, при первом старте HLS) короткой
// пробой кодирования через ffmpeg (`-f null`). Декодирование входа тоже уходит на
// железо (`-hwaccel cuda`/`qsv`), что критично для 4K на слабых CPU (i3-9100).

import { spawn } from 'node:child_process';
import { FFMPEG_PATH as ffmpegPath } from './media.js';

export type EncoderKind = 'nvenc' | 'qsv' | 'libx264';

export interface EncoderConfig {
  kind: EncoderKind;
  label: string;
  // Аргументы, которые ставятся до `-i` (аппаратный декод входа).
  hwaccelArgs(): string[];
  // Аргументы видеокодера (после `-map 0:v:0`).
  videoArgs(gop: number, segmentSec: number): string[];
}

const NVENC: EncoderConfig = {
  kind: 'nvenc',
  label: 'NVENC',
  hwaccelArgs: () => ['-hwaccel', 'cuda'],
  videoArgs: (gop) => [
    '-c:v', 'h264_nvenc',
    // p4 быстрее p5, cq выше — больше запаса для 4K в реальном времени.
    '-preset', 'p4',
    '-tune', 'hq',
    '-rc', 'vbr',
    '-cq', '26',
    '-g', String(gop),
    '-forced-idr', '1',
    '-pix_fmt', 'yuv420p',
  ],
};

// QSV-устройство: ffmpeg 5+ требует явный `-init_hw_device` для аппаратного кодера.
// TP_QSV_DEVICE — путь до render-узла (например /dev/dri/renderD128); по умолчанию
// ffmpeg сам выбирает устройство (`qsv=hw`).
function qsvInitArgs(): string[] {
  const dev = process.env.TP_QSV_DEVICE;
  const device = dev && dev.trim() ? `qsv=hw:${dev.trim()}` : 'qsv=hw';
  return ['-init_hw_device', device];
}

const QSV: EncoderConfig = {
  kind: 'qsv',
  label: 'QSV',
  hwaccelArgs: () => [...qsvInitArgs(), '-hwaccel', 'qsv'],
  videoArgs: (gop) => [
    '-c:v', 'h264_qsv',
    '-preset', 'veryfast',
    '-look_ahead', '0',
    '-global_quality', '23',
    '-g', String(gop),
    '-forced_idr', '1',
    '-pix_fmt', 'yuv420p',
  ],
};

const LIBX264: EncoderConfig = {
  kind: 'libx264',
  label: 'libx264',
  hwaccelArgs: () => [],
  videoArgs: (gop, segmentSec) => [
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-profile:v', 'high', '-level:v', '4.1',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${segmentSec})`,
  ],
};

function configFor(kind: EncoderKind): EncoderConfig {
  switch (kind) {
    case 'nvenc': return NVENC;
    case 'qsv': return QSV;
    case 'libx264': return LIBX264;
  }
}

// Короткая проба кодера: кодируем 1 с синтетики в null-муксер.
// Включаем preInput-аргументы (init_hw_device/-hwaccel) — иначе h264_qsv/h264_nvenc
// без устройства валятся на старте, и проба всегда ложно отрицательная.
function probe(kind: EncoderKind): Promise<boolean> {
  if (!ffmpegPath) return Promise.resolve(false);
  const bin = ffmpegPath;
  return new Promise((resolve) => {
    const cfg = configFor(kind);
    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...cfg.hwaccelArgs(),
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=1',
      ...cfg.videoArgs(24, 2),
      '-an', '-f', 'null', '-',
    ];
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const t = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      resolve(false);
    }, 10_000);
    proc.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
    proc.on('close', (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}

let cachePromise: Promise<EncoderConfig> | null = null;

async function detect(): Promise<EncoderConfig> {
  for (const kind of ['nvenc', 'qsv'] as EncoderKind[]) {
    if (await probe(kind)) return configFor(kind);
  }
  return LIBX264;
}

// Возвращает выбранный кодер (кешируется после первого определения).
export function getEncoder(): Promise<EncoderConfig> {
  if (!cachePromise) cachePromise = detect();
  return cachePromise;
}

// Фолбэк для ретрая при падении HW-кодера на реальном файле (SW-декод+кодирование).
export function getEncoderFallback(kind: EncoderKind): EncoderConfig | null {
  if (kind === 'libx264') return null;
  return LIBX264;
}

export async function encoderLabel(): Promise<string> {
  try {
    return (await getEncoder()).label;
  } catch {
    return 'libx264';
  }
}
