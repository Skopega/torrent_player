// Адаптивный лимит скорости закачки торрента (Disk-Aware Controller, DAC).
//
// Задача: держать закачку максимально быстрой, но не давать диску захлебнуться
// (запись кусков торрента не должна задирать задержку чтения HLS-сегментов).
//
// Включается ТОЛЬКО когда идёт воспроизведение и впереди уже есть запас (см.
// hls.limiterTick): пока буферизация/пауза/пустой буфер — скорость не ограничена,
// поэтому перемотка и старт всегда качают нужный кусок на полной.
//
// Управление строится ТОЛЬКО на латентности чтения сегментов с диска — лаг event
// loop НЕ используется (он отражает кодировщик/CPU, а не диск). Контур сам
// калибрует базовую латентность и сходится к максимальной устойчивой скорости:
// multiplicative decrease при давлении, быстрый рост в спокойствии.
//
// Внешние ручки (hls.ts): TP_STREAM_LIMIT_MBPS — жёсткий ручной оверрайд,
// TP_STREAM_ADAPTIVE=0 — полностью снять лимит, TP_STREAM_CAP_AFTER_SEC — порог
// буфера, после которого включается контур.

export interface LimiterSignals {
  // Медиана/min времени отдачи сегмента в окне (мс) и число замеров в окне.
  serveMedMs: number | null;
  serveMinMs: number | null;
  serveCount: number;
  // Фактическая скорость закачки (байт/с) и битрейт файла (байт/с).
  observedBps: number;
  needBps: number;
  // Файл уже целиком локальный — торрент не пишет, ограничивать нечего.
  local: boolean;
}

export interface LimiterState {
  // Лимит в байт/с; -1 = без лимита.
  capBps: number;
  pressure: boolean;
  reason: string;
  baselineMs: number;
}

// Коэффициенты контура (алгоритмические, не скорости). Вынесены, чтобы их можно
// было осмысленно менять и тестировать.
export const LimiterConfig = {
  // Множитель уменьшения при подтверждённом давлении.
  DECREASE: 0.5,
  // Аддитивный рост за «чистый» тик как доля битрейта файла (AIMD: медленный рост,
  // чтобы контур сходился к устойчивой скорости без прыжков в unlimited/обратно).
  ADD_FRACTION: 0.25,
  // Стартовая оценка «здоровой» латентности чтения, мс. Нужна как bootstrap: без неё
  // на медленном диске первый же замер (уже задушенный) становится baseline, и
  // давление никогда не детектится. Это латентность (не скорость), поэтому ок.
  BASELINE_SEED_MS: 4,
  // Сколько окон давления подряд нужно, чтобы уменьшить (гистерезис).
  PRESSURE_STREAK: 2,
  // Давление = среднее > baseline * RATIO (и выше шума).
  BASELINE_RATIO: 3,
  // Мёртвая зона против джиттера: давление только если среднее > baseline + это.
  BASELINE_NOISE_MS: 25,
  // Минимум замеров в окне, иначе сигнал читаем как шум и не считаем давлением.
  MIN_SAMPLES: 3,
  // Пол лимита кратен битрейту файла: ниже этого транскод всё равно не успевает.
  MIN_NEED_MULTIPLE: 3,
  // Если фактическая скорость заметно ниже лимита — узкое место сеть, лимит не нужен.
  NETWORK_SLACK: 0.6,
  // Столько чистых тиков подряд для вывода «сеть ограничивает».
  NETWORK_SLACK_TICKS: 3,
  // Пауза (в тиках) после уменьшения, чтобы сигнал успел отреагировать.
  COOLDOWN_TICKS: 2,
} as const;

export function quantile(samples: number[], q: number): number | null {
  const xs = samples.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const idx = Math.min(xs.length - 1, Math.floor(xs.length * q));
  return xs[idx];
}

// Сводка по времени отдачи сегментов в окне: медиана (устойчива к одиночным
// выбросам) и минимум (для калибровки базовой латентности диска).
export function serveStats(samples: number[]): {
  med: number | null;
  min: number | null;
  count: number;
} {
  const xs = samples.filter((n) => Number.isFinite(n) && n >= 0);
  if (xs.length === 0) return { med: null, min: null, count: 0 };
  let min = Infinity;
  for (const x of xs) if (x < min) min = x;
  return { med: quantile(xs, 0.5), min, count: xs.length };
}

export class DownloadLimiter {
  private cap = -1;
  private baseline: number = LimiterConfig.BASELINE_SEED_MS;
  private pressureStreak = 0;
  private cleanStreak = 0;
  private cooldown = 0;
  private last: LimiterState = {
    capBps: -1,
    pressure: false,
    reason: 'init',
    baselineMs: LimiterConfig.BASELINE_SEED_MS,
  };

