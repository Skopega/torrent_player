import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function CacheButton() {
  const [bytes, setBytes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.cacheSize().then(setBytes).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const iv = window.setInterval(refresh, 15000);
    return () => window.clearInterval(iv);
  }, [refresh]);

  const clear = async () => {
    if (
      !window.confirm(
        'Очистить локальный кеш (постеры, метаданные и скачанные куски раздач)?',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const b = await api.cacheClear();
      setBytes(b);
    } catch {
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className="cache-btn"
      onClick={clear}
      title="Очистить локальный кеш"
      disabled={busy || bytes == null}
    >
      <span className="cache-label">Кеш</span>
      <span className="cache-size">{busy ? '…' : bytes == null ? '…' : formatBytes(bytes)}</span>
    </button>
  );
}
