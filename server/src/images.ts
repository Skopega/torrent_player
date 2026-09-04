import crypto from 'node:crypto';
import fs from 'node:fs';
import { HttpClient, BASE_URL, resolveUrl, USER_AGENT } from './http.js';
import { Store } from './store.js';
import { UnsafeUrlError } from './url-safe.js';

// В кеш и клиенту уходят только растровые картинки. SVG и любой HTML (бот-страница
// Cloudflare/логина) не принимаются — иначе это same-origin XSS при nosniff=off.
const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

// Определяет тип растра по сигнатуре (magic bytes). null — не картинка.
export function detectImageType(data: Buffer): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return 'image/gif';
  }
  if (
    data.length >= 12 &&
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
    return 'image/bmp';
  }
  if (
    data.length >= 12 &&
    data.toString('latin1', 4, 8) === 'ftyp' &&
    (data.toString('latin1', 8, 12) === 'avif' || data.toString('latin1', 8, 12) === 'avis')
  ) {
    return 'image/avif';
  }
  return null;
}

function mimeFromExt(url: string): string {
  try {
    const ext = url.split('?')[0];
    const e = /\.([a-z0-9]+)$/i.exec(ext)?.[1].toLowerCase();
    return (e ? EXT_MIME['.' + e] : undefined) ?? 'image/jpeg';
  } catch {
    return 'image/jpeg';
  }
}

// Ошибка загрузки изображения с известным HTTP-статусом. Позволяет различать
// «битую» картинку (4xx — источник недоступен) и временную сетевую ошибку.
export class ImageFetchError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ImageFetchError';
  }
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export class Images {
  constructor(
    private http: HttpClient,
    private store: Store,
  ) {}

  async fetch(url: string): Promise<{ data: Buffer; contentType: string }> {
    const resolved = resolveUrl(url, BASE_URL);
    const key = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 32);

    if (this.store.hasImage(key)) {
      const data = fs.readFileSync(this.store.imagePath(key));
      return { data, contentType: detectImageType(data) ?? mimeFromExt(resolved) };
    }

    // Битая картинка уже известна — не долбим источник на каждый перезапрос.
    if (this.store.hasFailedImage(key)) {
      throw new ImageFetchError(404, 'cached image failure');
    }

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      // fastpic.org различает ответы по Sec-Fetch-* (см. заголовок Vary):
      // без них запрос выглядит как API/бот и периодически отдаётся 404.
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
    };
    // Куки rutracker нужны только для вложенных картинок (rutracker.org);
    // внешние хостинги (fastpic и т.п.) в них не нуждаются.
    let host = '';
    try {
      host = new URL(resolved).hostname;
    } catch {
      /* handled ниже */
    }
    if (/rutracker\.(org|cc)$/i.test(host)) {
      const cookie = this.http.cookieHeader();
      if (cookie) headers['Cookie'] = cookie;
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Проверка схемы/хоста до запроса и на каждом редиректе внутри rawRequest.
        const res = await this.http.rawRequest(resolved, { headers }, { timeoutMs: 20000, maxBytes: MAX_IMAGE_BYTES });
        // Определённый отказ источника (4xx) — картинка битая/удалена. Не
        // повторяем (долго и бессмысленно), запоминаем и отдаём 404.
        if (res.status >= 400 && res.status < 500) {
          this.store.setFailedImage(key);
          throw new ImageFetchError(res.status, `Image fetch failed: HTTP ${res.status}`);
        }
        if (!res.ok) throw new Error(`Image fetch failed: HTTP ${res.status}`);
        const type = detectImageType(res.buffer);
        // Не картинка (HTML от Cloudflare/логина, SVG и т.п.) — не кешируем и не
        // раздаём с origin приложения; помечаем битой (браузер догрузит напрямую).
        if (!type) {
          this.store.setFailedImage(key);
          throw new ImageFetchError(415, 'not an image');
        }
        this.store.writeImage(key, res.buffer);
        return { data: res.buffer, contentType: type };
      } catch (e) {
        lastErr = e;
        if (e instanceof ImageFetchError || e instanceof UnsafeUrlError) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
