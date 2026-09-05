import type { SearchResult } from '../types';
import { SmartImage } from './SmartImage';
import { Badge } from './Badge';

export function PosterCard({
  r,
  onOpen,
  onPrefetch,
}: {
  r: SearchResult;
  onOpen: (id: number) => void;
  onPrefetch: (id: number) => void;
}) {
  return (
    <div
      className="card"
      onClick={() => onOpen(r.id)}
      onMouseEnter={() => onPrefetch(r.id)}
      onFocus={() => onPrefetch(r.id)}
      onKeyDown={(ev) => {
        if (ev.target !== ev.currentTarget) return;
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onOpen(r.id);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="card-poster">
        <SmartImage src={r.poster} alt={r.title} />
      </div>
      <div className="card-info">
        <div className="title">{r.title}</div>
        {r.tags.length > 0 && (
          <div className="tags">
            {r.tags.join(' · ')}
          </div>
        )}
        <div className="card-bottom">
          <div className="meta">
            <Badge tone="seeds">{r.seeds}</Badge>
            {r.resolution && <Badge tone="res">{r.resolution}</Badge>}
            {r.bitrate && <Badge tone="bitrate">{r.bitrate}</Badge>}
            <Badge tone="size">{r.sizeHuman}</Badge>
            {r.duration && <Badge tone="dur">{r.duration}</Badge>}
          </div>
        </div>
      </div>
    </div>
  );
}
