// Порт логики clash-to-v2rayn-sub-converter (SubscriptionParser.cs):
// получение vless-конфигов из ссылки-подписки Happ/Clash-клиентов.
// Извлечение работает по цепочке: прямые ссылки -> base64 -> Xray-JSON -> Clash-YAML.

import { fetch as ufetch } from 'undici';
import { buildVlessUri } from './vless.js';
import { assertSafeHttpUrl } from '../url-safe.js';

export interface Strategy {
  name: string;
  userAgent: string;
  headers?: Record<string, string>;
}

// Hwid-заголовки имитируют Happ/Clash-клиенты, которые провайдер ожидает увидеть.
export function buildStrategies(hwid: string): Strategy[] {
  const hwidHeaders = {
    'x-hwid': hwid,
    'x-device-os': 'Windows',
    'x-ver-os': '10.0.22631',
    'x-device-model': 'Desktop',
  };
  return [
    { name: 'Happ+HWID', userAgent: 'Happ/1.0', headers: hwidHeaders },
    { name: 'Happ/2+HWID', userAgent: 'Happ/2.0.0', headers: hwidHeaders },
    { name: 'V2rayTun+HWID', userAgent: 'V2rayTun/1.0', headers: hwidHeaders },
    { name: 'INCY+HWID', userAgent: 'INCY/1.0', headers: hwidHeaders },
    { name: 'FlClashX+HWID', userAgent: 'FlClashX/1.0', headers: hwidHeaders },
    { name: 'KoalaClash+HWID', userAgent: 'clash-verge/v2.2.0', headers: hwidHeaders },
    { name: 'clash-meta', userAgent: 'clash-meta' },
    { name: 'clash-verge', userAgent: 'clash-verge/v2.2.0' },
    { name: 'ClashForAndroid', userAgent: 'ClashForAndroid/2.5.12' },
    { name: 'Hiddify', userAgent: 'HiddifyNext/2.5.0' },
    { name: 'FlClash', userAgent: 'FlClash/0.8.0' },
    { name: 'v2rayN', userAgent: 'v2rayN/7.0' },
    { name: 'v2rayNG', userAgent: 'v2rayNG/1.9.0' },
    { name: 'Stash', userAgent: 'Stash/2.7.0' },
    {
      name: 'Browser',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  ];
}

const LINK_RE = /(?:vless|vmess|trojan|ss|socks):\/\/\S+/gi;
const BASE64_TOKEN_RE = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g;
const PERCENT_RE = /(?:[A-Za-z0-9_.~-]|%[0-9A-Fa-f]{2}){24,}/g;
const TERMINATORS = ['\r', '\n', '"', "'", '<', '>'];

export function isPlaceholderNode(node: string): boolean {
  return (
    /@0\.0\.0\.0:/i.test(node) ||
    /App not supported/i.test(node) ||
    /@127\.0\.0\.1:1/i.test(node)
  );
}

function normalizeNode(node: string): string {
  let value = node.trim().replace(/[\r\n\t ]+$/g, '');
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep as is */
  }
  value = value.replace(/&amp;/g, '&');
  value = value.replace(/[&?](headerType|path|host)=(?=&|#|$)/g, '');
  value = value.replace(/[?&]+#/g, '#');
  value = value.replace(/[?&]+$/g, '');
  return value;
}

function collectDirectLinks(content: string): Set<string> {
  const out = new Set<string>();
  for (const m of content.matchAll(LINK_RE)) {
    const start = m.index ?? 0;
    let frag = m[0];
    const hashPos = frag.indexOf('#');
    if (hashPos >= 0) {
      const tailStart = start + hashPos;
      let tailEnd = content.length;
      for (const t of TERMINATORS) {
        const i = content.indexOf(t, tailStart);
        if (i >= 0 && i < tailEnd) tailEnd = i;
      }
      frag = content.slice(start, tailEnd);
    }
    out.add(normalizeNode(frag));
  }
  return out;
}

function tryDecodeBase64(input: string): string | null {
  let normalized = input.trim().replace(/-/g, '+').replace(/_/g, '/');
  normalized = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  try {
    const decoded = Buffer.from(normalized, 'base64').toString('utf8');
    return decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}

// Извлекает все vless://-ссылки из тела ответа (включая base64-обёртки).
export function extractVlessNodes(content: string): string[] {
  const seen = new Set<string>();
  const queue: string[] = [];
  const enqueue = (s?: string | null) => {
    if (s && !seen.has(s)) {
      seen.add(s);
      queue.push(s);
    }
  };
  enqueue(content);
  try {
    enqueue(decodeURIComponent(content));
  } catch {
    /* skip */
  }

  const all = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    for (const link of collectDirectLinks(cur)) {
      if (link.toLowerCase().startsWith('vless://')) all.add(link);
    }
    for (const m of cur.matchAll(BASE64_TOKEN_RE)) {
      const decoded = tryDecodeBase64(m[0]);
      if (decoded) {
        enqueue(decoded);
        try {
          enqueue(decodeURIComponent(decoded));
        } catch {
          /* skip */
        }
      }
    }
    for (const m of cur.matchAll(PERCENT_RE)) {
      if (m[0].includes('%')) {
        try {
          const d = decodeURIComponent(m[0]);
          if (d !== m[0]) enqueue(d);
        } catch {
          /* skip */
        }
      }
    }
  }
  return [...all];
}

const GENERIC_TAGS = new Set([
  'proxy', 'proxy-2', 'proxy-3', 'proxy-4', 'proxy-5', 'proxy-6', 'proxy-7', 'proxy-8',
  'proxy-9', 'proxy-10', 'direct', 'block', 'reject', 'dns-out',
]);

function buildXrayNodeName(remarks: string, tag: string, address: string, port: number): string {
  const isGeneric = !tag || GENERIC_TAGS.has(tag.toLowerCase());
  if (remarks && isGeneric) return `${remarks} [${address}:${port}]`;
  if (remarks) return `${remarks} [${tag}]`;
  if (!isGeneric) return tag;
  return `${address}:${port}`;
}

function parseXrayOutbound(ob: Record<string, unknown>, remarks: string): string[] {
  const results: string[] = [];
  try {
    if (ob.protocol !== 'vless') return results;
    const tag = typeof ob.tag === 'string' ? ob.tag : '';
    const settings = ob.settings as Record<string, unknown> | undefined;
    const vnext = settings?.vnext as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(vnext)) return results;

    for (const server of vnext) {
      const address = server.address as string;
      const port = Number(server.port);
      const users = server.users as Array<Record<string, unknown>> | undefined;
      if (!address || !Number.isInteger(port) || !Array.isArray(users)) continue;
      for (const user of users) {
        const uuid = user.id as string;
        if (!uuid) continue;
        const flow = typeof user.flow === 'string' ? user.flow : '';
        const encryption = typeof user.encryption === 'string' ? user.encryption : 'none';

        let network = 'tcp';
        let security = '';
        let sni = address;
        let fp = '';
        let pbk = '';
        let sid = '';
        let serviceName = '';
        let wsPath = '';

        const ss = ob.streamSettings as Record<string, unknown> | undefined;
        if (ss && typeof ss === 'object') {
          if (typeof ss.network === 'string') network = ss.network;
          if (typeof ss.security === 'string') security = ss.security;

          const rs = ss.realitySettings as Record<string, unknown> | undefined;
          if (rs && typeof rs === 'object') {
            if (typeof rs.serverName === 'string') sni = rs.serverName;
            if (typeof rs.fingerprint === 'string') fp = rs.fingerprint;
            if (typeof rs.publicKey === 'string') pbk = rs.publicKey;
            if (typeof rs.shortId === 'string') sid = rs.shortId;
          } else {
            const ts = ss.tlsSettings as Record<string, unknown> | undefined;
            if (ts && typeof ts === 'object') {
              if (typeof ts.serverName === 'string') sni = ts.serverName;
              if (typeof ts.fingerprint === 'string') fp = ts.fingerprint;
            }
          }
          const gs = ss.grpcSettings as Record<string, unknown> | undefined;
          if (gs && typeof gs === 'object' && typeof gs.serviceName === 'string') {
            serviceName = gs.serviceName;
          }
          const ws = ss.wsSettings as Record<string, unknown> | undefined;
          if (ws && typeof ws === 'object' && typeof ws.path === 'string') {
            wsPath = ws.path;
          }
        }

        const nodeName = buildXrayNodeName(remarks, tag, address, port);
        const uri = buildVlessUri({
          uuid,
          server: address,
          port,
          name: nodeName,
          tls: security === 'tls' ? 'true' : null,
          network,
          sni,
          flow,
          fp,
          pbk,
          sid,
          grpcServiceName: serviceName,
          wsPath,
          encryption: encryption !== 'none' ? encryption : null,
        });
        if (!isPlaceholderNode(uri)) results.push(uri);
      }
    }
  } catch {
    /* skip outbound */
  }
  return results;
}

// Распознаёт Xray-JSON конфиг (объект или массив) и собирает vless://-ссылки.
export function extractVlessFromXrayJson(body: string): string[] {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return [];
  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const results: string[] = [];
  const collect = (item: unknown) => {
    if (!item || typeof item !== 'object') return;
    const o = item as Record<string, unknown>;
    if (Array.isArray(o.outbounds)) {
      const remarks = typeof o.remarks === 'string' ? o.remarks : '';
      for (const ob of o.outbounds) {
        results.push(...parseXrayOutbound(ob as Record<string, unknown>, remarks));
      }
    }
  };
  if (Array.isArray(root)) {
    for (const it of root) collect(it);
  } else {
    collect(root);
  }
  return [...new Set(results)];
}

function extractYamlField(inlineBlock: string, key: string): string | null {
  const re = new RegExp(`(?:^|[\\s,{])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^,}]+)`, 'i');
  const m = re.exec(inlineBlock);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function extractYamlFieldMultiline(block: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.+)$`, 'im');
  const m = re.exec(block);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function parseInlineClashProxy(text: string): string | null {
  const server = extractYamlField(text, 'server');
  const port = extractYamlField(text, 'port');
  const uuid = extractYamlField(text, 'uuid');
  const name = extractYamlField(text, 'name') ?? 'node';
  if (!server || !port || !uuid || !Number.isInteger(Number(port))) return null;
  return buildVlessUri({
    uuid,
    server,
    port: Number(port),
    name,
    tls: extractYamlField(text, 'tls'),
    network: extractYamlField(text, 'network'),
    sni: extractYamlField(text, 'servername') ?? extractYamlField(text, 'sni'),
    flow: extractYamlField(text, 'flow'),
    fp: extractYamlField(text, 'client-fingerprint') ?? extractYamlField(text, 'fingerprint'),
    pbk: extractYamlField(text, 'public-key'),
    sid: extractYamlField(text, 'short-id'),
    grpcServiceName: extractYamlField(text, 'grpc-service-name'),
    wsPath: extractYamlField(text, 'ws-path') ?? extractYamlField(text, 'path'),
  });
}

function parseMultilineClashProxy(text: string): string | null {
  const server = extractYamlFieldMultiline(text, 'server');
  const port = extractYamlFieldMultiline(text, 'port');
  const uuid = extractYamlFieldMultiline(text, 'uuid');
  const name = extractYamlFieldMultiline(text, 'name') ?? 'node';
  if (!server || !port || !uuid || !Number.isInteger(Number(port))) return null;
  return buildVlessUri({
    uuid,
    server,
    port: Number(port),
    name,
    tls: extractYamlFieldMultiline(text, 'tls'),
    network: extractYamlFieldMultiline(text, 'network'),
    sni: extractYamlFieldMultiline(text, 'servername') ?? extractYamlFieldMultiline(text, 'sni'),
    flow: extractYamlFieldMultiline(text, 'flow'),
    fp: extractYamlFieldMultiline(text, 'client-fingerprint'),
    pbk: extractYamlFieldMultiline(text, 'public-key'),
    sid: extractYamlFieldMultiline(text, 'short-id'),
    grpcServiceName: extractYamlFieldMultiline(text, 'grpc-service-name'),
    wsPath: extractYamlFieldMultiline(text, 'ws-path') ?? extractYamlFieldMultiline(text, 'path'),
  });
}

function parseLooseClashFields(yaml: string): string | null {
  const server = extractYamlFieldMultiline(yaml, 'server');
  const port = extractYamlFieldMultiline(yaml, 'port');
  const uuid = extractYamlFieldMultiline(yaml, 'uuid');
  if (!server || !port || !uuid || !Number.isInteger(Number(port))) return null;
  return buildVlessUri({
    uuid,
    server,
    port: Number(port),
    name: 'node',
    tls: extractYamlFieldMultiline(yaml, 'tls'),
    network: extractYamlFieldMultiline(yaml, 'network'),
    sni: extractYamlFieldMultiline(yaml, 'servername'),
    flow: extractYamlFieldMultiline(yaml, 'flow'),
    fp: extractYamlFieldMultiline(yaml, 'client-fingerprint'),
    pbk: extractYamlFieldMultiline(yaml, 'public-key'),
    sid: extractYamlFieldMultiline(yaml, 'short-id'),
    grpcServiceName: extractYamlFieldMultiline(yaml, 'grpc-service-name'),
    wsPath: extractYamlFieldMultiline(yaml, 'ws-path') ?? extractYamlFieldMultiline(yaml, 'path'),
  });
}

export function extractVlessFromClashYaml(yaml: string): string[] {
  const results: string[] = [];

  const inlineRe = /-\s*\{[^}]*?type\s*:\s*vless[^}]*\}/gi;
  for (const m of yaml.matchAll(inlineRe)) {
    const node = parseInlineClashProxy(m[0]);
    if (node) results.push(node);
  }
  if (results.length) return results;

  const multilineRe = /-\s+name\s*:.*?(?=\n\s*-\s+name|\n\s*proxy-groups|\nrules:|\z)/gis;
  for (const m of yaml.matchAll(multilineRe)) {
    const text = m[0];
    if (!/type\s*:\s*vless/i.test(text)) continue;
    const node = parseMultilineClashProxy(text);
    if (node) results.push(node);
  }
  if (results.length) return results;

  if (/type\s*:\s*vless/i.test(yaml)) {
    const node = parseLooseClashFields(yaml);
    if (node) results.push(node);
  }
  return results;
}

function endpointOf(uri: string): string | null {
  const m = /^vless:\/\/[^@]+@([^?#]+)/i.exec(uri);
  return m ? m[1].toLowerCase() : null;
}

function mergeNodes(primary: string[], extra: string[]): string[] {
  if (extra.length === 0) return primary;
  const seen = new Set<string>();
  for (const n of primary) {
    const ep = endpointOf(n);
    if (ep) seen.add(ep);
  }
  const out = [...primary];
  for (const n of extra) {
    const ep = endpointOf(n);
    if (ep && !seen.has(ep)) {
      seen.add(ep);
      out.push(n);
    }
  }
  return out;
}

export interface FetchVlessOptions {
  timeoutMs?: number;
}

// Безопасный GET подписки: каждая точка (включая редиректы) обязана быть публичным
// http(s) адресом — иначе сервер можно заставить читать внутренние ресурсы (SSRF).
async function safeFetchSubscription(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  let current = url;
  for (let i = 0; i < 8; i++) {
    const safe = await assertSafeHttpUrl(current);
    current = safe.toString();
    const res = await ufetch(current, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const status = res.status;
    const location = res.headers.get('location');
    if (
      (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) &&
      location
    ) {
      current = new URL(location, current).toString();
      continue;
    }
    const buf = await res.arrayBuffer();
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
  throw new Error('Слишком много редиректов в подписке');
}

// Качает подписку (стратегии с Hwid-заголовками), возвращает реальные vless-ссылки.
export async function fetchVlessNodes(
  subscriptionUrl: string,
  hwid: string,
  opts: FetchVlessOptions = {},
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const strategies = buildStrategies(hwid);

  const attempts = await Promise.all(
    strategies.map(async (s): Promise<{ nodes: string[]; body: string }> => {
      try {
        const body = await safeFetchSubscription(
          subscriptionUrl,
          {
            'User-Agent': s.userAgent,
            Accept: '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            ...(s.headers ?? {}),
          },
          timeoutMs,
        );
        if (!body) return { nodes: [], body };
        const direct = extractVlessNodes(body).filter((n) => !isPlaceholderNode(n));
        const xray = extractVlessFromXrayJson(body).filter((n) => !isPlaceholderNode(n));
        const merged = mergeNodes(direct, xray);
        return { nodes: merged, body };
      } catch {
        return { nodes: [], body: '' };
      }
    }),
  );

  for (const a of attempts) {
    if (a.nodes.length) return [...new Set(a.nodes)];
  }

  const unique = [...new Set(attempts.map((a) => a.body).filter((b) => b.length > 200))];
  for (const body of unique) {
    const xray = extractVlessFromXrayJson(body).filter((n) => !isPlaceholderNode(n));
    if (xray.length) return [...new Set(xray)];
  }
  for (const body of unique) {
    const yaml = extractVlessFromClashYaml(body).filter((n) => !isPlaceholderNode(n));
    if (yaml.length) return [...new Set(yaml)];
  }

  const allBodies = attempts.map((a) => a.body).join('\n');
  if (/App not supported/i.test(allBodies) || allBodies.includes('0.0.0.0')) {
    throw new Error('Провайдер блокирует внешние клиенты (возвращает «App not supported»).');
  }
  throw new Error('Не удалось получить vless-конфиги из подписки.');
}
