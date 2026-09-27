// Выбор видеокодека для транскода: аппаратный (NVENC/QSV/VAAPI) с фолбэком на
// libx264/libx265. Автоопределение делается один раз (лениво, при первом старте HLS)
// короткой пробой кодирования через ffmpeg (`-f null`). Декодирование входа тоже
// уходит на железо (`-hwaccel cuda`/`qsv`/`vaapi`), что критично для 4K на слабых
// CPU (i3-9100): софтверный декод 4K HEVC морозит event loop и HLS-сегменты не успевают.
//
// Битность выхода (8/10) и gain исходника (умножение, якорь в чёрном — как «gain» в
// грейдинге: тени на месте, света растут) применяются здесь. 10-бит возможен только
// для HEVC/AV1-кодеков (H.264 10-бит NVENC не умеет). Никаких откатов битности: если
// выбрано 10 — кодируем 10.

import { spawn } from 'node:child_process';
import { FFMPEG_PATH as ffmpegPath } from './media.js';
import { log } from './logger.js';
import { qualityLevelOf, DEFAULT_QUALITY, type QualityLevel } from './quality.js';

export type EncoderKind = 'nvenc' | 'qsv' | 'vaapi' | 'libx264';
export type BitDepth = 8 | 10;

export interface VideoArgsCtx {
  gop: number;
  segmentSec: number;
  quality: QualityLevel;
  bitDepth: BitDepth;
}

export interface FilterArgsCtx {
  height: number | null;
  res: number | null;
  bitDepth: BitDepth;
  gain: number; // 1 = выключено
}

export interface EncoderConfig {
  kind: EncoderKind;
  label: string;
  // Аргументы, которые ставятся до `-i` (аппаратный декод входа).
  hwaccelArgs(): string[];
  // Аргументы видеокодера (после `-map 0:v:0`).
  videoArgs(ctx: VideoArgsCtx): string[];
  // Аргументы `-vf` (масштаб, gain, конвертация формата).
  filterArgs(ctx: FilterArgsCtx): string[];
  // Необязательные варианты для синтетической пробы (когда реального декода нет).
  probeHwaccelArgs?(): string[];
  probeFilterArgs?(): string[];
}

// gain как умножение в гамма-пространстве с якорем в чёрном/нейтрали (не lift и не
// exposure): Y и хромы масштабируются вокруг опорных точек. Работает с нативным
// диапазоном plane (8 бит 0..255, 10 бит 0..1023) — проверено на p010le.
function gainFilter(bitDepth: BitDepth, gain: number): string {
  const max = bitDepth === 10 ? 1023 : 255;
  const blk = bitDepth === 10 ? 64 : 16;
  const neu = bitDepth === 10 ? 512 : 128;
  const g = gain.toFixed(4);
  return (
    `lutyuv=y='clip((val-${blk})*${g}+${blk},0,${max})'` +
    `:u='clip((val-${neu})*${g}+${neu},0,${max})'` +
    `:v='clip((val-${neu})*${g}+${neu},0,${max})'`
  );
}

const NVENC: EncoderConfig = {
  kind: 'nvenc',
  label: 'NVENC',
  // Декод и конвертация 10-bit -> 8-bit остаются в VRAM (-hwaccel_output_format
  // cuda + scale_cuda). -threads 1 ограничивает число decode-поверхностей nvdec
  // (иначе на 4K с большим числом ref-кадров драйвер отказывает с
  // CUDA_ERROR_INVALID_VALUE, и транскод падает).
  hwaccelArgs: () => ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-threads', '1'],
  videoArgs: ({ gop, quality, bitDepth }) => {
    const tenBit = bitDepth === 10;
    // Настоящий constant-quality у NVENC — `-rc vbr -cq N -b:v 0`.
    const args = [
      '-c:v', tenBit ? 'hevc_nvenc' : 'h264_nvenc',
      '-preset', quality.nvencPreset,
      '-tune', 'hq',
      '-rc', 'vbr',
      '-cq', String(quality.nvencCq),
      '-b:v', '0',
      '-profile:v', tenBit ? 'main10' : 'high',
      '-g', String(gop),
      '-forced-idr', '1',
    ];
    // Прозрачный режим: HEVC-tier high поднимает потолок maxrate, -bf 4 добавляет
    // будущие B-кадры (работает вместе с -b_ref_mode).
    if (quality.nvencTier) args.push('-tier', quality.nvencTier);
    if (quality.nvencBf && quality.nvencBf > 0) args.push('-bf', String(quality.nvencBf));
    // hvc1 (не hev1): MSE/браузеры (Chrome, Safari) требуют именно hvc1 для HEVC.
    if (tenBit) args.push('-pix_fmt', 'p010le', '-tag:v', 'hvc1');
    if (quality.nvencMultipass > 0) args.push('-multipass', String(quality.nvencMultipass));
    if (quality.nvencLookahead > 0) args.push('-rc-lookahead', String(quality.nvencLookahead));
    if (quality.nvencAq) args.push('-spatial-aq', '1', '-temporal-aq', '1');
    if (quality.nvencBref) args.push('-b_ref_mode', '2');
    return args;
  },
  filterArgs: ({ height, res, bitDepth, gain }) => {
    // Синтетическая проба (height неизвестен) — без scale_cuda.
    if (!height) return [];
    const cudaFmt = bitDepth === 10 ? 'p010' : 'nv12';
    let vf =
      res && res < height
        ? `scale_cuda=-2:${res}:format=${cudaFmt}`
        : `scale_cuda=format=${cudaFmt}`;
    const cpuFmt = bitDepth === 10 ? 'p010le' : 'nv12';
    // 10-бит всегда скачиваем в system memory (hevc_nvenc с -pix_fmt p010le не берёт
    // CUDA-кадры напрямую). gain — CPU-LUT поверх скачанных кадров.
    if (bitDepth === 10 || gain !== 1) vf += `,hwdownload,format=${cpuFmt}`;
    if (gain !== 1) vf += `,${gainFilter(bitDepth, gain)}`;
    return ['-vf', vf];
  },
};

