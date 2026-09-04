import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectImageType } from '../src/images.js';

function sig(bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

test('detectImageType: recognizes rasters by magic', () => {
  assert.equal(detectImageType(sig([0xff, 0xd8, 0xff, 0xe0, 0x00])), 'image/jpeg');
  assert.equal(detectImageType(sig([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(detectImageType(Buffer.from('GIF89a....', 'latin1')), 'image/gif');
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]);
  assert.equal(detectImageType(webp), 'image/webp');
  assert.equal(detectImageType(Buffer.from('BMxxxx', 'latin1')), 'image/bmp');
  const avif = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif', 'latin1')]);
  assert.equal(detectImageType(avif), 'image/avif');
});

test('detectImageType: rejects svg/html/text and tiny buffers', () => {
  assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8')), null);
  assert.equal(detectImageType(Buffer.from('<!DOCTYPE html><html>..', 'utf8')), null);
  assert.equal(detectImageType(Buffer.from('plain text', 'utf8')), null);
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8])), null);
  assert.equal(detectImageType(Buffer.alloc(0)), null);
});
