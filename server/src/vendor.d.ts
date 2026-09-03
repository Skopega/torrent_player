declare module 'parse-torrent' {
  export interface ParsedTorrent {
    infoHash: string;
    name: string;
    length: number;
    files: Array<{ path: string; length: number }>;
  }
  export default function parseTorrent(id: string | Buffer | Uint8Array): Promise<ParsedTorrent>;
}

declare module 'webtorrent' {
  import { EventEmitter } from 'node:events';

  export interface TorrentFile {
    name: string;
    path: string;
    length: number;
    size: number;
    type: string;
    offset: number;
    done: boolean;
    readonly downloaded: number;
    readonly progress: number;
    select(priority?: number): void;
    deselect(): void;
    createReadStream(opts?: { start?: number; end?: number }): import('node:stream').Readable;
  }

  export interface Torrent extends EventEmitter {
    readonly infoHash: string;
    readonly name: string;
    readonly path: string;
    readonly length: number;
    readonly pieceLength: number;
    readonly pieces: Array<{ missing: number; received: boolean } | null>;
    readonly bitfield: { get(index: number): boolean };
    readonly files: TorrentFile[];
    readonly downloaded: number;
    readonly uploaded: number;
    readonly downloadSpeed: number;
    readonly uploadSpeed: number;
    readonly numPeers: number;
    readonly progress: number;
    readonly done: boolean;
    readonly ready: boolean;
    readonly destroyed: boolean;
    readonly paused: boolean;
    select(start: number, end: number, priority?: number, notify?: () => void): void;
    deselect(start: number, end: number): void;
    critical(start: number, end: number): void;
    pause(): void;
    resume(): void;
    destroy(opts?: { destroyStore?: boolean } | (() => void), cb?: () => void): void;
  }

  export interface AddOptions {
    path?: string;
    addUID?: boolean;
    deselect?: boolean;
    store?: (chunkLength: number, opts: Record<string, unknown>) => unknown;
    storeCacheSlots?: number;
    storeOpts?: unknown;
    destroyStoreOnDestroy?: boolean;
    [key: string]: unknown;
  }

  export default class WebTorrent extends EventEmitter {
    constructor(opts?: { dht?: boolean | object; maxConns?: number; tracker?: object; [key: string]: unknown });
    readonly torrents: Torrent[];
    readonly downloadSpeed: number;
    readonly uploadSpeed: number;
    readonly progress: number;
    add(
      torrentId: string | Buffer | Uint8Array,
      opts?: AddOptions,
      ontorrent?: (torrent: Torrent) => void,
    ): Torrent;
    remove(torrentId: unknown, opts?: unknown, cb?: () => void): Promise<void>;
    destroy(cb?: () => void): void;
  }
}
