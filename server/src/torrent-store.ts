// Хранилище торрент-файлов с проверкой путей.
//
// Причина: имена раздачи и пути файлов приходят из метаданных торрента (magnet/
// .torrent), т.е. из недоверенного источника. WebTorrent/fs-chunk-store склеивают
// `path + name + dirname(file.path)` без санитайза, поэтому значение вида
// `..\..\..\evil` писало бы файлы ВНЕ каталога кеша. Здесь мы:
//   1) вычищаем опасные компоненты из имени раздачи и путей файлов;
//   2) после super() проверяем, что каждый результирующий путь остался внутри
//      корня хранилища (defense in depth).
// Легитимные торренты не содержат `..`/абсолютных путей, поэтому для них это
// тождественное преобразование — на скорость и структуру папок не влияет.

import path from 'node:path';
import FSChunkStore from 'fs-chunk-store';

// Убирает разделители путей, `..`, `.`, управляющие и недопустимые в именах
// символы из относительного пути. Промежуточные подкаталоги сохраняются.
export function sanitizeTorrentPath(value: unknown): string {
  const parts = String(value ?? '')
    .replace(/\\/g, '/')
    .split('/');
  const out: string[] = [];
  for (const raw of parts) {
    const part = raw.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
    if (!part || part === '.' || part === '..') continue;
    out.push(part);
  }
  return out.join('/');
}

// Имя раздачи используется как один компонент пути — разделители схлопываем.
export function sanitizeTorrentName(value: unknown): string {
  const cleaned = sanitizeTorrentPath(value).replace(/\//g, '_');
  return cleaned || 'torrent';
}

interface StoreFile {
  path: string;
  length: number;
  offset: number;
  [key: string]: unknown;
}

export class SafeFSChunkStore extends FSChunkStore {
  constructor(chunkLength: number, opts: Record<string, unknown> = {}) {
    const safe: Record<string, unknown> = { ...opts };
    safe.name = sanitizeTorrentName(opts.name);
    if (Array.isArray(safe.files)) {
      safe.files = (safe.files as StoreFile[]).map((file, i) => ({
        ...file,
        path: sanitizeTorrentPath(file?.path) || `file_${i}`,
      }));
    }
    super(chunkLength, safe);

    const root = path.resolve(String(this.path ?? '.'));
    for (const file of this.files) {
      const resolved = path.resolve(file.path);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error('Unsafe torrent path outside store root');
      }
    }
  }
}
