import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { SortDir, SortKey } from '../types';

function SortDropdown({
  sortKey,
  sortDir,
  onSortKey,
  onSortDir,
}: {
  sortKey: SortKey;
  sortDir: SortDir;
  onSortKey: (k: SortKey) => void;
  onSortDir: (d: SortDir) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const label = SORT_LABELS[sortKey];

  return (
    <div className="sort-control" ref={ref}>
      <span className="filter-label">Сортировка</span>
      <div className="sort-select">
        <button
          type="button"
          className="sort-btn"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="sort-btn-dir">
            <SortDirIcon dir={sortDir} />
          </span>
          <span className="sort-btn-label">{label}</span>
          <svg className="sort-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {open && (
          <div className="sort-menu" role="listbox">
            <div className="sort-menu-group">Порядок</div>
            {(['asc', 'desc'] as SortDir[]).map((d) => (
              <button
                key={d}
                type="button"
                className={`sort-item${sortDir === d ? ' active' : ''}`}
                onClick={() => onSortDir(d)}
              >
                <span className="sort-item-icon">
                  <SortDirIcon dir={d} />
                </span>
                {d === 'asc' ? 'По возрастанию' : 'По убыванию'}
              </button>
            ))}
            <div className="sort-sep" />
            <div className="sort-menu-group">Поле</div>
            {SORT_OPTIONS.map((k) => (
              <button
                key={k}
                type="button"
                className={`sort-item${sortKey === k ? ' active' : ''}`}
                onClick={() => onSortKey(k)}
              >
                <span className="sort-item-check">
                  {sortKey === k && (
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </span>
                {SORT_LABELS[k]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SortDirIcon({ dir }: { dir: SortDir }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {dir === 'asc' ? (
        <path d="M12 5v14m0 0-5-5m5 5 5-5" />
      ) : (
        <path d="M12 19V5m0 0-5 5m5-5 5 5" />
      )}
    </svg>
  );
}

function DualSlider({
  min,
  max,
  step,
  value,
  onChange,
  unit,
  color,
}: {
  min: number;
  max: number;
  step: number;
  value: [number, number];
  onChange: (v: [number, number]) => void;
  unit: string;
  color?: string;
}) {
  const [low, high] = value;
  const span = max - min || 1;
  const pct = (v: number) => ((v - min) / span) * 100;
  const fillStyle: CSSProperties = {
    left: `${pct(low)}%`,
    right: `${100 - pct(high)}%`,
  };
  const sliderStyle: CSSProperties = color ? { ['--dual-color' as string]: color } : {};
  return (
    <>
      <div className="dual-slider" style={sliderStyle}>
        <div className="dual-rail">
          <div className="dual-fill" style={fillStyle} />
        </div>
        <input
          type="range"
          className="dual-range"
          min={min}
          max={max}
          step={step}
          value={low}
          onChange={(e) => onChange([Math.min(Number(e.target.value), high), high])}
        />
        <input
          type="range"
          className="dual-range"
          min={min}
          max={max}
          step={step}
          value={high}
          onChange={(e) => onChange([low, Math.max(Number(e.target.value), low)])}
        />
      </div>
      <div className="dual-values">
        <span>
          {low}
          {unit}
        </span>
        <span className="dual-values-sep">–</span>
        <span>
          {high}
          {unit}
        </span>
      </div>
    </>
  );
}

const PRESETS = ['1080p+', '1080p', '720p'] as const;

const SORT_LABELS: Record<SortKey, string> = {
  seeds: 'По сидам',
  size: 'По весу',
  bitrate: 'По битрейту',
  resolution: 'По разрешению',
};

const SORT_OPTIONS: SortKey[] = ['seeds', 'size', 'bitrate', 'resolution'];

export interface FilterBarProps {
  resolution: string | null;
  onResolution: (r: string | null) => void;
  sizeBounds: [number, number];
  sizeRange: [number, number];
  onSizeRange: (r: [number, number]) => void;
  bitrateBounds: [number, number];
  bitrateRange: [number, number];
  onBitrateRange: (r: [number, number]) => void;
  sortKey: SortKey;
  sortDir: SortDir;
  onSortKey: (k: SortKey) => void;
  onSortDir: (d: SortDir) => void;
}

export function FilterBar({
  resolution,
  onResolution,
  sizeBounds,
  sizeRange,
  onSizeRange,
  bitrateBounds,
  bitrateRange,
  onBitrateRange,
  sortKey,
  sortDir,
  onSortKey,
  onSortDir,
}: FilterBarProps) {
  return (
    <div className="filter-bar">
      <div className="filter-group">
        <span className="filter-label">Качество</span>
        <div className="preset-row">
          {PRESETS.map((p) => (
            <button
              key={p}
              className={`preset-btn${resolution === p ? ' active' : ''}`}
              onClick={() => onResolution(resolution === p ? null : p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <span className="filter-divider" />

      <div className="filter-mid">
        <div className="filter-block">
          <span className="filter-label">Битрейт</span>
          <div className="dual-wrap">
            <DualSlider
              min={bitrateBounds[0]}
              max={bitrateBounds[1]}
              step={1}
              value={bitrateRange}
              onChange={onBitrateRange}
              unit=" Mbps"
              color="var(--orange)"
            />
          </div>
        </div>

        <div className="filter-block">
          <span className="filter-label">Вес</span>
          <div className="dual-wrap">
            <DualSlider
              min={sizeBounds[0]}
              max={sizeBounds[1]}
              step={1}
              value={sizeRange}
              onChange={onSizeRange}
              unit=" GB"
              color="#a98fdc"
            />
          </div>
        </div>
      </div>

      <span className="filter-divider" />

      <SortDropdown
        sortKey={sortKey}
        sortDir={sortDir}
        onSortKey={onSortKey}
        onSortDir={onSortDir}
      />
    </div>
  );
}
