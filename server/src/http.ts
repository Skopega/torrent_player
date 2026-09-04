import iconv from 'iconv-lite';
import { fetch as ufetch } from 'undici';
import type { Dispatcher } from 'undici';
import { Readable } from 'node:stream';
import { log } from './logger.js';
import { resolveUserAgent } from './ua.js';
import { assertSafeHttpUrl } from './url-safe.js';
import type { VpnProxy } from './vpn/types.js';

export const BASE_URL = 'https://rutracker.org/forum/';

export const USER_AGENT = resolveUserAgent();

export interface HttpResponse {
  status: number;
  text: string;
  finalUrl: string;
}

export interface HttpRawResponse {
  status: number;
  ok: boolean;
  buffer: Buffer;
  contentType: string | null;
  finalUrl: string;
}

export class HttpClient {
  private cookies: string[] = [];

  constructor(private vpn: VpnProxy | null = null) {}

  setCookies(cookies: string[]) {
    this.cookies = cookies.filter((c) => c && c.includes('='));
  }

  getCookies(): string[] {
    return [...this.cookies];
  }

  cookieHeader(): string {
    return this.cookies.join('; ');
  }

  private mergeSetCookie(setCookies: string[]) {
    for (const sc of setCookies) {
      const first = sc.split(';')[0] ?? '';
      const idx = first.indexOf('=');
      if (idx < 0) continue;
      const name = first.slice(0, idx).trim();
      let value = first.slice(idx + 1).trim();
      const existing = this.cookies.findIndex((c) => c.startsWith(name + '='));
      if (value === 'deleted' || value === '') {
        if (existing >= 0) this.cookies.splice(existing, 1);
        continue;
      }
      const kv = `${name}=${value}`;
      if (existing >= 0) this.cookies[existing] = kv;
      else this.cookies.push(kv);
    }
  }

  private async dispatcherFor(direct: boolean | undefined): Promise<Dispatcher | undefined> {
    // Весь трафик к сайтам идёт через активную vless-прокси (если включена);
    // direct=true — для загрузки подписки и health-проверок самой прокси.
    if (!direct && this.vpn?.isEnabled()) {
      const ok = await this.vpn.ensureReady();
      if (!ok) {
        throw new Error('Прокси включён, но не поднят. Проверьте статус VPN в шапке.');
      }
      return this.vpn.getDispatcher() as Dispatcher | undefined;
    }
    return undefined;
  }

  async request(url: string, init?: RequestInit, opts?: { direct?: boolean }): Promise<HttpResponse> {
    const raw = await this.rawRequest(url, init, { ...opts, timeoutMs: 5000, cookies: true });
    return { status: raw.status, text: this.decode(raw.buffer), finalUrl: raw.finalUrl };
  }

  // Бинарный GET с проверкой безопасности каждого хопа (SSRF-защита) и лимитом тела.
  // Куки НЕ подставляются автоматически (кроме opts.cookies) — caller решает, куда их слать.
  async rawRequest(
    url: string,
    init?: RequestInit,
    opts?: {
      direct?: boolean;
      timeoutMs?: number;
      maxBytes?: number;
      cookies?: boolean;
    },
  ): Promise<HttpRawResponse> {
    let method = (init?.method ?? 'GET').toUpperCase();
    let body = init?.body as import('undici').BodyInit | undefined;
    const callerHeaders = (init?.headers ?? {}) as Record<string, string>;
    const timeoutMs = opts?.timeoutMs ?? 10000;
    const maxBytes = opts?.maxBytes ?? 64 * 1024 * 1024;
    const withCookies = opts?.cookies ?? false;

    const started = Date.now();
    let current = url;
    for (let i = 0; i < 8; i++) {
      // Каждый хоп (включая редиректы) обязан быть публичным http(s) адресом.
      const safe = await assertSafeHttpUrl(current);
      current = safe.toString();

      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        ...callerHeaders,
      };
      if (withCookies) {
        const cookie = this.cookieHeader();
        if (cookie) headers['Cookie'] = cookie;
      }

      const dispatcher = await this.dispatcherFor(opts?.direct);

      const res = await ufetch(current, {
        method,
        body,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        ...(dispatcher ? { dispatcher } : {}),
      });

      const status = res.status;
      const location = res.headers.get('location');

      if (
        (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) &&
        location
      ) {
        current = new URL(location, current).toString();
        if (status === 303 || (status === 302 && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }

      const contentType = res.headers.get('content-type');
      const buffer = await readBodyLimited(res, maxBytes);
      log.info(`http ${method} ${current} -> ${status} (${Date.now() - started}ms)`);
      return { status, ok: status >= 200 && status < 300, buffer, contentType, finalUrl: current };
    }
    throw new Error('Too many redirects');
  }

  private decode(buf: Buffer): string {
    // Node's undici fetch transparently decompresses gzip/br/deflate while keeping
    // the Content-Encoding header, so the body is already plain bytes here.
    return iconv.decode(buf, 'windows-1251');
  }
}

// Читает тело ответа с лимитом байт (защита от OOM при SSRF/неожиданно большом теле).
async function readBodyLimited(res: import('undici').Response, maxBytes: number): Promise<Buffer> {
  const len = res.headers.get('content-length');
  if (len !== null) {
    const n = Number(len);
    if (Number.isFinite(n) && n > maxBytes) throw new Error('Response body too large');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (!res.body) return Buffer.alloc(0);
  for await (const chunk of Readable.fromWeb(res.body as never)) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('Response body too large');
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function formUrlEncode(fields: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`${encodeCp1251(k)}=${encodeCp1251(v)}`);
  }
  return parts.join('&');
}

export function encodeCp1251(s: string): string {
  const buf = iconv.encode(s, 'win1251');
  let out = '';
  for (const b of buf) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c)) out += c;
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function resolveUrl(src: string, base: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('//')) return 'https:' + src;
  return new URL(src, base).toString();
}
