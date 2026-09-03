// Мини-демультиплексор Matroska для текстовых субтитров.
// Читает структуру MKV (Tracks, Cues, Cluster) напрямую из байтов файла
// (куски уже скачаны торрентом), чтобы достать субтитры для окна времени без
// ffmpeg-поверх-видеопотока и без ожидания полной закачки.

export interface SubtitleTrack {
  trackNumber: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  defaultFlag: boolean;
  forcedFlag: boolean;
}

export interface CuePoint {
  timeMs: number;
  clusterPos: number;
}

export interface SubtitleCue {
  start: number; // секунды
  end: number;
  text: string;
}

export type ReadRange = (
  start: number,
  end: number,
  timeoutMs?: number,
) => Promise<Buffer | null>;

const ELEM_MAX_HEAD = 12;

const ID_SEGMENT = 0x18538067;
const ID_SEEKHEAD = 0x114d9b74;
const ID_TRACKS = 0x1654ae6b;
const ID_CUES = 0x1c53bb6b;
const ID_CLUSTER = 0x1f43b675;
const ID_SEEK = 0x4dbb;
const ID_SEEK_ID = 0x53ab;
const ID_SEEK_POS = 0x53ac;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_LANGUAGE = 0x22b59c;
const ID_NAME = 0x536e;
const ID_DEFAULT_FLAG = 0x55aa;
const ID_FORCED_FLAG = 0x55ae;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TIME = 0xb3;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_CLUSTER_POS = 0xf1;
const ID_CLUSTER_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;

export function readVint(
  buf: Buffer,
  pos: number,
): { value: number; size: number; marker: number; ok: boolean } {
  if (pos >= buf.length) return { value: 0, size: 0, marker: 0, ok: false };
  const first = buf[pos];
  let mask = 0x80;
  let len = 1;
  while (len <= 8 && !(first & mask)) {
    mask >>= 1;
    len++;
  }
  if (len > 8 || pos + len > buf.length) return { value: 0, size: 0, marker: 0, ok: false };
  // NB: нельзя `value = (value << 8) | ...` — это 32-битные битовые операции,
  // обрезающие значения больше 2 ГБ (размер Segment у больших MKV). Умножение
  // в double сохраняет до 2^53.
  let value = first & (mask - 1);
  for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i];
  return { value, size: len, marker: mask, ok: true };
}

// EBML-идентификатор элемента включает маркерный бит (0x1A45DFA3, а не 0x0A45DFA3).
export function readVintId(buf: Buffer, pos: number): { value: number; size: number; ok: boolean } {
  const v = readVint(buf, pos);
  if (!v.ok) return { value: 0, size: 0, ok: false };
  return { value: v.value + v.marker * 2 ** (8 * (v.size - 1)), size: v.size, ok: true };
}

export function parseElement(
  buf: Buffer,
  pos: number,
): { id: number; size: number; dataPos: number; ok: boolean } {
  if (pos >= buf.length) return { id: 0, size: 0, dataPos: 0, ok: false };
  const idV = readVintId(buf, pos);
  if (!idV.ok) return { id: 0, size: 0, dataPos: 0, ok: false };
  const sizeV = readVint(buf, pos + idV.size);
  if (!sizeV.ok) return { id: 0, size: 0, dataPos: 0, ok: false };
  const dataPos = pos + idV.size + sizeV.size;
  // Размер «unknown» (все биты vint = 1): считаем 0 (не читаемо целиком).
  // `2 **` вместо `1 <<`, чтобы не обрезаться 32-битным сдвигом при 8-байтовом vint.
  const unknownMask = 2 ** (sizeV.size * 7) - 1;
  const size = sizeV.value === unknownMask ? 0 : sizeV.value;
  return { id: idV.value, size, dataPos, ok: true };
}

function readUint(buf: Buffer, pos: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + (buf[pos + i] ?? 0);
  return v;
}

function readInt(buf: Buffer, pos: number, size: number): number {
  let v = readUint(buf, pos, size);
  const bits = size * 8;
  const sign = 1 << (bits - 1);
  if (v & sign) v -= 1 << bits;
  return v;
}

export class MkvIndex {
  constructor(
    readonly segmentDataPos: number,
    readonly subtitleTracks: SubtitleTrack[],
    readonly cues: CuePoint[],
  ) {}

  subtitleTrackByPosition(pos: number): SubtitleTrack | undefined {
    return this.subtitleTracks[pos];
  }

