import {
  MkvIndex,
  parseCluster,
  parseElement,
  blocksToCues,
  clusterByteForTime,
  type SubtitleCue,
  type ParsedBlock,
  type CuePoint,
} from './mkv.js';
import { log } from './logger.js';
import type { StreamManager } from './stream.js';

const TAIL_BYTES = 4 * 1024 * 1024;
// Верхний предел чтения одного кластера: parseElement может вернуть огромный
// size на битых/некорректных Cues — не читаем пол-файла одним буфером.
const MAX_CLUSTER_READ_BYTES = 64 * 1024 * 1024;

// Запросно-ориентированный экстрактор субтитров: читает MKV-структуру (Tracks,
// Cues) один раз на файл и для окна времени достаёт субтитрные блоки из кластеров
// напрямую (куски уже скачаны — их читает StreamManager.readBytes). Без ffmpeg и
// без ожидания полной закачки: окно готово, когда скачаны его кластеры.
export class SubtitleManager {
  private indexCache = new Map<string, MkvIndex>();
  private memo = new Map<string, { cues: SubtitleCue[]; done: boolean; at: number }>();
  // После неудачи/пустых Cues не дёргаем prioritizeTail/waitForBytes/readBytes каждый
  // опрос (2 с): это создаёт шторм приоритетов и лишний трафик. Ставим кулдаун.
  private failUntil = new Map<string, number>();

  private static readonly INDEX_COOLDOWN_MS = 10_000;

  constructor(private stream: StreamManager) {}

  private indexKey(topicId: number, fileIndex: number): string {
    return `${topicId}:${fileIndex}`;
  }

  async ensureIndex(topicId: number, fileIndex: number): Promise<MkvIndex> {
    const key = this.indexKey(topicId, fileIndex);
    const cached = this.indexCache.get(key);
    if (cached) return cached;
    const cooldown = this.failUntil.get(key);
    if (cooldown && Date.now() < cooldown) {
      throw new Error('индекс MKV ещё не готов');
    }
    try {
      const { file } = await this.stream.getFile(topicId, fileIndex);
      // Cues (seek-индекс) лежит в хвосте — приоритизируем и коротко ждём, чтобы
      // первая попытка чаще удавалась; иначе перечитаем на следующем запросе.
      try {
        await this.stream.prioritizeTail(topicId, fileIndex);
        await this.stream.waitForBytes(
          topicId,
          fileIndex,
          Math.max(0, file.length - TAIL_BYTES),
          file.length - 1,
          3000,
        );
      } catch {
        /* ignore */
      }
      const index = await MkvIndex.load(
        (s, e, t) => this.stream.readBytes(topicId, fileIndex, s, e, t),
        file.length,
      );
      // Кешируем только полный индекс (с Cues). Если хвост ещё не скачан — cues
      // пустые, и кешировать нельзя: иначе «нет Cues» останется навсегда.
      if (index.cues.length > 0) {
        this.indexCache.set(key, index);
        this.failUntil.delete(key);
        log.info(
          `[subs] index ${topicId}:${fileIndex} tracks=${index.subtitleTracks
            .map((t) => `${t.trackNumber}:${t.codec ?? '?'}`)
            .join(',')} cues=${index.cues.length}`,
        );
      } else {
        this.failUntil.set(key, Date.now() + SubtitleManager.INDEX_COOLDOWN_MS);
        log.warn(
          `[subs] index ${topicId}:${fileIndex} cues not ready (tail not downloaded), retry in ${SubtitleManager.INDEX_COOLDOWN_MS / 1000}s`,
        );
      }
      return index;
    } catch (e) {
      this.failUntil.set(key, Date.now() + SubtitleManager.INDEX_COOLDOWN_MS);
      throw e;
    }
  }

