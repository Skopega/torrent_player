import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVlessUri, parseNode, toXrayOutbound } from '../src/vpn/vless.js';

test('parseNode: reality tcp node', () => {
  const uri =
    'vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?security=reality&type=tcp&sni=example.com&flow=xtls-rprx-vision&fp=chrome&pbk=AAAA&sid=BBBB#US-Reality';
  const n = parseNode(uri);
  assert.ok(n);
  assert.equal(n!.name, 'US-Reality');
  assert.equal(n!.uuid, '11111111-2222-3333-4444-555555555555');
  assert.equal(n!.address, '1.2.3.4');
  assert.equal(n!.port, 443);
  assert.equal(n!.security, 'reality');
  assert.equal(n!.network, 'tcp');
  assert.equal(n!.sni, 'example.com');
  assert.equal(n!.flow, 'xtls-rprx-vision');
  assert.equal(n!.fingerprint, 'chrome');
  assert.equal(n!.publicKey, 'AAAA');
  assert.equal(n!.shortId, 'BBBB');
});

test('parseNode: ws + tls node with encoded name/path', () => {
  const uri =
    'vless://uuid-1@host.example:8443?security=tls&type=ws&path=%2Fws&host=cdn.example.com#WS%20Node';
  const n = parseNode(uri);
  assert.ok(n);
  assert.equal(n!.name, 'WS Node');
  assert.equal(n!.security, 'tls');
  assert.equal(n!.network, 'ws');
  assert.equal(n!.path, '/ws');
  assert.equal(n!.host, 'cdn.example.com');
});

test('parseNode: grpc node', () => {
  const uri = 'vless://uuid-2@h.example:443?security=tls&type=grpc&serviceName=svc&sni=h.example#GRPC';
  const n = parseNode(uri);
  assert.ok(n);
  assert.equal(n!.network, 'grpc');
  assert.equal(n!.serviceName, 'svc');
  assert.equal(n!.sni, 'h.example');
});

test('parseNode: plain tcp node without query', () => {
  const uri = 'vless://uuid-3@8.8.8.8:80#Plain';
  const n = parseNode(uri);
  assert.ok(n);
  assert.equal(n!.security, 'none');
  assert.equal(n!.network, 'tcp');
  assert.equal(n!.sni, '8.8.8.8');
  assert.equal(n!.name, 'Plain');
});

test('parseNode: pbk implies reality even without security param', () => {
  const uri = 'vless://uuid@x.example:443?pbk=KEY&sid=S#R';
  const n = parseNode(uri);
  assert.ok(n);
  assert.equal(n!.security, 'reality');
});

test('parseNode: rejects non-vless and malformed', () => {
  assert.equal(parseNode('vmess://x@h:1'), null);
  assert.equal(parseNode('vless://nouser'), null);
  assert.equal(parseNode('vless://u@h:99999'), null);
  assert.equal(parseNode(''), null);
});

test('toXrayOutbound: reality mapping', () => {
  const n = parseNode(
    'vless://u@1.2.3.4:443?security=reality&type=tcp&sni=ex.com&flow=xtls-rprx-vision&fp=chrome&pbk=P&sid=S#N',
  )!;
  const ob = toXrayOutbound(n, 'node1');
  assert.equal(ob.protocol, 'vless');
  assert.equal(ob.tag, 'node1');
  assert.equal(ob.settings.vnext[0].address, '1.2.3.4');
  assert.equal(ob.settings.vnext[0].port, 443);
  assert.equal(ob.settings.vnext[0].users[0].id, 'u');
  assert.equal(ob.settings.vnext[0].users[0].flow, 'xtls-rprx-vision');
  const rs = ob.streamSettings.realitySettings as Record<string, unknown>;
  assert.equal(ob.streamSettings.security, 'reality');
  assert.equal(rs.serverName, 'ex.com');
  assert.equal(rs.publicKey, 'P');
  assert.equal(rs.shortId, 'S');
});

test('toXrayOutbound: ws + tls mapping', () => {
  const n = parseNode('vless://u@h:8443?security=tls&type=ws&path=%2Fws&host=cdn.example.com#N')!;
  const ob = toXrayOutbound(n, 'n');
  const ws = ob.streamSettings.wsSettings as { path: string; headers: { Host: string } };
  assert.equal(ob.streamSettings.security, 'tls');
  assert.equal(ws.path, '/ws');
  assert.equal(ws.headers.Host, 'cdn.example.com');
  const ts = ob.streamSettings.tlsSettings as Record<string, unknown>;
  assert.equal(ts.serverName, 'h');
});

test('buildVlessUri: reality round-trip', () => {
  const uri = buildVlessUri({
    uuid: 'u',
    server: '5.6.7.8',
    port: 443,
    name: 'N [5.6.7.8:443]',
    tls: null,
    network: 'tcp',
    sni: 's.example',
    flow: 'xtls-rprx-vision',
    fp: 'chrome',
    pbk: 'KEY',
    sid: 'S',
  });
  assert.ok(uri.startsWith('vless://u@5.6.7.8:443?'));
  assert.ok(uri.includes('security=reality'));
  assert.ok(uri.includes('pbk=KEY'));
  assert.ok(uri.includes('flow=xtls-rprx-vision'));
  const n = parseNode(uri);
  assert.ok(n);
  assert.equal(n!.security, 'reality');
});