  // Выбирает субтитрную дорожку: сначала по языку (если язык уникален), иначе по
  // позиции. Нужно, т.к. порядок дорожек у ffprobe может не совпадать с порядком
  // TrackEntry в MKV, и «по позиции» иногда попадаешь в дорожку другого языка.
  subtitleTrackFor(position: number, language: string | null | undefined): SubtitleTrack | undefined {
    if (language) {
      const l = language.toLowerCase();
      const matches = this.subtitleTracks.filter(
        (t) => t.language && t.language.toLowerCase() === l,
      );
      if (matches.length === 1) return matches[0];
    }
    return this.subtitleTracks[position];
  }

  static async load(readRange: ReadRange, fileSize: number): Promise<MkvIndex> {
    // Заголовок (EBML + Segment + SeekHead) лежит в самых первых КБ файла.
    // Читаем небольшой блок (не весь 4МБ) — начало скачано, т.к. ffmpeg его
    // читает для открытия. Tracks и Cues дочитываем точечно по позициям из SeekHead.
    const headLen = Math.min(fileSize, 256 * 1024);
    const head = await readRange(0, headLen, 15000);
    if (!head) throw new Error('не удалось прочитать заголовок MKV');

    const seg = findSegment(head);
    if (!seg) throw new Error('не найден Segment в MKV');
    const { seekHead, tracksData: scannedTracks } = parseSegmentHeader(head, seg.segDataPos);

    let subtitleTracks: SubtitleTrack[] = [];
    const tracksRel = seekHead.get(ID_TRACKS);
    if (tracksRel != null) {
      const td = await readElementData(readRange, seg.segDataPos + tracksRel);
      if (td) subtitleTracks = parseTracks(td);
    } else if (scannedTracks) {
      subtitleTracks = parseTracks(scannedTracks);
    }

    let cues: CuePoint[] = [];
    const cuesRel = seekHead.get(ID_CUES);
    if (cuesRel != null) {
      const cd = await readElementData(readRange, seg.segDataPos + cuesRel);
      if (cd) cues = parseCues(cd);
    }
    return new MkvIndex(seg.segDataPos, subtitleTracks, cues);
  }
}

export function findSegment(buf: Buffer): { segDataPos: number; segSize: number } | null {
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const el = parseElement(buf, pos);
    if (!el.ok || el.size <= 0) return null;
    if (el.id === ID_SEGMENT) return { segDataPos: el.dataPos, segSize: el.size };
    pos = el.dataPos + el.size;
  }
  return null;
}

// Итерирует верхнеуровневые элементы сегмента в пределах head и собирает
// SeekHead (карту id→позиция) и данные Tracks.
function parseSegmentHeader(
  head: Buffer,
  segDataPos: number,
): { seekHead: Map<number, number>; tracksData: Buffer | null } {
  const seekHead = new Map<number, number>();
  let tracksData: Buffer | null = null;
  let pos = segDataPos;
  while (pos + 4 <= head.length) {
    const el = parseElement(head, pos);
    if (!el.ok || el.size <= 0) break;
    if (el.id === ID_SEEKHEAD) {
      parseSeekHead(head.subarray(el.dataPos, Math.min(el.dataPos + el.size, head.length)), seekHead);
    } else if (el.id === ID_TRACKS) {
      tracksData = head.subarray(el.dataPos, Math.min(el.dataPos + el.size, head.length));
    } else if (el.id === ID_CLUSTER) {
      break; // заголовок закончился
    }
    pos = el.dataPos + el.size;
  }
  return { seekHead, tracksData };
}

function parseSeekHead(data: Buffer, out: Map<number, number>): void {
  let pos = 0;
  while (pos + 4 <= data.length) {
    const el = parseElement(data, pos);
    if (!el.ok || el.size <= 0) break;
    if (el.id === ID_SEEK) {
      parseSeek(data.subarray(el.dataPos, Math.min(el.dataPos + el.size, data.length)), out);
    }
    pos = el.dataPos + el.size;
  }
}

// Читает элемент по абсолютной позиции: сначала заголовок (12 байт) для размера,
// затем тело. Возвращает данные элемента (без ID/размера) или null, если куски
// ещё не скачаны.
async function readElementData(
  readRange: ReadRange,
  absPos: number,
): Promise<Buffer | null> {
  const hdr = await readRange(absPos, absPos + ELEM_MAX_HEAD, 2000);
  if (!hdr) return null;
  const el = parseElement(hdr, 0);
  if (!el.ok || el.size <= 0) return null;
  const buf = await readRange(absPos, absPos + el.size, 3000);
  if (!buf) return null;
  return buf.subarray(el.dataPos);
}

