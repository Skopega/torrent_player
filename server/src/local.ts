import fs from 'node:fs';
import path from 'node:path';
import parseTorrent from 'parse-torrent';
import { DATA_DIR, ensureDir, writeJson } from './store.js';

// Персистентное хранилище источников локальных (magnet/.torrent) раздач.
//
// Живёт ВНЕ data/cache (data/local/<absId>/), поэтому его не касаются ни
// clearVideoCache, ни clearCache (включая стартовую очистку метаданных >1GB), ни
// prune «других видео». Источник удаляется только когда запись истории покидает
// список: ручной крестик или вытеснение за общий кап.
//
// Раздача получает отрицательный числовой id (-1, -2, …) из персистентного
// счётчика: вся плейбек-инфраструктура (stream/hls/thumbnails/history) завязана
// на число и работает с отрицательными id без изменений.
//
// Структура каталога:
//   data/local/index.json                 — реестр (next-счётчик + метаданные)
//   data/local/<absId>/source.torrent     — .torrent для file-источников
//   data/local/<absId>/banner.jpg         — баннер (если сгенерирован)

export interface LocalMeta {
  id: number; // отрицательный topic id
  absId: number;
  name: string;
  kind: 'magnet' | 'torrent';
  magnet?: string; // для kind='magnet' — исходная строка (персистится в index.json)
  hasBanner: boolean;
  createdAt: string;
}

const ROOT = path.join(DATA_DIR, 'local');
const INDEX_FILE = path.join(ROOT, 'index.json');

interface LocalIndex {
  next: number;
  items: Record<string, LocalMeta>;
}

function readIndex(): LocalIndex {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8')) as Partial<LocalIndex>;
    const items: Record<string, LocalMeta> = {};
    if (raw.items && typeof raw.items === 'object') {
      for (const [k, v] of Object.entries(raw.items)) {
        if (v && typeof v === 'object' && Number.isInteger(v.absId)) items[k] = v;
      }
    }
    const next = Number.isInteger(raw.next) && (raw.next as number) > 0 ? (raw.next as number) : 1;
    return { next, items };
  } catch {
    return { next: 1, items: {} };
  }
}

function dirFor(absId: number): string {
  return path.join(ROOT, String(absId));
}

export class LocalLibrary {
  private next: number;
  private items = new Map<number, LocalMeta>(); // absId -> meta

  constructor() {
    ensureDir(ROOT);
    const idx = readIndex();
    this.next = idx.next;
    for (const [k, meta] of Object.entries(idx.items)) {
      const absId = Number(k);
      if (Number.isInteger(absId) && absId > 0) this.items.set(absId, meta);
    }
  }

  private persist(): void {
    const items: Record<string, LocalMeta> = {};
    for (const [absId, meta] of this.items) items[String(absId)] = meta;
    const data: LocalIndex = { next: this.next, items };
    writeJson(INDEX_FILE, data);
  }

  private create(meta: Omit<LocalMeta, 'id' | 'absId' | 'createdAt'>, absId?: number): LocalMeta {
    // По умолчанию id выдаёт персистентный счётчик. При явном absId (сервис
    // выбирает его так, чтобы не совпасть с id уже существующих записей истории —
    // защита от «наследования» настроек после потери реестра) счётчик двигаем вверх.
    const useAbs =
      absId != null && absId > 0 && !this.items.has(absId) ? absId : this.next++;
    if (absId != null && absId > 0 && useAbs === absId) {
      this.next = Math.max(this.next, absId + 1);
    }
    const full: LocalMeta = {
      ...meta,
      absId: useAbs,
      id: -useAbs,
      createdAt: new Date().toISOString(),
    };
    ensureDir(dirFor(useAbs));
    this.items.set(useAbs, full);
    this.persist();
    return full;
  }