// Устройство для QSV/VAAPI: путь до render-узла (например /dev/dri/renderD128).
function renderDevice(): string {
  const dev = process.env.TP_QSV_DEVICE;
  return dev && dev.trim() ? dev.trim() : '/dev/dri/renderD128';
}

// QSV: h264/hevc_qsv берут кадры из системной памяти (после аппаратного декода),
// поэтому CPU-фильтры (scale/gain) применимы напрямую.
function makeQsv(init: string[]): EncoderConfig {
  return {
    kind: 'qsv',
    label: 'QSV',
    hwaccelArgs: () => init,
    videoArgs: ({ gop, quality, bitDepth }) => {
      const tenBit = bitDepth === 10;
      const args = [
        '-c:v', tenBit ? 'hevc_qsv' : 'h264_qsv',
        '-preset', quality.qsvPreset,
        '-look_ahead', '0',
        '-global_quality', String(quality.qsvQ),
        '-g', String(gop),
        '-forced_idr', '1',
        '-pix_fmt', tenBit ? 'p010le' : 'yuv420p',
      ];
      if (tenBit) args.push('-profile:v', 'main10', '-tag:v', 'hvc1');
      return args;
    },
    filterArgs: ({ height, res, bitDepth, gain }) => {
      const parts: string[] = [];
      if (res && height && res < height) parts.push(`scale=-2:${res}`);
      if (gain !== 1) parts.push(gainFilter(bitDepth, gain));
      return parts.length ? ['-vf', parts.join(',')] : [];
    },
  };
}

// Несколько способов поднять QSV на Linux: через VAAPI-родителя (самый совместимый),
// напрямую на render-узле и авто-выбором ffmpeg.
function qsvVariants(): EncoderConfig[] {
  const dev = renderDevice();
  return [
    makeQsv(['-init_hw_device', `vaapi=va:${dev}`, '-init_hw_device', 'qsv=qs@va', '-hwaccel', 'qsv']),
    makeQsv(['-init_hw_device', `qsv=hw:${dev}`, '-hwaccel', 'qsv']),
    makeQsv(['-init_hw_device', 'qsv=hw', '-hwaccel', 'qsv']),
  ];
}

// VAAPI (Intel/AMD). GPU-конвейер (scale_vaapi). При gain кадры скачиваем в system
// memory, применяем LUT и загружаем обратно (vaapi-энкодер требует vaapi-поверхности).
function makeVaapi(device: string): EncoderConfig {
  const init = ['-init_hw_device', `vaapi=va:${device}`, '-filter_hw_device', 'va'];
  return {
    kind: 'vaapi',
    label: 'VAAPI',
    hwaccelArgs: () => [...init, '-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi'],
    probeHwaccelArgs: () => init,
    videoArgs: ({ gop, quality, bitDepth }) => {
      const tenBit = bitDepth === 10;
      const args = [
        '-c:v', tenBit ? 'hevc_vaapi' : 'h264_vaapi',
        '-rc_mode', 'CQP',
        '-qp', String(quality.vaapiQp),
        '-quality', String(quality.vaapiEffort),
        '-profile:v', tenBit ? 'main10' : 'high',
        '-g', String(gop),
        '-forced_idr', '1',
      ];
      if (tenBit) args.push('-tag:v', 'hvc1');
      return args;
    },
    filterArgs: ({ height, res, bitDepth, gain }) => {
      const vaapiFmt = bitDepth === 10 ? 'p010' : 'nv12';
      let vf =
        res && height && res < height
          ? `scale_vaapi=w=-2:h=${res}:format=${vaapiFmt}`
          : `scale_vaapi=format=${vaapiFmt}`;
      if (gain !== 1) {
        const cpuFmt = bitDepth === 10 ? 'p010le' : 'nv12';
        vf += `,hwdownload,format=${cpuFmt},${gainFilter(bitDepth, gain)},format=${cpuFmt},hwupload`;
      }
      return ['-vf', vf];
    },
    probeFilterArgs: () => ['-vf', 'hwupload,scale_vaapi=format=nv12'],
  };
}

