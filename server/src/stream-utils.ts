export const VIDEO_EXTENSIONS = new Set<string>([
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
  '.mpg',
  '.mpeg',
  '.ts',
  '.m2ts',
  '.mts',
  '.ogv',
  '.wmv',
  '.flv',
  '.3gp',
  '.vob',
]);

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.ogv': 'video/ogg',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.vob': 'video/mpeg',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.opus': 'audio/opus',
};

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i < 0) return '';
  return name.slice(i).toLowerCase();
}

export function mimeFor(name: string): string {
  return MIME_BY_EXT[extOf(name)] ?? 'application/octet-stream';
}

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.has(extOf(name));
}

export interface Episode {
  season: number;
  episode: number;
}

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

// Естественное сравнение строк с учётом чисел: "серия 2" < "серия 10" < "серия 21".
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

// Извлекает (сезон, серия) из имени файла: S01E02, 1x02, "серия 02",
// "сезон 1 серия 2" и т.п. Возвращает null, если распознать не удалось.
export function episodeOf(name: string): Episode | null {
  // S01E01 / S1E2 / S01 E01
  let m = /\b[Ss](\d{1,2})\s*[EeЕе]\s*(\d{1,3})\b/.exec(name);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };

  // 1x01 / 01x02 / 1X02 / 1х02
  m = /\b(\d{1,2})\s*[xXхХ]\s*(\d{1,3})\b/.exec(name);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };

  // "сезон 1 серия 02"
  m = /сезон\s*(\d{1,2}).{0,15}?сери[яиюй]\s*(\d{1,3})/iu.exec(name);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };

  // "серия 02" / "эпизод 1" / "episode 1" / "ep 1" / "эп 1"
  m = /(?:сери[яиюй]|эпизод|эп|episode|ep)\s*[.:_ \-]*\s*(\d{1,3})/iu.exec(name);
  if (m) return { season: 1, episode: Number(m[1]) };

  return null;
}

// Компаратор для видеофайлов раздачи: сначала по (сезон, серия), затем
// по естественному порядку имён. Не-видео идут после видео (см. files()).
export function compareEpisodes(a: string, b: string): number {
  const ea = episodeOf(a);
  const eb = episodeOf(b);
  if (ea && eb) {
    if (ea.season !== eb.season) return ea.season - eb.season;
    if (ea.episode !== eb.episode) return ea.episode - eb.episode;
    return naturalCompare(a, b);
  }
  if (ea && !eb) return -1;
  if (!ea && eb) return 1;
  return naturalCompare(a, b);
}

export type RangeResult =
  | { kind: 'none' }
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'invalid' };

// Парсит HTTP-заголовок `Range: bytes=...`. Берёт первый диапазон,
// игнорирует мультидиапазоны (браузеры для <video> их не шлют).
export function parseRangeHeader(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'none' };
  const first = header.split(',')[0]?.trim() ?? '';
  const m = /^bytes=(\d*)-(\d*)$/i.exec(first);
  if (!m) return { kind: 'invalid' };

  const [, s1, s2] = m;
  let start: number;
  let end: number;

  if (s1 === '') {
    // suffix range: последние N байт
    const suffix = Number(s2);
    if (!Number.isFinite(suffix) || suffix <= 0 || size === 0) return { kind: 'invalid' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(s1);
    if (!Number.isFinite(start)) return { kind: 'invalid' };
    if (s2 === '') {
      end = size - 1;
    } else {
      const e = Number(s2);
      if (!Number.isFinite(e)) return { kind: 'invalid' };
      end = Math.min(e, size - 1);
    }
  }

  if (start < 0 || size === 0 || start >= size) return { kind: 'invalid' };
  if (end < start) return { kind: 'invalid' };
  return { kind: 'partial', start, end };
}

// Отображает диапазон байт внутри файла на индексы кусков торрента.
export function pieceRange(
  fileOffset: number,
  start: number,
  end: number,
  pieceLength: number,
): { first: number; last: number } {
  const first = Math.floor((fileOffset + start) / pieceLength);
  const last = Math.floor((fileOffset + end) / pieceLength);
  return { first, last };
}

const DIRECT_CONTAINERS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.ogv', '.ogg', '.3gp']);
const DIRECT_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
const DIRECT_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis']);

const TEXT_SUB_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'webvtt',
  'mov_text',
  'text',
  'sub_viewer',
  'subviewer',
  'microdvd',
  'mpl2',
]);

export function isTextSubtitleCodec(codec: string | null): boolean {
  return codec != null && TEXT_SUB_CODECS.has(codec.toLowerCase());
}