function parseSeek(data: Buffer, out: Map<number, number>): void {
  let id = 0;
  let rel = 0;
  let pos = 0;
  while (pos + 4 <= data.length) {
    const el = parseElement(data, pos);
    if (!el.ok || el.size <= 0) break;
    if (el.id === ID_SEEK_ID) {
      const v = readVintId(data, el.dataPos);
      if (v.ok) id = v.value;
    } else if (el.id === ID_SEEK_POS) {
      rel = readUint(data, el.dataPos, Math.min(el.size, 8));
    }
    pos = el.dataPos + el.size;
  }
  if (id) out.set(id, rel);
}

function parseTracks(data: Buffer): SubtitleTrack[] {
  const out: SubtitleTrack[] = [];
  let pos = 0;
  while (pos + 4 <= data.length) {
    const el = parseElement(data, pos);
    if (!el.ok || el.size <= 0) break;
    if (el.id === ID_TRACK_ENTRY) {
      const t = parseTrackEntry(data.subarray(el.dataPos, Math.min(el.dataPos + el.size, data.length)));
      if (t.type === 0x11) {
        out.push({
          trackNumber: t.number,
          codec: t.codec,
          language: t.language,
          title: t.title,
          defaultFlag: t.defaultFlag,
          forcedFlag: t.forcedFlag,
        });
      }
    }
    pos = el.dataPos + el.size;
  }
  return out;
}

function parseTrackEntry(data: Buffer): {
  number: number;
  type: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  defaultFlag: boolean;
  forcedFlag: boolean;
} {
  const t = {
    number: 0,
    type: 0,
    codec: null as string | null,
    language: null as string | null,
    title: null as string | null,
    defaultFlag: false,
    forcedFlag: false,
  };
  let pos = 0;
  while (pos + 4 <= data.length) {
    const el = parseElement(data, pos);
    if (!el.ok || el.size <= 0) break;
    const dPos = el.dataPos;
    const dLen = Math.min(el.size, data.length - dPos);
    if (el.id === ID_TRACK_NUMBER) t.number = readUint(data, dPos, dLen);
    else if (el.id === ID_TRACK_TYPE) t.type = readUint(data, dPos, dLen);
    else if (el.id === ID_CODEC_ID) t.codec = data.subarray(dPos, dPos + dLen).toString('utf8');
    else if (el.id === ID_LANGUAGE) t.language = data.subarray(dPos, dPos + dLen).toString('utf8');
    else if (el.id === ID_NAME) t.title = data.subarray(dPos, dPos + dLen).toString('utf8');
    else if (el.id === ID_DEFAULT_FLAG) t.defaultFlag = readUint(data, dPos, dLen) === 1;
    else if (el.id === ID_FORCED_FLAG) t.forcedFlag = readUint(data, dPos, dLen) === 1;
    pos = el.dataPos + el.size;
  }
  return t;
}

function parseCues(data: Buffer): CuePoint[] {
  const out: CuePoint[] = [];
  let pos = 0;
  while (pos + 4 <= data.length) {
    const el = parseElement(data, pos);
    if (!el.ok || el.size <= 0) break;
    if (el.id === ID_CUE_POINT) {
      const p = parseCuePoint(data.subarray(el.dataPos, Math.min(el.dataPos + el.size, data.length)));
      if (p) out.push(p);
    }
    pos = el.dataPos + el.size;
  }
  return out;
}

// Возвращает байт (абсолютное смещение в файле) кластера, содержащего момент `sec`,
// по списку CuePoint. Для VBR-файлов это точнее, чем оценка `frac*size`. null — нет Cues.
export function clusterByteForTime(
  cues: CuePoint[],
  segmentDataPos: number,
  sec: number,
): number | null {
  if (cues.length === 0) return null;
  const tMs = sec * 1000;
  let best: CuePoint | null = null;
  for (const c of cues) {
    if (c.timeMs <= tMs) best = c;
    else break;
  }
  if (!best) best = cues[0];
  return segmentDataPos + best.clusterPos;
}

