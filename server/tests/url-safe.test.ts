import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeHttpUrl, isPrivateAddress } from '../src/url-safe.js';

test('isPrivateAddress: blocks RFC1918/loopback/link-local', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '0.0.0.0']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test('isPrivateAddress: allows public v4', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.158.134.3', '208.80.152.2']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('isPrivateAddress: handles v6 (loopback, ULA, link-local, multicast)', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:192.168.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('assertSafeHttpUrl: rejects non-http schemes', async () => {
  for (const url of ['ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'data:image/png;base64,AA']) {
    await assert.rejects(() => assertSafeHttpUrl(url));
  }
});

test('assertSafeHttpUrl: rejects literal private IPs without DNS', async () => {
  for (const url of ['http://127.0.0.1:3000/', 'http://192.168.1.1/admin', 'http://169.254.169.254/latest/meta-data/']) {
    await assert.rejects(() => assertSafeHttpUrl(url));
  }
});

test('assertSafeHttpUrl: allows public literal IP', async () => {
  const u = await assertSafeHttpUrl('http://93.158.134.3/x');
  assert.equal(u.hostname, '93.158.134.3');
});
