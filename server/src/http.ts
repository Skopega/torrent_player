import iconv from 'iconv-lite';
import { fetch as ufetch } from 'undici';
import type { Dispatcher } from 'undici';
import { log } from './logger.js';
import { resolveUserAgent } from './ua.js';
import type { VpnProxy } from './vpn/types.js';

export const BASE_URL = 'https://rutracker.org/forum/';

export const USER_AGENT = resolveUserAgent();

export interface HttpResponse {
  status: number;
  text: string;
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

  async request(url: string, init?: RequestInit, opts?: { direct?: boolean }): Promise<HttpResponse> {
    let method = (init?.method ?? 'GET').toUpperCase();
    let body = init?.body as import('undici').BodyInit | undefined;
    let contentType = (init?.headers as Record<string, string> | undefined)?.['content-type'];

    const started = Date.now();
    let current = url;
    for (let i = 0; i < 8; i++) {
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      };
      const cookie = this.cookieHeader();
      if (cookie) headers['Cookie'] = cookie;
      if (contentType) headers['Content-Type'] = contentType;

      // Весь трафик к сайтам идёт через активную vless-прокси (если включена);
      // direct=true — для загрузки подписки и health-проверок самой прокси.
      let dispatcher: Dispatcher | undefined;
      if (!opts?.direct && this.vpn?.isEnabled()) {
        const ok = await this.vpn.ensureReady();
        if (!ok) {
          throw new Error('Прокси включён, но не поднят. Проверьте статус VPN в шапке.');
        }
        dispatcher = this.vpn.getDispatcher() as Dispatcher | undefined;
      }

      const res = await ufetch(current, {
        method,
        body,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        ...(dispatcher ? { dispatcher } : {}),
      });
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      this.mergeSetCookie(setCookies);

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
          contentType = undefined;
        }
        continue;
      }

      const raw = Buffer.from(await res.arrayBuffer());
      const text = this.decode(raw, res.headers.get('content-encoding'));
      log.info(`http ${method} ${current} -> ${status} (${Date.now() - started}ms)`);
      return { status, text, finalUrl: current };
    }
    throw new Error('Too many redirects');
  }

  private decode(buf: Buffer, _encoding: string | null): string {
    // Node's undici fetch transparently decompresses gzip/br/deflate while keeping
    // the Content-Encoding header, so the body is already plain bytes here.
    return iconv.decode(buf, 'windows-1251');
  }
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
