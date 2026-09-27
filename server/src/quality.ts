// 7 ступеней качества транскода (индекс 0 — максимальное, 6 — минимальное).
//
// У каждого энкодера СВОЯ шкала «качества», поэтому храним параметры per-encoder,
// а не один общий QP: NVENC `-cq` не эквивалентен x264 `-crf`/VAAPI `-qp`.
// Уровень 4 («Standard») — намеренно прежнее поведение (дефолт).
export interface QualityLevel {
  label: string;
  // VAAPI: -qp (CQP) + -quality (усилие энкодера; меньше = лучше/медленнее).
  vaapiQp: number;
  vaapiEffort: number;
  // NVENC: -cq (constant quality) + пресет p1..p7 + доп. анализ.
  nvencCq: number;
  nvencPreset: string;
  nvencLookahead: number; // -rc-lookahead (0 = выкл)
  nvencMultipass: number; // -multipass (0 = выкл, 2 = двухпроходный)
  nvencAq: boolean; // -spatial-aq 1 -temporal-aq 1
  nvencBref: boolean; // -b_ref_mode 2 (B-кадры как референс)
  // QSV: -global_quality + пресет.
  qsvQ: number;
  qsvPreset: string;
  // libx264 (софт-фолбэк): -crf + пресет.
  x264Crf: number;
  x264Preset: string;
  // Необязательные тонкие настройки «прозрачного» режима (пока только у «Max»).
  nvencTier?: 'main' | 'high'; // -tier (потолок maxrate у HEVC)
  nvencBf?: number; // -bf (число B-кадров; 0 = авто)
  x264Tune?: string; // -tune
  x264Params?: string; // -x264-params
  x265Params?: string; // -x265-params
}

export const QUALITY_LEVELS: QualityLevel[] = [
  {
    // Прозрачный режим: минимальный квантайзер + психо-визуальные параметры.
    label: 'Max · QP 12',
    vaapiQp: 11, vaapiEffort: 1,
    nvencCq: 12, nvencPreset: 'p7', nvencLookahead: 32, nvencMultipass: 2, nvencAq: true, nvencBref: true,
    nvencTier: 'high', nvencBf: 4,
    qsvQ: 16, qsvPreset: 'veryslow',
    x264Crf: 12, x264Preset: 'slower', x264Tune: 'film',
    x264Params: 'aq-mode=3:psy-rd=1.0:deblock=-1,-1',
    x265Params: 'aq-mode=3:psy-rd=1.0:deblock=-1,-1:sao=0',
  },
  {
    label: 'Very high · QP 16',
    vaapiQp: 16, vaapiEffort: 1,
    nvencCq: 17, nvencPreset: 'p7', nvencLookahead: 32, nvencMultipass: 2, nvencAq: true, nvencBref: true,
    qsvQ: 18, qsvPreset: 'slower',
    x264Crf: 17, x264Preset: 'medium',
  },
  {
    label: 'High · QP 18',
    vaapiQp: 18, vaapiEffort: 2,
    nvencCq: 19, nvencPreset: 'p6', nvencLookahead: 24, nvencMultipass: 2, nvencAq: true, nvencBref: false,
    qsvQ: 20, qsvPreset: 'slow',
    x264Crf: 19, x264Preset: 'fast',
  },
  {
    label: 'Raised · QP 20',
    vaapiQp: 20, vaapiEffort: 3,
    nvencCq: 21, nvencPreset: 'p5', nvencLookahead: 16, nvencMultipass: 0, nvencAq: true, nvencBref: false,
    qsvQ: 21, qsvPreset: 'medium',
    x264Crf: 21, x264Preset: 'faster',
  },
  {
    // Дефолт — прежнее поведение.
    label: 'Standard · QP 23',
    vaapiQp: 23, vaapiEffort: 4,
    nvencCq: 23, nvencPreset: 'p4', nvencLookahead: 0, nvencMultipass: 0, nvencAq: false, nvencBref: false,
    qsvQ: 23, qsvPreset: 'veryfast',
    x264Crf: 23, x264Preset: 'veryfast',
  },
  {
    label: 'Economy · QP 27',
    vaapiQp: 27, vaapiEffort: 5,
    nvencCq: 26, nvencPreset: 'p3', nvencLookahead: 0, nvencMultipass: 0, nvencAq: false, nvencBref: false,
    qsvQ: 27, qsvPreset: 'veryfast',
    x264Crf: 27, x264Preset: 'veryfast',
  },
  {
    label: 'Minimum · QP 31',
    vaapiQp: 31, vaapiEffort: 6,
    nvencCq: 29, nvencPreset: 'p2', nvencLookahead: 0, nvencMultipass: 0, nvencAq: false, nvencBref: false,
    qsvQ: 31, qsvPreset: 'veryfast',
    x264Crf: 31, x264Preset: 'ultrafast',
  },
];

// «Standard» (индекс 4).
export const DEFAULT_QUALITY = 4;

export function clampQuality(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_QUALITY;
  return Math.max(0, Math.min(QUALITY_LEVELS.length - 1, n));
}

export function qualityLevelOf(v: unknown): QualityLevel {
  return QUALITY_LEVELS[clampQuality(v)];
}
