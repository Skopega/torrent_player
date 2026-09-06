import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { LocalInfo } from '../types';
import { Player } from './Player';

// Страница локального плеера для magnet/.torrent раздачи (id отрицательный).
// Сверху — редактируемое имя раздачи (обновляет запись истории), ниже — плеер.
// Запись истории создаётся на первый фактический play (onFirstPlay → watch),
// баннер сервер генерирует в фоне из случайного кадра средней части таймлайна.
export function LocalPage({ id, onBack }: { id: number; onBack: () => void }) {
  const [info, setInfo] = useState<LocalInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const nameRef = useRef(name);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  useEffect(() => {
    let cancelled = false;
    api
      .localInfo(id)
      .then((i) => {
        if (cancelled) return;
        setInfo(i);
        setName(i.name);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Не удалось загрузить раздачу.');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // «Страницу закрыли до начала просмотра»: если запись истории так и не создана,
  // источник (magnet/.torrent) удаляется. Задержка позволяет вернуться на страницу
  // (StrictMode/быстрый back-forward) без потери регистрации.
  useEffect(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    return () => {
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        void api.localClose(id).catch(() => {});
      }, 5000);
    };
  }, [id]);

  // Один раз на первый play: сервер создаёт запись истории и генерирует баннер.
  // После watch подтягиваем актуальное имя (для magnet настоящее имя приходит
  // вместе с метаданными) — но не перезаписываем, если пользователь уже печатает.
  const handleFirstPlay = useCallback(
    (_topicId: number, fileIndex: number) => {
      api
        .localWatch(id, { name: nameRef.current.trim() || undefined, fileIndex })
        .then(() => api.localInfo(id))
        .then((i) => {
          setInfo((p) => (p ? { ...p, name: i.name } : p));
          if (!nameRef.current.trim()) setName(i.name);
        })
        .catch(() => {});
    },
    [id],
  );

  const commitName = () => {
    if (!dirty) return;
    const n = name.trim();
    if (!n) {
      setName(info?.name ?? '');
      setDirty(false);
      return;
    }
    if (info && info.name === n) {
      setDirty(false);
      return;
    }
    setDirty(false);
    api
      .localRename(id, n)
      .then((upd) => {
        setInfo((p) => (p ? { ...p, name: upd.name } : p));
        setName(upd.name);
      })
      .catch(() => {});
  };

  if (error) {
    return (
      <div className="state">
        <p>{error}</p>
        <button className="back" onClick={onBack}>
          ← Назад
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="detail-top">
        <button className="back" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
          Назад
        </button>
      </div>

      <div className="local-page">
        <div className="local-head">
          <input
            className="local-name"
            value={name}
            placeholder="Название раздачи"
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            onBlur={commitName}
            aria-label="Название раздачи"
          />
          <div className="local-hint">
            {info?.kind === 'magnet' ? 'Magnet' : '.torrent'} · нажмите play — раздача
            появится в истории{!info?.hasBanner ? ' с баннером' : ''}
          </div>
        </div>

        <div className="player-wrap">
          <Player topicId={id} onFirstPlay={handleFirstPlay} />
        </div>
      </div>
    </div>
  );
}
