// Парсер vless://-ссылок и конвертация в outbound-конфиг xray-core.

export type VlessSecurity = 'none' | 'tls' | 'reality';

export interface VlessNode {
  name: string;
  uri: string;
  uuid: string;
  address: string;
  port: number;
  security: VlessSecurity;
  network: string;
  sni: string | null;
  flow: string | null;
  fingerprint: string | null;
  publicKey: string | null;
  shortId: string | null;
  serviceName: string | null;
  path: string | null;
  host: string | null;
  allowInsecure: boolean;
}

// Разбивает `host:port?query#name`; host может быть [ipv6]:port.
function splitHostPort(tail: string): { host: string; port: number; query: string; name: string } | null {
  let i = tail.search(/[?#]/);
  if (i < 0) i = tail.length;
  const hostPort = tail.slice(0, i);
  const after = tail.slice(i);
  const qm = after.indexOf('?');
  const hash = after.indexOf('#');
  let query = '';
  let name = '';
  if (qm >= 0) {
    query = after.slice(qm + 1, hash >= 0 ? hash : undefined);
  }
  if (hash >= 0) name = after.slice(hash + 1);

  let host: string;
  let portStr: string;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close < 0) return null;
    host = hostPort.slice(1, close);
    portStr = hostPort.slice(close + 1).replace(/^:/, '');
  } else {
    const lastColon = hostPort.lastIndexOf(':');
    if (lastColon < 0) return null;
    host = hostPort.slice(0, lastColon);
    portStr = hostPort.slice(lastColon + 1);
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, query, name };
}

export function parseNode(uri: string): VlessNode | null {
  const s = uri.trim();
  if (!s.toLowerCase().startsWith('vless://')) return null;
  const rest = s.slice('vless://'.length);
  const at = rest.indexOf('@');
  if (at < 0) return null;
  const uuidRaw = rest.slice(0, at);
  const tail = rest.slice(at + 1);
  const parts = splitHostPort(tail);
  if (!parts) return null;
  const uuid = decodeURIComponent(uuidRaw);

  const params = new URLSearchParams(parts.query);
  const securityParam = params.get('security') ?? '';
  const publicKey = params.get('pbk') || null;
  const security: VlessSecurity =
    securityParam === 'reality' || (securityParam !== 'tls' && publicKey)
      ? 'reality'
      : securityParam === 'tls'
        ? 'tls'
        : 'none';
  const allowInsecure =
    params.get('allowInsecure') === '1' || params.get('allowInsecure') === 'true';

  return {
    name: parts.name ? decodeURIComponent(parts.name) : `${parts.host}:${parts.port}`,
    uri: s,
    uuid,
    address: parts.host,
    port: parts.port,
    security,
    network: (params.get('type') || 'tcp').toLowerCase(),
    sni: params.get('sni') || params.get('servername') || parts.host,
    flow: params.get('flow') || null,
    fingerprint: params.get('fp') || null,
    publicKey,
    shortId: params.get('sid') || null,
    serviceName: params.get('serviceName') || null,
    path: params.get('path') || null,
    host: params.get('host') || null,
    allowInsecure,
  };
}

export interface XrayOutbound {
  tag: string;
  protocol: string;
  settings: {
    vnext: Array<{
      address: string;
      port: number;
      users: Array<{ id: string; encryption: string; flow: string }>;
    }>;
  };
  streamSettings: Record<string, unknown>;
}

export function toXrayOutbound(node: VlessNode, tag: string): XrayOutbound {
  const streamSettings: Record<string, unknown> = {
    network: node.network || 'tcp',
    security: node.security,
  };
  if (node.security === 'tls') {
    const tlsSettings: Record<string, unknown> = {
      serverName: node.sni ?? node.address,
      allowInsecure: node.allowInsecure,
    };
    if (node.fingerprint) tlsSettings.fingerprint = node.fingerprint;
    streamSettings.tlsSettings = tlsSettings;
  } else if (node.security === 'reality') {
    streamSettings.realitySettings = {
      serverName: node.sni ?? node.address,
      fingerprint: node.fingerprint || 'chrome',
      publicKey: node.publicKey ?? '',
      shortId: node.shortId ?? '',
    };
  }
  if (node.network === 'ws') {
    const ws: Record<string, unknown> = { path: node.path ?? '/' };
    if (node.host) ws.headers = { Host: node.host };
    streamSettings.wsSettings = ws;
  } else if (node.network === 'grpc') {
    streamSettings.grpcSettings = { serviceName: node.serviceName ?? '' };
  } else if (node.network === 'http' || node.network === 'h2') {
    streamSettings.httpSettings = {
      host: node.host ?? node.sni ?? '',
      path: node.path ?? '',
    };
  } else if (node.network === 'kcp') {
    streamSettings.mKcpSettings = {};
  } else if (node.network === 'quic') {
    streamSettings.quicSettings = {};
  }
  return {
    tag,
    protocol: 'vless',
    settings: {
      vnext: [
        {
          address: node.address,
          port: node.port,
          users: [{ id: node.uuid, encryption: 'none', flow: node.flow ?? '' }],
        },
      ],
    },
    streamSettings,
  };
}

export interface VlessUriParts {
  uuid: string;
  server: string;
  port: number;
  name: string;
  tls?: string | null;
  network?: string | null;
  sni?: string | null;
  flow?: string | null;
  fp?: string | null;
  pbk?: string | null;
  sid?: string | null;
  spx?: string | null;
  grpcServiceName?: string | null;
  wsPath?: string | null;
  encryption?: string | null;
}

// Сборка vless://-ссылки (порт логики из clash-to-v2rayn-sub-converter).
export function buildVlessUri(p: VlessUriParts): string {
  const network = p.network || 'tcp';
  const sni = p.sni || p.server;
  const hasPbk = Boolean(p.pbk);
  const security = hasPbk ? 'reality' : p.tls === 'true' ? 'tls' : '';
  const params: string[] = [`security=${security}`, `type=${network}`, `sni=${sni}`];
  if (p.flow) params.push(`flow=${p.flow}`);
  if (p.fp) params.push(`fp=${p.fp}`);
  if (hasPbk) params.push(`pbk=${p.pbk}`);
  if (p.sid) params.push(`sid=${p.sid}`);
  if (p.encryption) params.push(`encryption=${encodeURIComponent(p.encryption)}`);
  if (network === 'grpc' && p.grpcServiceName) params.push(`serviceName=${p.grpcServiceName}`);
  if (network === 'ws' && p.wsPath) params.push(`path=${encodeURIComponent(p.wsPath)}`);
  return `vless://${p.uuid}@${p.server}:${p.port}?${params.join('&')}#${encodeURIComponent(p.name)}`;
}