function parseCuePoint(data: Buffer): CuePoint | null {
  let time = 0;
  let clusterPos = 0;
  let pos = 0;
  while (pos + 4 <= data.length) {
    const el = parseElement(data, pos);
    if (!el.ok || el.size <= 0) break;
    if (el.id === ID_CUE_TIME) time = readUint(data, el.dataPos, Math.min(el.size, 8));
    else if (el.id === ID_CUE_TRACK_POSITIONS) {
      let p = el.dataPos;
      const end = Math.min(el.dataPos + el.size, data.length);
      while (p + 4 <= end) {
        const e2 = parseElement(data, p);
        if (!e2.ok || e2.size <= 0) break;
        if (e2.id === ID_CUE_CLUSTER_POS) clusterPos = readUint(data, e2.dataPos, Math.min(e2.size, 8));
        p = e2.dataPos + e2.size;
      }
    }
    pos = el.dataPos + el.size;
  }
  return clusterPos > 0 ? { timeMs: time, clusterPos } : null;
}

// --- Кластеры ---

export interface ParsedBlock {
  ptsMs: number;
  durMs: number | null;
  track: number;
  payload: Buffer;
}

// Парсит данные кластера (полные байты от начала элемента Cluster) и возвращает
// блоки нужной дорожки с абсолютными таймкодами (мс).
export function parseCluster(clusterBuf: Buffer, trackNumber: number): ParsedBlock[] {
  let clusterTimecode = 0;
  const blocks: ParsedBlock[] = [];
  let pos = 0;
  while (pos + 4 <= clusterBuf.length) {
    const el = parseElement(clusterBuf, pos);
    if (!el.ok || el.size <= 0) break;
    const end = Math.min(el.dataPos + el.size, clusterBuf.length);
    if (el.id === ID_CLUSTER_TIMECODE) {
      clusterTimecode = readInt(clusterBuf, el.dataPos, Math.min(el.size, 8));
    } else if (el.id === ID_SIMPLE_BLOCK) {
      const b = parseBlock(clusterBuf, el.dataPos, end);
      if (b) blocks.push(b);
    } else if (el.id === ID_BLOCK_GROUP) {
      const b = parseBlockGroup(clusterBuf, el.dataPos, end);
      if (b) blocks.push(b);
    }
    pos = el.dataPos + el.size;
  }
  return blocks
    .filter((b) => b.track === trackNumber)
    .map((b) => ({ ...b, ptsMs: b.ptsMs + clusterTimecode }));
}

function parseBlock(data: Buffer, start: number, end: number): ParsedBlock | null {
  let pos = start;
  const tv = readVint(data, pos);
  if (!tv.ok) return null;
  pos += tv.size;
  if (pos + 2 > end) return null;
  const raw = (data[pos] << 8) | data[pos + 1];
  const rel = raw >= 0x8000 ? raw - 0x10000 : raw;
  pos += 2;
  if (pos >= end) return null;
  const flags = data[pos];
  pos += 1;
  const lacing = (flags >> 1) & 0x03;
  if (lacing !== 0) return null; // для субтитров не используется
  return { ptsMs: rel, durMs: null, track: tv.value, payload: data.subarray(pos, end) };
}

function parseBlockGroup(data: Buffer, start: number, end: number): ParsedBlock | null {
  let pos = start;
  let block: ParsedBlock | null = null;
  let durMs: number | null = null;
  while (pos + 4 <= end) {
    const el = parseElement(data, pos);
    if (!el.ok || el.size <= 0) break;
    const eEnd = Math.min(el.dataPos + el.size, end);
    if (el.id === ID_BLOCK) block = parseBlock(data, el.dataPos, eEnd);
    else if (el.id === ID_BLOCK_DURATION) durMs = readUint(data, el.dataPos, Math.min(el.size, 8));
    pos = el.dataPos + el.size;
  }
  if (!block) return null;
  if (durMs != null) block.durMs = durMs;
  return block;
}

// --- Преобразование в WebVTT ---