  // Возвращает куи окна [t, t+dur] (абсолютные секунды) и флаг готовности:
  // done=true, когда все кластеры окна скачаны и распарсены.
  async extractWindow(
    topicId: number,
    fileIndex: number,
    trackPosition: number,
    t: number,
    dur: number,
    language?: string | null,
  ): Promise<{ cues: SubtitleCue[]; done: boolean }> {
    const key = `${topicId}:${fileIndex}:${trackPosition}:${t}:${dur}`;
    const mem = this.memo.get(key);
    if (mem && mem.done && Date.now() - mem.at < 10 * 60 * 1000) {
      return { cues: mem.cues, done: true };
    }

    const index = await this.ensureIndex(topicId, fileIndex);
    const track = index.subtitleTrackFor(trackPosition, language);
    if (!track) throw new Error('субтитрная дорожка не найдена');
    if (index.cues.length === 0) throw new Error('в MKV нет Cues (seek-индекса)');

    const clusters = this.clustersForWindow(index, t, dur);
    const blocks: ParsedBlock[] = [];
    let done = true;

    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      const absPos = index.segmentDataPos + c.clusterPos;
      // Пропускаем нескачанные кластеры (дыры до позиции перемотки), не обрывая
      // извлечение — иначе не дойдём до готовых кластеров текущей позиции.
      if (!(await this.stream.areBytesReady(topicId, fileIndex, absPos, absPos + 12))) {
        done = false;
        continue;
      }
      const header = await this.stream.readBytes(topicId, fileIndex, absPos, absPos + 12, 1000);
      if (!header) {
        done = false;
        continue;
      }
      const el = parseElement(header, 0);
      // Реальный размер кластера не больше расстояния до следующего; страховка от
      // мусорного el.size (битые Cues/позиция не на начале Cluster) и от гигантских
      // значений: читаем максимум до следующего кластера и не более MAX_CLUSTER_READ.
      const next = clusters[i + 1];
      const upper = Math.min(
        next ? next.clusterPos - c.clusterPos : MAX_CLUSTER_READ_BYTES,
        MAX_CLUSTER_READ_BYTES,
      );
      const rawSize = el.ok && el.size > 0 ? el.size : upper;
      const size = Math.min(rawSize, upper);
      if (size <= 0) {
        done = false;
        continue;
      }
      if (!(await this.stream.areBytesReady(topicId, fileIndex, absPos, absPos + size))) {
        done = false;
        continue;
      }
      const buf = await this.stream.readBytes(topicId, fileIndex, absPos, absPos + size, 2000);
      if (!buf) {
        done = false;
        continue;
      }
      const el2 = parseElement(buf, 0);
      if (!el2.ok) {
        done = false;
        continue;
      }
      const parsed = parseCluster(buf.subarray(el2.dataPos), track.trackNumber);
      blocks.push(...parsed);
    }

    const cues = blocksToCues(blocks, track.codec)
      .filter((c) => c.end > t && c.start < t + dur);
    if (done) {
      this.memo.set(key, { cues, done: true, at: Date.now() });
    }
    return { cues, done };
  }

  private clustersForWindow(index: MkvIndex, t: number, dur: number): CuePoint[] {
    const cues = index.cues;
    if (cues.length === 0) return [];
    const tMs = t * 1000;
    const endMs = (t + dur) * 1000;
    // кластер, содержащий t (CuePoint ≤ t)
    let start = 0;
    while (start < cues.length && cues[start].timeMs <= tMs) start++;
    const from = Math.max(0, start - 1);
    // +2s запаса: субтитры в начале следующего кластера и длительности у конца окна
    let to = from;
    while (to < cues.length && cues[to].timeMs <= endMs + 2000) to++;
    const seen = new Set<number>();
    const out: CuePoint[] = [];
    for (let i = from; i < Math.min(to, cues.length); i++) {
      if (!seen.has(cues[i].clusterPos)) {
        seen.add(cues[i].clusterPos);
        out.push(cues[i]);
      }
    }
    return out;
  }

  // Точный байт (смещение в файле) кластера, содержащего момент `sec`, по MKV Cues.
  // Для VBR-файлов оценка `frac*size` сильно ошибается, поэтому для seek приоритизируем
  // реальный кластер. Возвращает null, если индекс (Cues) ещё не готов.
  async seekByteFor(topicId: number, fileIndex: number, sec: number): Promise<number | null> {
    try {
      const index = await this.ensureIndex(topicId, fileIndex);
      return clusterByteForTime(index.cues, index.segmentDataPos, sec);
    } catch {
      return null;
    }
  }

  stopTopic(topicId: number): void {
    for (const key of this.indexCache.keys()) {
      if (key.startsWith(`${topicId}:`)) this.indexCache.delete(key);
    }
    for (const key of this.failUntil.keys()) {
      if (key.startsWith(`${topicId}:`)) this.failUntil.delete(key);
    }
    this.memo.clear();
  }

  stopFile(topicId: number, fileIndex: number): void {
    const key = this.indexKey(topicId, fileIndex);
    this.indexCache.delete(key);
    this.failUntil.delete(key);
    this.memo.clear();
  }

  stopAll(): void {
    this.indexCache.clear();
    this.failUntil.clear();
    this.memo.clear();
  }
}
