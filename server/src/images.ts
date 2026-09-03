import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpClient, BASE_URL, resolveUrl } from './http.js';
import { Store } from './store.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

function guessMime(url: string, header: string | null): string {
  if (header && header.includes('image/')) return header.split(';')[0].trim();
  const ext = path.extname(new URL(url, BASE_URL).pathname).toLowerCase();
  return EXT_MIME[ext] ?? 'image/jpeg';
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
      return { data, contentType: guessMime(resolved, null) };
    }

    // Битая картинка уже известна — не долбим источник на каждый перезапрос.
    if (this.store.hasFailedImage(key)) {
      throw new ImageFetchError(404, 'cached image failure');
    }

    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      // fastpic.org различает ответы по Sec-Fetch-* (см. заголовок Vary):
      // без них запрос выглядит как API/бот и периодически отдаётся 404.
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
    };
    // Куки rutracker нужны только для вложенных картинок (rutracker.org);
    // внешние хостинги (fastpic и т.п.) в них не нуждаются.
    const host = new URL(resolved).hostname;
    if (/rutracker\.(org|cc)$/i.test(host)) {
      const cookie = this.http.cookieHeader();
      if (cookie) headers['Cookie'] = cookie;
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(resolved, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        });
        // Определённый отказ источника (4xx) — картинка битая/удалена. Не
        // повторяем (долго и бессмысленно), запоминаем и отдаём 404.
        if (res.status >= 400 && res.status < 500) {
          this.store.setFailedImage(key);
          throw new ImageFetchError(res.status, `Image fetch failed: HTTP ${res.status}`);
        }
        if (!res.ok) throw new Error(`Image fetch failed: HTTP ${res.status}`);
        const data = Buffer.from(await res.arrayBuffer());
        const contentType = guessMime(resolved, res.headers.get('content-type'));
        this.store.writeImage(key, data);
        return { data, contentType };
      } catch (e) {
        lastErr = e;
        if (e instanceof ImageFetchError) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
