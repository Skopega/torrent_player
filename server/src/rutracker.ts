import * as cheerio from 'cheerio';
import { resolveUrl, BASE_URL } from './http.js';
import type { SearchResult, Topic, TopicField } from './types.js';
import { formatBytes } from './types.js';

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function parseNum(s: string): number {
  const n = parseInt(s.replace(/[\s\u00a0]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

// Упрощённое разрешение из названия раздачи: "4K" / "1080p" / "720p" / "480p".
// Только явные маркеры; рип-типы (BDRip/WEB-DL и т.п.) не угадываем — точнее
// разрешение берём из размеров кадра в поле "Видео".
export function parseResolution(title: string): string | null {
  const t = title;
  if (/\b2160p\b|\b4k\b|\b4к\b|\buhd\b|ultra\s*hd/i.test(t)) return '4K';
  if (/\b1440p\b/i.test(t)) return '1440p';
  if (/\b1080p\b|\b1080i\b|full\s*hd/i.test(t)) return '1080p';
  if (/\b720p\b/i.test(t)) return '720p';
  if (/\b576p\b/i.test(t)) return '576p';
  if (/\b480p\b/i.test(t)) return '480p';
  if (/\b360p\b/i.test(t)) return '360p';
  if (/DVDRip|DVD5|DVD9/i.test(t)) return '480p';
  if (/CAMRip|Telesync|\bCAM\b/i.test(t)) return '360p';
  return null;
}

// Разрешение из размеров кадра вида "1920x1080" / "1152*482" (анаморфный 720p)
// / "852x480" / "704x384". Разделители: x, х (кириллица), ×, *.
export function resolutionFromDimensions(text: string): string | null {
  const m = text.match(/(\d{3,4})\s*[xх×*]\s*(\d{3,4})/);
  if (!m) return null;
  const w = parseInt(m[1], 10);
  if (w >= 3200) return '4K';
  if (w >= 2500) return '1440p';
  if (w >= 1900) return '1080p';
  if (w >= 1080) return '720p'; // 1280 и анаморфные 1152 с PAR
  if (w >= 1000) return '576p';
  if (w >= 840) return '480p';
  return '360p';
}

// Битрейт из строки вида "2291 Kbps" / "≈10 500 кбит/с" / "6 000 kb/s".
export function parseBitrate(text: string): string | null {
  const lower = text.toLowerCase();
  const m = lower.match(
    /(\d+(?:[.,\s]\d+)*)\s*(кбит|мбит|kbit|mbit|kbps|mbps|кб|мб|kb|mb)(?:\/с|\/s)?/,
  );
  if (!m) return null;
  const raw = parseFloat(m[1].replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const isMbps = /^(мбит|мб|mbit|mb|mbps)/.test(m[2]);
  const mbps = isMbps ? raw : raw / 1000;
  if (mbps >= 1) return `${Math.round(mbps)} Mbps`;
  return `${Math.round(raw)} Kbps`;
}

// Длительность фильма/серии или число серий сериала.
export function parseDuration(fields: TopicField[]): string | null {
  const dur = fields.find((f) => /продолжитель|длит/i.test(f.key));
  if (dur?.value && dur.value.trim()) return dur.value.trim();
  const ep = fields.find((f) => /сери/i.test(f.key));
  if (ep) {
    const n = ep.value.match(/\d+/)?.[0];
    return n ? `${n} серий` : null;
  }
  return null;
}

export function parseSearch(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  $('tr.hl-tr').each((_, el) => {
    const $row = $(el);
    const idAttr = $row.attr('data-topic_id') ?? $row.attr('id')?.replace('trs-tr-', '') ?? '0';
    const id = parseNum(idAttr);
    if (!id) return;

    const rawTitle = collapse($row.find('td.t-title-col a.tLink').text());
    // Для сетки оставляем только основное название (до первой скобки с метаданными).
    const title = rawTitle.replace(/\s*[(\[].*$/, '').trim();
    const tags = $row
      .find('td.t-title-col a.tLink span.brackets-pair')
      .map((_, el) => collapse($(el).text()))
      .get()
      .filter(Boolean);
    const category = collapse($row.find('td.f-name-col .f-name a').text());

    const sizeEl = $row.find('td.tor-size');
    const sizeBytes = parseNum(sizeEl.attr('data-ts_text') ?? '0');
    const sizeHuman = formatBytes(sizeBytes);

    const seeds = parseNum($row.find('b.seedmed').text());
    const leech = parseNum($row.find('td.leechmed').text());
    const downloads = parseNum($row.find('td.number-format').text());
    const date = collapse($row.find('td p').first().text());

    results.push({
      id,
      title,
      category,
      size: sizeBytes,
      sizeHuman,
      seeds,
      leech,
      downloads,
      date,
      poster: null,
      resolution: parseResolution(rawTitle),
      tags,
      duration: null,
    });
  });

  return results;
}

function extractFieldsAndDescription(
  bodyText: string,
  keys: string[],
): { fields: TopicField[]; description: string } {
  const lines = bodyText.split(/\r?\n/);
  const keyLines: { key: string; line: number }[] = [];
  const seen = new Set<string>();

  for (const rawKey of keys) {
    const key = rawKey.trim().replace(/:\s*$/, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const re = new RegExp('^' + escapeRegExp(key) + '\\s*:\\s*(.*)$');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i].trim())) {
        keyLines.push({ key, line: i });
        break;
      }
    }
  }

  const fields: TopicField[] = keyLines.map((kl, idx) => {
    const nextLine = idx + 1 < keyLines.length ? keyLines[idx + 1].line : lines.length;
    const sameLine = lines[kl.line].replace(
      new RegExp('^' + escapeRegExp(kl.key) + '\\s*:\\s*'),
      '',
    );
    const parts: string[] = [];
    if (sameLine.trim()) parts.push(sameLine.trim());

    let i = kl.line + 1;
    if (parts.length === 0) {
      while (i < nextLine && !lines[i].trim()) i++;
    }
    for (; i < nextLine; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) break;
      parts.push(trimmed);
    }
    const value = parts.join(' ').trim();
    return { key: kl.key, value };
  });

  const descStart = keyLines.length ? keyLines[keyLines.length - 1].line + 1 : 0;
  const description = lines
    .slice(descStart)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  return { fields, description };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Сайтовые ассеты рутрекера (ранги, смайлы, флаги, аватары, кнопки) не являются
// постерами — пропускаем их. Реальные постеры лежат на внешних хостингах или
// во вложениях, но не на static.rutracker.cc.
function isDecorationImage(url: string): boolean {
  if (/\/ranks\/|\/smiles\/|\/flags\/|\/avatars\/|\/buttons\//i.test(url)) return true;
  try {
    return /static\.rutracker\.(cc|org)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Выбирает URL постера из тела поста. Приоритет:
// выровненный вправо постер (img-right) → новый формат var.postImg →
// любой выровненный → любое postImg. Сайтовые ассеты пропускаются.
function pickPoster(
  $: cheerio.CheerioAPI,
  postBody: cheerio.Cheerio<any>,
): string | null {
  const selectors = [
    'img.postImg.postImgAligned.img-right',
    'var.postImg.postImgAligned',
    'img.postImg.postImgAligned',
    'img.postImg, var.postImg',
  ];
  for (const sel of selectors) {
    const el = postBody
      .find(sel)
      .get()
      .find((e) => {
        const src = $(e).attr('src') ?? $(e).attr('title');
        return !!src && !isDecorationImage(src);
      });
    if (el) {
      const src = $(el).attr('src') ?? $(el).attr('title');
      if (src) return resolveUrl(src, BASE_URL);
      break;
    }
  }
  return null;
}

export function parseTopic(html: string, id: number): Topic {
  const $ = cheerio.load(html);

  const title = collapse($('h1.maintitle a#topic-title').text());
  const category = collapse($('td.t-breadcrumb-top a').last().text());

  const postBody = $('div.post_body').first();
  const poster = pickPoster($, postBody);

  const keySpans = postBody
    .find('span.post-b')
    .map((_, el) => $(el).text().trim())
    .get();

  const textClone = postBody.clone();
  textClone.find('img').remove();
  textClone.find('script, style').remove();
  textClone.find('br').replaceWith('\n');
  textClone.find('hr').replaceWith('\n\n');
  const bodyText = textClone.text();

  const { fields, description } = extractFieldsAndDescription(bodyText, keySpans);

  const seeds = parseNum($('span.seed b').first().text());
  const leech = parseNum($('span.leech b').first().text());
  const sizeBytes = parseNum($('#tor-size-humn').attr('title') ?? '0');
  const sizeHuman = formatBytes(sizeBytes);

  const downloadsMatch = html.match(/Скачан:\s*([\d\s.,]+)\s*раза?/);
  const downloads = downloadsMatch ? parseNum(downloadsMatch[1]) : 0;

  const dateMatch = html.match(/(\d{1,2}-[А-Яа-я]{3,4}-\d{2,4})/);
  const dateAdded = dateMatch ? dateMatch[1] : '';

  const magnet = $('a[href^="magnet:"]').first().attr('href') ?? null;

  const videoField = fields.find((f) => f.key.trim().toLowerCase() === 'видео');
  const bitrate = videoField ? parseBitrate(videoField.value) : null;
  // Разрешение: точнее из размеров кадра в поле «Видео», фолбэки — маркер из
  // поля «Качество видео» (например "WEB-DL 1080p") и из названия.
  const resolution =
    (videoField ? resolutionFromDimensions(videoField.value) : null) ??
    (fields.some((f) => /качество\s*видео/i.test(f.key))
      ? parseResolution(fields.find((f) => /качество\s*видео/i.test(f.key))!.value)
      : null) ??
    parseResolution(title);
  const duration = parseDuration(fields);

  return {
    id,
    title,
    category,
    poster,
    fields,
    description,
    sizeBytes,
    sizeHuman,
    seeds,
    leech,
    downloads,
    dateAdded,
    magnet,
    bitrate,
    resolution,
    duration,
  };
}
