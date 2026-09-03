import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStrategies,
  extractVlessFromClashYaml,
  extractVlessFromXrayJson,
  extractVlessNodes,
  isPlaceholderNode,
} from '../src/vpn/subscription.js';

test('buildStrategies: first six carry hwid headers', () => {
  const strategies = buildStrategies('hwid-1234');
  assert.ok(strategies.length >= 15);
  for (const s of strategies.slice(0, 6)) {
    assert.equal(s.headers!['x-hwid'], 'hwid-1234');
    assert.equal(s.headers!['x-device-os'], 'Windows');
  }
  assert.equal(strategies[6].headers, undefined);
});

test('extractVlessNodes: base64-encoded payload', () => {
  const nodes = [
    'vless://1111-1111@1.1.1.1:443?security=tls&type=ws#Node1',
    'vless://2222-2222@2.2.2.2:80#Node2',
  ].join('\n');
  const body = Buffer.from(nodes).toString('base64');
  const out = extractVlessNodes(body);
  assert.equal(out.length, 2);
  assert.ok(out.some((u) => u.includes('@1.1.1.1:443')));
  assert.ok(out.some((u) => u.includes('@2.2.2.2:80')));
});

test('extractVlessNodes: direct links survive', () => {
  const body = 'prefix vless://a@1.1.1.1:443?type=tcp#A suffix';
  const out = extractVlessNodes(body);
  assert.equal(out.length, 1);
  assert.ok(out[0].startsWith('vless://a@1.1.1.1:443?'));
});

test('normalizeNode: decodes &amp; and strips empty params', () => {
  const body = 'vless://u@h:443?a=1&amp;b=2&headerType=&path=#Name';
  const out = extractVlessNodes(body);
  assert.equal(out.length, 1);
  assert.ok(!out[0].includes('&amp;'));
  assert.ok(out[0].includes('a=1'));
});

test('isPlaceholderNode: rejects fakes', () => {
  assert.equal(isPlaceholderNode('vless://x@0.0.0.0:123#fake'), true);
  assert.equal(isPlaceholderNode('vless://x@127.0.0.1:1#fake'), true);
  assert.equal(isPlaceholderNode('App not supported vless://x@h:1'), true);
  assert.equal(isPlaceholderNode('vless://u@1.2.3.4:443?type=tcp#Real'), false);
});

test('extractVlessFromXrayJson: reality outbound', () => {
  const json = JSON.stringify({
    remarks: 'Provider',
    outbounds: [
      {
        protocol: 'vless',
        tag: 'proxy',
        settings: {
          vnext: [
            {
              address: '5.6.7.8',
              port: 443,
              users: [{ id: 'uuid-1', encryption: 'none', flow: 'xtls-rprx-vision' }],
            },
          ],
        },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          realitySettings: {
            serverName: 'www.microsoft.com',
            fingerprint: 'chrome',
            publicKey: 'PBKKEY',
            shortId: 'SID',
          },
        },
      },
    ],
  });
  const out = extractVlessFromXrayJson(json);
  assert.equal(out.length, 1);
  assert.ok(out[0].startsWith('vless://uuid-1@5.6.7.8:443?'));
  assert.ok(out[0].includes('security=reality'));
  assert.ok(out[0].includes('pbk=PBKKEY'));
  assert.ok(out[0].includes('flow=xtls-rprx-vision'));
  assert.ok(out[0].includes('sni=www.microsoft.com'));
});

test('extractVlessFromXrayJson: ignores non-vless protocols', () => {
  const json = JSON.stringify({
    outbounds: [
      { protocol: 'vmess', settings: { vnext: [{ address: 'x', port: 1, users: [{ id: 'u' }] }] } },
    ],
  });
  assert.deepEqual(extractVlessFromXrayJson(json), []);
});

test('extractVlessFromClashYaml: inline block', () => {
  const yaml = [
    'proxies:',
    '  - {name: "JP", type: vless, server: 9.9.9.9, port: 443, uuid: uuid-1, network: ws, tls: true, servername: jp.example.com, ws-path: /ws, udp: true}',
  ].join('\n');
  const out = extractVlessFromClashYaml(yaml);
  assert.equal(out.length, 1);
  assert.ok(out[0].startsWith('vless://uuid-1@9.9.9.9:443?'));
  assert.ok(out[0].includes('security=tls'));
  assert.ok(out[0].includes('type=ws'));
  assert.ok(out[0].includes('sni=jp.example.com'));
});
