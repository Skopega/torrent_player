export interface VideoRef {
  topicId: number;
  fileIndex: number;
}

// Имя каталога HLS-сессии: `${topicId}_${fileIndex}_${audio}_${startSec}_${res}`.
// topicId и fileIndex — целые без подчёркиваний, поэтому парсятся первыми.
export function parseHlsDir(name: string): VideoRef | null {
  const parts = name.split('_');
  if (parts.length < 2) return null;
  const topicId = Number(parts[0]);
  const fileIndex = Number(parts[1]);
  if (!Number.isInteger(topicId) || !Number.isInteger(fileIndex)) return null;
  return { topicId, fileIndex };
}

// Имя каталога превью: `${topicId}_${fileIndex}`.
export function parseThumbDir(name: string): VideoRef | null {
  const parts = name.split('_');
  if (parts.length < 2) return null;
  const topicId = Number(parts[0]);
  const fileIndex = Number(parts[1]);
  if (!Number.isInteger(topicId) || !Number.isInteger(fileIndex)) return null;
  return { topicId, fileIndex };
}

// Держим ли каталог при prune: то же видео (topicId и, если задан, fileIndex).
// keepFileIndex === null → сохраняем все файлы этого топика (кеш топика целиком).
export function matchesKeep(
  ref: VideoRef,
  keepTopicId: number,
  keepFileIndex: number | null,
): boolean {
  if (ref.topicId !== keepTopicId) return false;
  if (keepFileIndex != null && ref.fileIndex !== keepFileIndex) return false;
  return true;
}
