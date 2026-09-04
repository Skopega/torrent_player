import type { Torrent } from 'webtorrent';

// Приоритеты скачивания (больше = важнее). WebTorrent итерирует selections по
// убыванию priority, поэтому порядок определяет, что качается в первую очередь.
export const Priority = {
  BACKGROUND: 1,
  PREVIEW: 10,
  SUBTITLE: 30,
  BUFFER: 50,
  PLAYBACK: 80,
  SEEK: 90,
} as const;

export type PriorityName = keyof typeof Priority;

// Единый планировщик приоритетов кусков для одного торрента.
//
// Идея: держим `desired` (что мы хотим) и `applied` (что уже сказали webtorrent)
// как массивы приоритетов на каждый piece. `commit()` диффит их и применяет
// изменения через torrent.select()/deselect() по непрерывным диапазонам.
//
// `critical()` не используем здесь намеренно: в webtorrent он необратим
// (нет "uncritical"), и при частых перемотках он превращает приоритеты в кашу.
// Параллельно file.createReadStream() сам ставит stream-selection и critical
// ровно на читаемый диапазон.
export class TorrentScheduler {
  private readonly desired: Int32Array;
  private readonly applied: Int32Array;
  private dirty = false;

  constructor(private readonly torrent: Torrent) {
    const n = torrent.pieces.length;
    this.desired = new Int32Array(n);
    this.applied = new Int32Array(n);
  }

  get pieceCount(): number {
    return this.desired.length;
  }

  private clamp(first: number, last: number): { first: number; last: number } {
    const max = this.desired.length - 1;
    return {
      first: Math.max(0, Math.min(first, max)),
      last: Math.max(0, Math.min(last, max)),
    };
  }

  // Поднимает приоритет диапазона не ниже `priority` (пересечения не понижаются).
  raise(first: number, last: number, priority: number): void {
    const r = this.clamp(first, last);
    if (r.last < r.first) return;
    for (let i = r.first; i <= r.last; i++) {
      if (this.desired[i] < priority) this.desired[i] = priority;
    }
    this.dirty = true;
  }

  // Ставит точный приоритет диапазона (0 = снять выбор).
  set(first: number, last: number, priority: number): void {
    const r = this.clamp(first, last);
    if (r.last < r.first) return;
    for (let i = r.first; i <= r.last; i++) this.desired[i] = priority;
    this.dirty = true;
  }

  release(first: number, last: number): void {
    this.set(first, last, 0);
  }

  // Обнуляет desired только на кусках, чей текущий приоритет входит в `priorities`.
  // Нужно, чтобы снять «своё» окно (PLAYBACK/BUFFER), не задев чужое (SEEK/SUBTITLE/PREVIEW).
  releaseAt(first: number, last: number, priorities: number[]): void {
    const r = this.clamp(first, last);
    if (r.last < r.first) return;
    const keep = new Set(priorities);
    for (let i = r.first; i <= r.last; i++) {
      if (keep.has(this.desired[i])) this.desired[i] = 0;
    }
    this.dirty = true;
  }

  clear(): void {
    this.desired.fill(0);
    this.dirty = true;
  }

  // Внешний код снял выбор (file.deselect()/torrent.deselect() в обход планировщика).
  // Помечаем эти куски как «не применено», чтобы следующий commit() пере-выбрал их,
  // если desired всё ещё требует (иначе планировщик «забывает» про снятые интервалы).
  externalDeselect(first: number, last: number): void {
    const r = this.clamp(first, last);
    if (r.last < r.first) return;
    for (let i = r.first; i <= r.last; i++) {
      if (this.applied[i] !== 0) {
        this.applied[i] = 0;
        this.dirty = true;
      }
    }
  }

  commit(): void {
    if (this.torrent.destroyed) return;
    if (!this.dirty) return;
    this.dirty = false;
    const n = this.desired.length;
    let i = 0;
    while (i < n) {
      if (this.desired[i] === this.applied[i]) {
        i++;
        continue;
      }
      const newP = this.desired[i];
      // Расширяем диапазон, пока следующая piece тоже хочет newP И требует
      // изменения (applied != newP), чтобы не цеплять уже корректные куски.
      let j = i;
      while (j + 1 < n && this.desired[j + 1] === newP && this.applied[j + 1] !== newP) {
        j++;
      }

      let hadApplied = false;
      for (let k = i; k <= j && !hadApplied; k++) {
        if (this.applied[k] !== 0) hadApplied = true;
      }
      try {
        if (hadApplied) this.torrent.deselect(i, j);
        if (newP > 0) this.torrent.select(i, j, newP);
      } catch {
        // Торрент мог быть уничтожен между проверкой и вызовом — игнорируем.
      }

      for (let k = i; k <= j; k++) this.applied[k] = newP;
      i = j + 1;
    }
  }
}
