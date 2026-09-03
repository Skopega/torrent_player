import { Fragment, useEffect, useState } from 'react';
import { api, posterUrl } from '../api';
import type { Topic } from '../types';
import { SmartImage } from './SmartImage';
import { Player } from './Player';

function findField(topic: Topic, needle: string): string | undefined {
  const f = topic.fields.find((x) => x.key.toLowerCase().includes(needle));
  return f?.value;
}

function splitTitle(title: string): { main: string; meta: string } {
  const idx = title.search(/[(\[]/);
  if (idx < 0) return { main: title.trim(), meta: '' };
  return { main: title.slice(0, idx).trim(), meta: title.slice(idx).trim() };
}

const SHOWN_KEYS = [
  'год',
  'страна',
  'жанр',
  'продолжительность',
  'описание',
];

export function DetailPage({
  id,
  onBack,
  onWatched,
}: {
  id: number;
  onBack: () => void;
  onWatched?: (topic: Topic) => void;
}) {
  const [topic, setTopic] = useState<Topic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPlayer, setShowPlayer] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTopic(null);
    setError(null);
    api
      .topic(id)
      .then((t) => !cancelled && setTopic(t))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'error'));
    // Фоновый прогрев раздачи: грузим торрент и тянем голову/хвост, чтобы
    // первый запуск и перемотка были быстрыми.
    api.warmStream(id);
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div className="state">
        <p>Не удалось загрузить страницу: {error}</p>
        <button className="back" onClick={onBack}>
          ← Назад
        </button>
      </div>
    );
  }

  if (!topic) {
    return (
      <div className="state state-loading">
        <div className="spinner" />
      </div>
    );
  }

  const year = findField(topic, 'год');
  const country = findField(topic, 'страна');
  const genre = findField(topic, 'жанр');
  const duration = findField(topic, 'продолжительность');
  const desc = findField(topic, 'описание');

  const remaining = topic.fields.filter(
    (f) => !SHOWN_KEYS.some((k) => f.key.toLowerCase().includes(k)),
  );

  const { main: titleMain, meta: titleMeta } = splitTitle(topic.title);

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

      <div className="detail-page">
        <div className="detail-hero">
          {topic.poster && (
            <div className="detail-hero-bg">
              <img src={posterUrl(topic.poster)} alt="" aria-hidden="true" />
            </div>
          )}
          <div className="detail-hero-fade" />
          <div className="detail-hero-content">
            <div className="detail-poster">
              <div className="poster-box">
                <SmartImage src={topic.poster} alt={topic.title} />
              </div>
            </div>

            <div className="detail-main">
              <h1>{titleMain}</h1>
              {titleMeta && <div className="detail-meta">{titleMeta}</div>}
              <div className="detail-category">{topic.category}</div>

              <div className="chips">
                {year && (
                  <span className="chip">
                    <b>Год</b>
                    {year}
                  </span>
                )}
                {country && (
                  <span className="chip">
                    <b>Страна</b>
                    {country}
                  </span>
                )}
                {genre && (
                  <span className="chip">
                    <b>Жанр</b>
                    {genre}
                  </span>
                )}
                {duration && (
                  <span className="chip">
                    <b>Длительность</b>
                    {duration}
                  </span>
                )}
              </div>

              <div className="actions">
                <button
                  className="btn-play"
                  onClick={() =>
                    setShowPlayer((v) => {
                      const next = !v;
                      if (next) onWatched?.(topic);
                      return next;
                    })
                  }
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                    <path d="M8.5 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86Z" />
                  </svg>
                  {showPlayer ? 'Скрыть плеер' : 'Смотреть'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {showPlayer && (
          <div className="player-wrap">
            <Player topicId={topic.id} />
          </div>
        )}

        <div className="detail-body">
          {desc && <p className="desc">{desc}</p>}

          <div className="stat-row">
            <div className="stat">
              <span className="n" style={{ color: 'var(--green)' }}>
                {topic.seeds}
              </span>
              <span className="l">сиды</span>
            </div>
            <div className="stat">
              <span className="n" style={{ color: 'var(--orange)' }}>
                {topic.leech}
              </span>
              <span className="l">личи</span>
            </div>
            <div className="stat">
              <span className="n">{topic.sizeHuman}</span>
              <span className="l">размер</span>
            </div>
            {topic.resolution && (
              <div className="stat">
                <span className="n">{topic.resolution}</span>
                <span className="l">качество</span>
              </div>
            )}
            {topic.bitrate && (
              <div className="stat">
                <span className="n">{topic.bitrate}</span>
                <span className="l">битрейт</span>
              </div>
            )}
          </div>

          {remaining.length > 0 && (
            <div className="fields-block">
              <h3 className="section-title">Основные сведения</h3>
              <div className="fields">
                {remaining.map((f) => (
                  <Fragment key={f.key}>
                    <div className="k">{f.key}</div>
                    <div className="v">{f.value}</div>
                  </Fragment>
                ))}
              </div>
            </div>
          )}

          {topic.description && (
            <details className="tech">
              <summary>Технические детали</summary>
              <pre>{topic.description}</pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
