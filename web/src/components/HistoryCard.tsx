import type { HistoryEntry } from '../types';
import { SmartImage } from './SmartImage';
import { Badge } from './Badge';

function titleParts(full: string): { main: string; tags: string[] } {
  const main = full.replace(/\s*[(\[].*$/, '').trim();
  const tags: string[] = [];
  const re = /\([^)]*\)|\[[^\]]*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(full)) !== null) {
    tags.push(m[0]);
  }
  return { main, tags };
}

export function HistoryCard({
  e,
  onOpen,
  onRemove,
}: {
  e: HistoryEntry;
  onOpen: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  const { main, tags } = titleParts(e.title);
  return (
    <div
      className="card history-card"
      onClick={() => onOpen(e.id)}
      onKeyDown={(ev) => {
        if (ev.target !== ev.currentTarget) return;
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onOpen(e.id);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <button
        className="history-remove"
        aria-label="Удалить из истории"
        title="Удалить из истории"
        onClick={(ev) => {
          ev.stopPropagation();
          onRemove(e.id);
        }}
      >
        ×
      </button>
      <div className="card-poster">
        <SmartImage src={e.poster} alt={main} />
      </div>
      <div className="card-info">
        <div className="title">{main}</div>
        {tags.length > 0 && (
          <div className="tags">
            {tags.map((t) => (
              <div className="tag" key={t}>
                {t}
              </div>
            ))}
          </div>
        )}
        <div className="card-bottom">
          <div className="meta">
            <Badge tone="seeds">{e.seeds}</Badge>
            {e.resolution && <Badge tone="res">{e.resolution}</Badge>}
            {e.bitrate && <Badge tone="bitrate">{e.bitrate}</Badge>}
            <Badge tone="size">{e.sizeHuman}</Badge>
            {e.duration && <Badge tone="dur">{e.duration}</Badge>}
          </div>
        </div>
      </div>
    </div>
  );
}