  // Регистрирует magnet-ссылку. name — подсказка (dn из magnet), если не задан.
  async addMagnet(magnet: string, name?: string, absId?: number): Promise<LocalMeta> {
    if (typeof magnet !== 'string' || !magnet.trim()) throw new Error('bad_magnet');
    let parsed: { infoHash?: string; name?: string } | null = null;
    try {
      parsed = (await parseTorrent(magnet.trim())) as { infoHash?: string; name?: string };
    } catch {
      parsed = null;
    }
    if (!parsed?.infoHash) throw new Error('bad_magnet');
    const suggested = typeof name === 'string' && name.trim() ? name.trim() : parsed.name?.trim() ?? '';
    return this.create(
      { name: suggested, kind: 'magnet', magnet: magnet.trim(), hasBanner: false },
      absId,
    );
  }

  // Регистрирует .torrent (сырые байты файла). name — подсказка из .torrent.
  async addTorrent(buf: Buffer, name?: string, absId?: number): Promise<LocalMeta> {
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('bad_torrent');
    let parsed: { name?: string; infoHash?: string } | null = null;
    try {
      parsed = (await parseTorrent(buf)) as { name?: string; infoHash?: string };
    } catch {
      parsed = null;
    }
    if (!parsed?.infoHash) throw new Error('bad_torrent');
    const meta = this.create(
      {
        name: typeof name === 'string' && name.trim() ? name.trim() : parsed.name?.trim() ?? '',
        kind: 'torrent',
        hasBanner: false,
      },
      absId,
    );
    const target = path.join(dirFor(meta.absId), 'source.torrent');
    ensureDir(dirFor(meta.absId));
    try {
      fs.writeFileSync(target, buf);
    } catch (e) {
      // Не смогли сохранить файл — откатываем регистрацию.
      this.items.delete(meta.absId);
      this.persist();
      try {
        fs.rmSync(dirFor(meta.absId), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
    return meta;
  }

  list(): LocalMeta[] {
    return [...this.items.values()].sort((a, b) => a.absId - b.absId);
  }

  // Возвращает мету по topic id (отрицательному) или по absId.
  get(idOrAbs: number): LocalMeta | null {
    const absId = idOrAbs < 0 ? -idOrAbs : idOrAbs;
    return this.items.get(absId) ?? null;
  }

  getByTopicId(id: number): LocalMeta | null {
    if (id >= 0) return null;
    return this.items.get(-id) ?? null;
  }

  dir(absIdOrId: number): string {
    return dirFor(absIdOrId < 0 ? -absIdOrId : absIdOrId);
  }

  bannerPath(id: number): string {
    const meta = this.getByTopicId(id) ?? this.get(id);
    return path.join(dirFor(meta?.absId ?? 0), 'banner.jpg');
  }

  sourceTorrentPath(id: number): string | null {
    const meta = this.getByTopicId(id) ?? this.get(id);
    if (!meta || meta.kind !== 'torrent') return null;
    return path.join(dirFor(meta.absId), 'source.torrent');
  }

  rename(id: number, name: string): LocalMeta | null {
    const meta = this.getByTopicId(id) ?? this.get(id);
    if (!meta) return null;
    meta.name = name.trim();
    this.persist();
    return meta;
  }

  setBanner(id: number, hasBanner: boolean): LocalMeta | null {
    const meta = this.getByTopicId(id) ?? this.get(id);
    if (!meta) return null;
    meta.hasBanner = hasBanner;
    this.persist();
    return meta;
  }

  // Удаляет источник целиком (каталог + запись реестра). true — было удалено.
  remove(idOrAbs: number): boolean {
    const meta = this.getByTopicId(idOrAbs) ?? this.get(idOrAbs);
    if (!meta) return false;
    this.items.delete(meta.absId);
    this.persist();
    try {
      fs.rmSync(dirFor(meta.absId), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return true;
  }

  // Удаляет источники, чьих id нет в keepTopicIds. Возвращает удалённые absId.
  // Вызывается на старте сервера: реестр источника должен соответствовать
  // локальным записям истории (в т.ч. чистит «осиротевшие» после краша до play).
  sweep(keepTopicIds: Iterable<number>): number[] {
    const keep = new Set(keepTopicIds);
    const removed: number[] = [];
    for (const [absId, meta] of [...this.items]) {
      if (keep.has(meta.id)) continue;
      this.items.delete(absId);
      removed.push(absId);
      try {
        fs.rmSync(dirFor(absId), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    if (removed.length > 0) this.persist();
    return removed;
  }
}
