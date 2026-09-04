import dns from 'node:dns/promises';
import net from 'node:net';

// Ограничение исходящих URL до публичных http(s) адресов: запрещает серверу ходить
// в локальные/внутренние сети (SSRF-защита для image-proxy и редиректов). Разрешён
// любой публичный хост — постеры живут на разных CDN, allowlist доменов не подходит.

const VERDICT_TTL_MS = 30_000;
const verdictCache = new Map<string, { ok: boolean; at: number }>();

export class UnsafeUrlError extends Error {
  constructor(public readonly reason: string) {
    super(`unsafe url: ${reason}`);
    this.name = 'UnsafeUrlError';
  }
}

function classifyIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this" network / unspecified
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local (metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast и reserved
  return false;
}

function classifyIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped: ::ffff:192.168.0.1
    return classifyIpv4(lower.slice(7));
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // link-local
  }
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return classifyIpv4(ip);
  if (v === 6) return classifyIpv6(ip);
  return true; // непонятный формат — считаем небезопасным
}

export { isPrivateAddress };

async function resolveHostPrivate(hostname: string): Promise<boolean> {
  const key = hostname.toLowerCase();
  const hit = verdictCache.get(key);
  if (hit && Date.now() - hit.at < VERDICT_TTL_MS) return hit.ok;
  let blocked = false;
  try {
    const res = await dns.lookup(key, { all: true, verbatim: true });
    blocked = res.some((a) => isPrivateAddress(a.address));
  } catch {
    // Не резолвится сейчас — запрещаем (проверка повторится при следующем запросе).
    blocked = true;
  }
  verdictCache.set(key, { ok: blocked, at: Date.now() });
  return blocked;
}

// Проверяет URL: схема http/https + хост не приватный. Возвращает URL (без hash).
export async function assertSafeHttpUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError('bad url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UnsafeUrlError('protocol');
  }
  const host = u.hostname;
  if (!host) throw new UnsafeUrlError('no host');
  const literalVersion = net.isIP(host);
  let blocked: boolean;
  if (literalVersion !== 0) {
    blocked = isPrivateAddress(host);
  } else {
    blocked = await resolveHostPrivate(host);
  }
  if (blocked) throw new UnsafeUrlError(`non-public host: ${host}`);
  u.hash = '';
  return u;
}

export function clearUrlVerdictCache(): void {
  verdictCache.clear();
}
