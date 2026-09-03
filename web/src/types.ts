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
  bitrate: string | null;
  tags: string[];
  duration: string | null;
}

export type SortKey = 'seeds' | 'size' | 'bitrate' | 'resolution';
export type SortDir = 'asc' | 'desc';

export interface EnrichEntry {
  poster?: string;
  bitrate?: string;
  resolution?: string;
  duration?: string;
}

export interface HistoryEntry {
  id: number;
  title: string;
  category: string;
  poster: string | null;
  sizeHuman: string;
  seeds: number;
  leech: number;
  resolution: string | null;
  bitrate: string | null;
  duration: string | null;
  enrichTried?: boolean;
  date: string;
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

export interface LoginResult {
  ok: boolean;
  captcha?: boolean;
  username?: string;
  error?: string;
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
  transcodedSec: number | null;
  file: {
    index: number;
    length: number;
    downloaded: number;
    progress: number;
  } | null;
}

export interface VpnNodeInfo {
  name: string;
  pingMs: number | null;
  ok: boolean;
  country: string;
  error: string;
}

export interface VpnStatus {
  subscriptionUrl: string;
  enabled: boolean;
  selectedName: string | null;
  checking: boolean;
  proxyUp: boolean;
  error: string;
  nodes: VpnNodeInfo[];
}
