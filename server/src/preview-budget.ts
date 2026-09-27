// Чистая логика «бюджета» генерации превью из исходника: какую долю времени можно
// качать дальние байты торрента, не мешая подготовке видео, и насколько длинную
// паузу держать между окнами. Вынесено отдельно от ThumbnailManager/Services, чтобы
// поведение покрывалось тестами без файловой системы и сети.

export interface PreviewPolicy {
  // Доля времени (0..1), когда разрешено качать исходник. 0 — только HLS-сегменты.
  fraction: number;
  reason: string;
}

export interface PreviewInputs {
  // «Скорость подготовки» видео = min(скорость транскода, скорость закачки ÷ поток).
  prep: number;
  // Запас транскода вперёд, секунды (голова транскода − playhead).
  ahead: number;
  playing: boolean;
}

// Подготовку плейбека ниже этого не опускаем: превью гложут транскод ровно до 1.5×.
export const PREVIEW_TARGET_PREP = 1.5;
// Ниже этой подготовки превью почти не качаем (только жёсткий минимум на паузе/запасе).
export const PREVIEW_PREP_MIN = 1.1;
// Максимальная доля времени превью.
export const PREVIEW_MAX_SHARE = 0.9;
// Доли при жёстких условиях.
export const PREVIEW_SHARE_PAUSED = 0.3;
export const PREVIEW_SHARE_LOW = 0.1;
// Буфер, требуемый при слабой подготовке (< PREVIEW_PREP_MIN): без него не качаем.
export const PREVIEW_AHEAD_LOW_SEC = 120;
// Маленький предохранитель при хорошей подготовке (>= PREVIEW_PREP_MIN): не даём
// превью оголять буфер полностью, но 2 минуты тут не нужны — транскод догонит.
export const PREVIEW_AHEAD_SAFE_SEC = 30;
// Мёртвая зона вокруг цели и границы шага подстройки (раз в ~10 с).
export const PREVIEW_DEADBAND = 0.1;
export const PREVIEW_STEP_MIN = 0.1;
export const PREVIEW_STEP_MAX = 0.4;
// Стартовая доля, пока нет замеров.
export const PREVIEW_SHARE_INIT = 0.4;

// Жёсткая доля для случаев, где динамика не нужна/запрещена. null — работает
// динамический контроллер (nextPreviewShare).
export function previewHardShare(p: PreviewInputs): number | null {
  if (!p.playing) return PREVIEW_SHARE_PAUSED;
  if (p.prep < PREVIEW_PREP_MIN) {
    return p.ahead >= PREVIEW_AHEAD_LOW_SEC ? PREVIEW_SHARE_LOW : 0;
  }
  // Хорошая подготовка: 2 минуты не требуем, только маленький предохранитель.
  if (p.ahead < PREVIEW_AHEAD_SAFE_SEC) return 0;
  return null;
}

// Текущая доля превью. Жёсткие случаи перебивают динамический share.
export function previewShareFor(stored: number, p: PreviewInputs): number {
  const hard = previewHardShare(p);
  return hard != null ? hard : stored;
}

// Шаг динамического share (вызывать раз в ~10 с). Держим prep около TARGET: шаг
// пропорционален отклонению (быстрый разгон после перемотки/старта), но не меньше
// MIN и не больше MAX. В мёртвой зоне долю не трогаем.
export function nextPreviewShare(prev: number, p: PreviewInputs): number {
  const hard = previewHardShare(p);
  if (hard != null) return hard;
  const err = p.prep - PREVIEW_TARGET_PREP;
  if (err > PREVIEW_DEADBAND) {
    const step = Math.min(PREVIEW_STEP_MAX, Math.max(PREVIEW_STEP_MIN, err * 0.5));
    return Math.min(PREVIEW_MAX_SHARE, prev + step);
  }
  if (err < -PREVIEW_DEADBAND) {
    const step = Math.min(PREVIEW_STEP_MAX, Math.max(PREVIEW_STEP_MIN, -err * 0.5));
    return Math.max(0, prev - step);
  }
  return prev;
}

// Пауза до следующего окна исходника после окна длиной `runMs` при доле `fraction`.
// Держим отношение on/off = fraction/(1-fraction): 0.4 → off = 1.5×on, 0.9 → 0.11×on.
// Ограничена снизу, чтобы окна не слипались, и сверху, чтобы не «зависать» надолго.
export function previewOffMs(fraction: number, runMs: number): number {
  if (!(fraction > 0)) return Number.POSITIVE_INFINITY;
  const onMs = Math.max(500, runMs);
  return Math.min(120_000, Math.max(1500, onMs * (1 / fraction - 1)));
}