// Сдвиг субтитров по вертикали: добавляет cue-настройку (например `line:-2`)
// к каждой строке тайминга WebVTT. Строки заголовка/NOTE/STYLE не трогаются.
export function applyWebVttCueSetting(vtt: string, setting: string): string {
  return vtt
    .split(/\r?\n/)
    .map((line) => (line.includes('-->') ? `${line} ${setting}` : line))
    .join('\n');
}

function vttTimeToSec(t: string): number {
  const parts = t.trim().replace(',', '.').split(':');
  let sec = 0;
  for (const p of parts) sec = sec * 60 + Number.parseFloat(p);
  return sec;
}

function vttSecToTime(s: number): string {
  const ms = Math.round(Math.max(0, s) * 1000);
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(sec, 2)}.${pad(mmm, 3)}`;
}

// Тайминг WebVTT: HH:MM:SS.mmm либо MM:SS.mmm (ffmpeg отдаёт короткую форму
// для времени меньше часа).
const VTT_TS = '\\d{1,2}:(?:\\d{2}:)?\\d{2}[.,]\\d{3}';
const VTT_TIMING_RE = new RegExp(`(${VTT_TS})\\s*-->\\s*(${VTT_TS})`);

// Сдвигает тайминги WebVTT на offsetSec (секунды вычитаются). Нужно, чтобы
// встроенные субтитры совпадали с фрагментом HLS, который стартует не с нуля.
// Куски, целиком оказавшиеся до сдвига, выкидываются; начало обрезается в 0.
export function shiftWebVttTimestamps(vtt: string, offsetSec: number): string {
  if (!Number.isFinite(offsetSec) || offsetSec <= 0) return vtt;
  const blocks = vtt.replace(/\r\n/g, '\n').split('\n\n');
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) {
      out.push(block);
      continue;
    }
    const timing = lines[idx];
    const m = VTT_TIMING_RE.exec(timing);
    if (!m) {
      out.push(block);
      continue;
    }
    const start = vttTimeToSec(m[1]) - offsetSec;
    const end = vttTimeToSec(m[2]) - offsetSec;
    if (end <= 0) continue;
    const settings = timing.slice(m.index + m[0].length).trim();
    const newTiming = `${vttSecToTime(start)} --> ${vttSecToTime(end)}${settings ? ' ' + settings : ''}`;
    lines[idx] = newTiming;
    out.push(lines.join('\n'));
  }
  return out.join('\n\n');
}

// Возвращает VTT только с куи, попадающими в окно [t, t+dur], сдвинутые на
// shiftSec (обычно на старт HLS-сессии). coverage — максимальный конец куи в
// файле (абсолютные секунды), чтобы клиент понимал, докуда дошло извлечение.
export function windowWebVtt(
  vtt: string,
  t: number,
  dur: number,
  shiftSec: number,
): { vtt: string; coverage: number } {
  const windowEnd = t + dur;
  const blocks = vtt.replace(/\r\n/g, '\n').split('\n\n');
  const out: string[] = [];
  let coverage = 0;
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) {
      if (block.trim() === '' || /^(WEBVTT|NOTE|STYLE)/i.test(block.trim())) continue;
      out.push(block);
      continue;
    }
    const timing = lines[idx];
    const m = VTT_TIMING_RE.exec(timing);
    if (!m) continue;
    const start = vttTimeToSec(m[1]);
    const end = vttTimeToSec(m[2]);
    coverage = Math.max(coverage, end);
    if (end <= t || start >= windowEnd) continue;
    const shiftedStart = start - shiftSec;
    const shiftedEnd = end - shiftSec;
    if (shiftedEnd <= 0) continue;
    const settings = timing.slice(m.index + m[0].length).trim();
    lines[idx] = `${vttSecToTime(shiftedStart)} --> ${vttSecToTime(shiftedEnd)}${settings ? ' ' + settings : ''}`;
    out.push(lines.join('\n'));
  }
  return { vtt: 'WEBVTT\n\n' + out.join('\n\n').trimEnd(), coverage };
}

// Максимальный конец куи (абсолютные секунды) в VTT — «докуда дошло извлечение».
export function lastWebVttEnd(vtt: string): number {
  let cov = 0;
  for (const m of vtt.matchAll(new RegExp(VTT_TIMING_RE.source, 'g'))) {
    cov = Math.max(cov, vttTimeToSec(m[2]));
  }
  return cov;
}

export function canDirectPlay(
  ext: string,
  videoCodec: string | null,
  audioCodec: string | null,
): boolean {
  if (!DIRECT_CONTAINERS.has(ext)) return false;
  if (videoCodec && !DIRECT_VIDEO_CODECS.has(videoCodec)) return false;
  if (audioCodec && !DIRECT_AUDIO_CODECS.has(audioCodec)) return false;
  return Boolean(videoCodec || audioCodec);
}