// Парсит ASS-событие из пакета. Форматы:
//  - mkvmerge: `Dialogue: Layer,Start,End,Style,...` (тайминги в событии);
//  - ffmpeg: `Layer,ReadOrder,Style,Name,MarginL,MarginR,MarginV,Effect,Text`
//    (без таймингов — берём pts/BlockDuration блока).
export function parseAssBlock(
  payload: Buffer,
  ptsSec: number,
  durSec: number | null,
): { start: number; end: number | null; text: string } | null {
  let line = payload.toString('utf8').replace(/\0/g, '').trim();
  if (!line) return null;
  if (line.startsWith('Dialogue:')) line = line.slice('Dialogue:'.length).trim();
  const parts = line.split(',');
  if (parts.length < 9) return null;
  const hasEmbedded =
    parts.length >= 10 && /^\d+:\d{2}:\d{2}[.,]\d{2}$/.test(parts[1].trim());
  let start: number;
  let end: number | null;
  let textFieldIdx: number;
  if (hasEmbedded) {
    start = parseAssTime(parts[1]);
    end = parseAssTime(parts[2]);
    textFieldIdx = 9;
  } else {
    start = ptsSec;
    end = durSec != null ? ptsSec + durSec : null;
    textFieldIdx = 8;
  }
  const text = cleanAssText(parts.slice(textFieldIdx).join(','));
  if (!Number.isFinite(start) || !text) return null;
  if (end != null && !Number.isFinite(end)) return null;
  return { start, end, text };
}

function parseAssTime(t: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})[.,](\d{2})$/.exec(t.trim());
  if (!m) return Number.NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
}

function cleanAssText(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/<[a-zA-Z/][^>]*>/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .trim();
}

export function parseSrtPayload(payload: Buffer): string | null {
  let text = payload.toString('utf8').replace(/\0/g, '').trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  if (/^\d+$/.test(lines[0].trim()) && lines.length > 1 && lines[1].includes('-->')) {
    text = lines.slice(2).join('\n').trim();
  }
  text = text.replace(/<[a-zA-Z/][^>]*>/g, '');
  return text || null;
}

// Превращает распарсенные блоки дорожки в куи: ASS — по встроенным таймингам
// события; SRT/текст — по таймкоду блока + длительности (BlockDuration или
// промежуток до следующей куи).
export function blocksToCues(blocks: ParsedBlock[], codec: string | null): SubtitleCue[] {
  const codecId = codec ?? '';
  if (/ass|ssa/i.test(codecId)) {
    const items: { start: number; end: number | null; text: string }[] = [];
    for (const b of blocks) {
      const cue = parseAssBlock(
        b.payload,
        b.ptsMs / 1000,
        b.durMs != null ? b.durMs / 1000 : null,
      );
      if (cue) items.push(cue);
    }
    items.sort((a, b) => a.start - b.start);
    return items.map((it, i) => ({
      start: it.start,
      end: it.end ?? (items[i + 1] ? Math.min(items[i + 1].start, it.start + 10) : it.start + 2),
      text: it.text,
    }));
  }
  const items: { start: number; text: string; dur: number | null }[] = [];
  for (const b of blocks) {
    const text = parseSrtPayload(b.payload);
    if (text) {
      items.push({
        start: b.ptsMs / 1000,
        text,
        dur: b.durMs != null ? b.durMs / 1000 : null,
      });
    }
  }
  items.sort((a, b) => a.start - b.start);
  const out: SubtitleCue[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const nextStart = items[i + 1]?.start;
    const end =
      it.dur != null
        ? it.start + it.dur
        : nextStart != null
          ? Math.min(nextStart, it.start + 10)
          : it.start + 2;
    out.push({ start: it.start, end, text: it.text });
  }
  return out;
}

export function cuesToVttText(cues: SubtitleCue[]): string {
  const blocks = cues.map((c) => `${fmtTime(c.start)} --> ${fmtTime(c.end)}\n${c.text}`);
  return 'WEBVTT\n\n' + blocks.join('\n\n');
}

// Отбирает куи, пересекающиеся с окном [t, t+dur], сдвигает на shiftSec
// (обычно старт HLS-сессии) и форматирует в WebVTT.
export function formatWindowVtt(
  cues: SubtitleCue[],
  t: number,
  dur: number,
  shiftSec: number,
): string {
  const windowEnd = t + dur;
  const out: string[] = [];
  for (const c of cues) {
    if (c.end <= t || c.start >= windowEnd) continue;
    let s = c.start - shiftSec;
    let e = c.end - shiftSec;
    if (e <= 0) continue;
    if (s < 0) s = 0;
    out.push(`${fmtTime(s)} --> ${fmtTime(e)}\n${c.text}`);
  }
  return 'WEBVTT\n\n' + out.join('\n\n');
}

export function fmtTime(sec: number): string {
  const ms = Math.round(Math.max(0, sec) * 1000);
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = ms % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(mm, 3)}`;
}