// Короткая проба кодера: кодируем 1 с синтетики в null-муксер (8-бит, без gain).
function probe(cfg: EncoderConfig): Promise<boolean> {
  if (!ffmpegPath) return Promise.resolve(false);
  const bin = ffmpegPath;
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...(cfg.probeHwaccelArgs ? cfg.probeHwaccelArgs() : cfg.hwaccelArgs()),
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=1',
      ...(cfg.probeFilterArgs
        ? cfg.probeFilterArgs()
        : cfg.filterArgs({ height: null, res: null, bitDepth: 8, gain: 1 })),
      ...cfg.videoArgs({ gop: 24, segmentSec: 2, quality: qualityLevelOf(DEFAULT_QUALITY), bitDepth: 8 }),
      '-an', '-f', 'null', '-',
    ];
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr?.on('data', (d) => {
      err = (err + d.toString()).slice(-600);
    });
    const t = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      log.warn(`[encoder] ${cfg.label} probe timeout`);
      resolve(false);
    }, 15000);
    proc.on('error', (e) => {
      clearTimeout(t);
      log.warn(`[encoder] ${cfg.label} probe spawn error: ${e.message}`);
      resolve(false);
    });
    proc.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) {
        resolve(true);
      } else {
        log.warn(`[encoder] ${cfg.label} probe failed (code ${code}): ${err.trim().replace(/\s+/g, ' ')}`);
        resolve(false);
      }
    });
  });
}

// Софт-фолбэк. 10-бит → libx265 (main10), 8-бит → libx264. Битность не понижаем.
const LIBX264: EncoderConfig = {
  kind: 'libx264',
  label: 'libx264',
  hwaccelArgs: () => [],
  videoArgs: ({ gop, segmentSec, quality, bitDepth }) => {
    if (bitDepth === 10) {
      const args = [
        '-c:v', 'libx265', '-preset', quality.x264Preset, '-pix_fmt', 'yuv420p10le',
        '-crf', String(quality.x264Crf), '-profile:v', 'main10', '-tag:v', 'hvc1',
        '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
        '-force_key_frames', `expr:gte(t,n_forced*${segmentSec})`,
      ];
      if (quality.x265Params) args.push('-x265-params', quality.x265Params);
      return args;
    }
    const args = [
      '-c:v', 'libx264', '-preset', quality.x264Preset, '-pix_fmt', 'yuv420p',
      '-crf', String(quality.x264Crf),
      '-profile:v', 'high', '-level:v', '4.1',
      '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
      '-force_key_frames', `expr:gte(t,n_forced*${segmentSec})`,
    ];
    if (quality.x264Tune) args.push('-tune', quality.x264Tune);
    if (quality.x264Params) args.push('-x264-params', quality.x264Params);
    return args;
  },
  filterArgs: ({ height, res, bitDepth, gain }) => {
    const parts: string[] = [];
    if (res && height && res < height) parts.push(`scale=-2:${res}`);
    if (gain !== 1) parts.push(gainFilter(bitDepth, gain));
    return parts.length ? ['-vf', parts.join(',')] : [];
  },
};

// Ручное переопределение кодера через TP_ENCODER (nvenc|qsv|vaapi|libx264).
function forcedEncoder(): EncoderConfig | null {
  const v = (process.env.TP_ENCODER || '').trim().toLowerCase();
  if (v === 'nvenc') return NVENC;
  if (v === 'qsv') return qsvVariants()[0];
  if (v === 'vaapi') return makeVaapi(renderDevice());
  if (v === 'libx264' || v === 'x264' || v === 'sw' || v === 'cpu') return LIBX264;
  return null;
}

let cachePromise: Promise<EncoderConfig> | null = null;

async function detect(): Promise<EncoderConfig> {
  const forced = forcedEncoder();
  if (forced) {
    log.info(`[encoder] forced by TP_ENCODER: ${forced.label}`);
    return forced;
  }
  if (await probe(NVENC)) return NVENC;
  for (const qsv of qsvVariants()) {
    if (await probe(qsv)) return qsv;
  }
  const vaapi = makeVaapi(renderDevice());
  if (await probe(vaapi)) return vaapi;
  log.warn('[encoder] no hardware encoder available — falling back to libx264 (CPU)');
  return LIBX264;
}

export function getEncoder(): Promise<EncoderConfig> {
  if (!cachePromise) cachePromise = detect();
  return cachePromise;
}

// Фолбэк при падении HW-кодера (SW-декод+кодирование). Битность сохраняется.
export function getEncoderFallback(kind: EncoderKind): EncoderConfig | null {
  if (kind === 'libx264') return null;
  return LIBX264;
}

// Помечает HW-кодер «сломанным» после повторных падений и переключает авто-выбор на
// libx264/libx265, чтобы каждая перемотка не тратила время на падающий кодек.
export function markEncoderBroken(kind: EncoderKind): void {
  if (!cachePromise) return;
  void cachePromise.then((cfg) => {
    if (cfg.kind !== kind) return;
    log.warn(`[encoder] ${cfg.label} repeated failures — switching to software encoder`);
    cachePromise = Promise.resolve(LIBX264);
  });
}

export async function encoderLabel(): Promise<string> {
  try {
    return (await getEncoder()).label;
  } catch {
    return 'libx264';
  }
}