  get state(): LimiterState {
    return this.last;
  }

  // Сброс состояния, но БЕЗ обнуления базовой латентности: она калибруется по диску
  // и должна переживать перемотки/паузы, иначе порог давления каждый раз теряется.
  reset(): void {
    this.cap = -1;
    this.pressureStreak = 0;
    this.cleanStreak = 0;
    this.cooldown = 0;
    this.last = {
      capBps: -1,
      pressure: false,
      reason: 'init',
      baselineMs: this.baseline,
    };
  }

  // Пол по битрейту файла (выведенный, не константа скорости).
  private floorBps(s: LimiterSignals): number {
    if (s.needBps > 0) return s.needBps * LimiterConfig.MIN_NEED_MULTIPLE;
    return s.observedBps > 0 ? s.observedBps * 0.1 : 0;
  }

  tick(s: LimiterSignals): LimiterState {
    // Само-калибровка базовой латентности: быстро вниз к лучшему наблюдению,
    // медленно вверх (одиночный выброс не задерёт порог и не «отравит» базу).
    if (s.serveMinMs != null && Number.isFinite(s.serveMinMs) && s.serveMinMs > 0) {
      // Вниз — быстро (к лучшему наблюдению), вверх — заметно, но плавно, чтобы
      // быстрее подстроиться под реально более медленный, но исправный диск.
      if (s.serveMinMs < this.baseline) this.baseline = this.baseline * 0.6 + s.serveMinMs * 0.4;
      else this.baseline = this.baseline * 0.8 + s.serveMinMs * 0.2;
    }

    if (s.local) {
      this.cap = -1;
      this.pressureStreak = 0;
      this.cleanStreak = 0;
      return (this.last = { capBps: -1, pressure: false, reason: 'local', baselineMs: this.baseline });
    }

    const pressure =
      s.serveCount >= LimiterConfig.MIN_SAMPLES &&
      s.serveMedMs != null &&
      this.baseline > 0 &&
      s.serveMedMs > this.baseline * LimiterConfig.BASELINE_RATIO &&
      s.serveMedMs > this.baseline + LimiterConfig.BASELINE_NOISE_MS;

    if (pressure) {
      this.pressureStreak++;
      this.cleanStreak = 0;
    } else {
      this.cleanStreak++;
      this.pressureStreak = 0;
    }
    const reason = pressure
      ? `serve med=${(s.serveMedMs ?? 0).toFixed(0)}ms base=${this.baseline.toFixed(0)}ms`
      : 'clean';

    if (pressure && this.pressureStreak >= LimiterConfig.PRESSURE_STREAK) {
      const floor = this.floorBps(s);
      if (this.cap < 0) {
        // Снимали лимит и сразу упёрлись — берём половину фактически вытянутого.
        const from = s.observedBps > 0 ? s.observedBps : s.needBps;
        this.cap = Math.max(floor, from * LimiterConfig.DECREASE);
      } else {
        this.cap = Math.max(floor, this.cap * LimiterConfig.DECREASE);
      }
      this.pressureStreak = 0;
      this.cleanStreak = 0;
      this.cooldown = LimiterConfig.COOLDOWN_TICKS;
      return (this.last = { capBps: this.cap, pressure: true, reason, baselineMs: this.baseline });
    }

    if (this.cooldown > 0) {
      this.cooldown--;
      return (this.last = { capBps: this.cap, pressure, reason, baselineMs: this.baseline });
    }

    if (this.cap >= 0 && this.cleanStreak > 0) {
      // Лимит не является узким местом (фактическая скорость стабильно заметно ниже
      // него) → это сеть ограничивает, а не диск: снимаем лимит.
      if (
        this.cleanStreak >= LimiterConfig.NETWORK_SLACK_TICKS &&
        s.observedBps > 0 &&
        s.observedBps < this.cap * LimiterConfig.NETWORK_SLACK
      ) {
        this.cap = -1;
        this.cleanStreak = 0;
        return (this.last = { capBps: -1, pressure: false, reason: 'network-limited', baselineMs: this.baseline });
      }
      // Аддитивный рост (AIMD): контур сходится к устойчивой скорости диска без
      // прыжков в unlimited и повторного удушения (была осцилляция cap).
      const step = s.needBps > 0 ? s.needBps * LimiterConfig.ADD_FRACTION : this.cap * 0.1;
      this.cap += step;
      return (this.last = { capBps: this.cap, pressure: false, reason: 'grow', baselineMs: this.baseline });
    }

    return (this.last = { capBps: this.cap, pressure, reason, baselineMs: this.baseline });
  }
}
