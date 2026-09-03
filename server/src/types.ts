export interface SearchResult {
  id: number;
  title: string;
  category: string;
  size: number;
  sizeHuman: string;
  seeds: number;
  leech: number;
  downloads: number;
  date: string;
  poster: string | null;
  resolution: string | null;
  tags: string[];
  duration: string | null;
}

export interface TopicField {
  key: string;
  value: string;
}

export interface Topic {
  id: number;
  title: string;
  category: string;
  poster: string | null;
  fields: TopicField[];
  description: string;
  sizeBytes: number;
  sizeHuman: string;
  seeds: number;
  leech: number;
  downloads: number;
  dateAdded: string;
  magnet: string | null;
  bitrate: string | null;
  resolution: string | null;
  duration: string | null;
}

export interface AuthStatus {
  loggedIn: boolean;
  username: string | null;
}

export interface StreamFile {
  index: number;
  name: string;
  path: string;
  length: number;
  ext: string;
  mime: string;
  isVideo: boolean;
}

export interface TrackInfo {
  index: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  channels: number | null;
  default: boolean;
  forced: boolean;
  isText: boolean;
}

export interface MediaInfo {
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  fps: number | null;
  bitrate: number | null;
  pixFmt: string | null;
  canDirectPlay: boolean;
  audioTracks: TrackInfo[];
  subtitleTracks: TrackInfo[];
}

export interface StreamStatus {
  infoHash: string;
  ready: boolean;
  downloaded: number;
  downloadSpeed: number;
  numPeers: number;
  progress: number;
  paused: boolean;
  file: {
    index: number;
    length: number;
    downloaded: number;
    progress: number;
  } | null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}
