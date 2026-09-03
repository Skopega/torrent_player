// Лёгкий реестр метрик производительности в памяти. Собирает длительности
// ключевых этапов (скачивание кусков для seek, ffprobe, старт HLS, первый сегмент,
// клиентские seek/stall), чтобы понять, какой этап тормозит плейбек/перемотку.

const SAMPLE_CAP = 200;

interface Acc {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  samples: number[];
}

export interface MetricSnapshot {
  count: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  lastMs: number;
}

class Perf {
  private metrics = new Map<string, Acc>();

  // Фиксирует длительность `ms` этапа `name`.
  time(name: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let acc = this.metrics.get(name);
    if (!acc) {
      acc = { count: 0, totalMs: 0, minMs: Infinity, maxMs: 0, samples: [] };
      this.metrics.set(name, acc);
    }
    acc.count++;
    acc.totalMs += ms;
    if (ms < acc.minMs) acc.minMs = ms;
    if (ms > acc.maxMs) acc.maxMs = ms;
    acc.samples.push(ms);
    if (acc.samples.length > SAMPLE_CAP) acc.samples.shift();
  }

  // Возвращает функцию, которую нужно вызвать по завершении этапа.
  timer(name: string): () => void {
    const t = Date.now();
    return () => this.time(name, Date.now() - t);
  }

  snapshot(): Record<string, MetricSnapshot> {
    const out: Record<string, MetricSnapshot> = {};
    for (const [name, acc] of this.metrics) {
      const sorted = [...acc.samples].sort((a, b) => a - b);
      const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
      out[name] = {
        count: acc.count,
        avgMs: acc.count ? acc.totalMs / acc.count : 0,
        minMs: acc.minMs === Infinity ? 0 : acc.minMs,
        maxMs: acc.maxMs,
        p95Ms: p95,
        lastMs: acc.samples.length ? acc.samples[acc.samples.length - 1] : 0,
      };
    }
    return out;
  }

  reset(): void {
    this.metrics.clear();
  }
}

export const perf = new Perf();
