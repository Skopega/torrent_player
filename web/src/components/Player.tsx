import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  api,
  hlsPlaylistUrl,
  streamUrl,
  subtitleUrl,
  thumbnailUrl,
  THUMB_INTERVAL_SEC,
} from '../api';
import type { MediaInfo, StreamFile, StreamStatus, TrackInfo } from '../types';

const SUB_WINDOW = 120;
const SUB_LEAD = 10;
const SUB_MARGIN = 30;
const SUB_POLL_MS = 2000;
// Должно совпадать с SEGMENT_SECONDS на сервере (hls.ts): позиция HLS-сессии
// округляется до границы сегмента, чтобы кеш сегментов попадал при близких перемотках.
const HLS_SEGMENT_SECONDS = 2;
const roundStart = (t: number) => Math.max(0, Math.floor(t / HLS_SEGMENT_SECONDS) * HLS_SEGMENT_SECONDS);

// Сохранение прогресса «продолжить с последней серии»: позиция пишется, только
// когда реально просмотрено не с 0:00, и не чаще интервала/дельты.
const RESUME_MIN_SEC = 3;
const RESUME_SAVE_INTERVAL_MS = 5000;
const RESUME_SAVE_DELTA_SEC = 5;

// Доступные потолки разрешения транскода (по убыванию).
const RES_OPTIONS = [2160, 1440, 1080, 720, 480, 360];

// Метка потолка для меню качества.
const resLabel = (r: number): string => {
  if (r >= 2160) return '4K';
  return `${r}p`;
};

// Потолок «полного качества»: наименьший из RES_OPTIONS, который >= высоты исходника.
// Это максимальная высота, при которой сервер НЕ масштабирует (res < height — только
// тогда scale). Для 1920x1038 (1080p-класс) это 1080, для 4K — 2160, для 800 — 1080.
const fullResFor = (height: number | null | undefined): number => {
  if (!height || height <= 0) return RES_OPTIONS[0];
  const ascending = [...RES_OPTIONS].reverse(); // [720, 1080, 2160]
  return ascending.find((r) => r >= height) ?? RES_OPTIONS[0];
};

// Максимальное качество по умолчанию = потолок полного качества.
const maxResFor = (height: number | null | undefined): number => fullResFor(height);

interface SubCue {
  start: number;
  end: number;
  text: string;
}

// Парсит WebVTT (сдвинутый сервером под HLS-сессию) в список куи.
function parseWebVtt(text: string): SubCue[] {
  const cues: SubCue[] = [];
  const blocks = text.replace(/\r\n/g, '\n').split('\n\n');
  for (const block of blocks) {
    const lines = block.split('\n');
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx < 0) continue;
    const timing = lines[timingIdx];
    const m =
      /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})/.exec(
        timing,
      ) ?? /(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2})[.,](\d{3})/.exec(timing);
    if (!m) continue;
    let start: number;
    let end: number;
    if (m[8] !== undefined) {
      start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
      end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
    } else {
      start = Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000;
      end = Number(m[4]) * 60 + Number(m[5]) + Number(m[6]) / 1000;
    }
    const textLines = lines.slice(timingIdx + 1).join('\n').replace(/<[a-zA-Z/][^>]*>/g, '').trim();
    if (!textLines) continue;
    cues.push({ start, end, text: textLines });
  }
  return cues;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function episodeLabel(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  const m = base.match(/\b(?:сери[яиюй]|эпизод|эп|episode|ep)\s*[-_.]?(\d{1,3})\b/i);
  if (m) return `Серия ${m[1]}`;
  const m2 = base.match(/\b[sS]0?(\d{1,2})[eE]0?(\d{1,3})\b/);
  if (m2) return `Серия ${m2[2]}`;
  const m3 = base.match(/\b(\d{1,2})[xX](\d{1,3})\b/);
  if (m3) return `Серия ${m3[2]}`;
  // «Title - 01 [web-dl…]»: номер после дефиса/пробела, не часть года/разрешения (1080p).
  const m4 = base.match(/(?:^|[\s\-_[(])(\d{1,2})(?=\s*(?:[\s\]\._\-]|$))/);
  if (m4) return `Серия ${m4[1]}`;
  return base;
}

// Названия распространённых языков для дорожек.
const LANG_NAMES: Record<string, string> = {
  rus: 'Русский',
  eng: 'Английский',
  ukr: 'Украинский',
  spa: 'Испанский',
  fre: 'Французский',
  ger: 'Немецкий',
  ita: 'Итальянский',
  jpn: 'Японский',
  kor: 'Корейский',
  chi: 'Китайский',
  pol: 'Польский',
  tur: 'Турецкий',
  por: 'Португальский',
  hun: 'Венгерский',
  ces: 'Чешский',
  fra: 'Французский',
  deu: 'Немецкий',
  dan: 'Датский',
  swe: 'Шведский',
};

function trackLabel(t: TrackInfo, i: number, kind: 'audio' | 'sub'): string {
  const lang = t.language ? (LANG_NAMES[t.language] ?? t.language.toUpperCase()) : null;
  if (kind === 'sub') {
    const name = t.title ?? lang ?? null;
    return name ? `Субтитры · ${name}` : `Дорожка ${i + 1}`;
  }
  const codec = t.codec ? t.codec.toUpperCase() : '';
  const channels = t.channels ? `${t.channels} канал.` : '';
  const parts = [t.title, lang, codec, channels].filter(Boolean);
  return parts.length ? parts.join(' · ') : `Дорожка ${i + 1}`;
}

export function Player({ topicId }: { topicId: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef<HTMLDivElement>(null);
  const volumeRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const controlsTimerRef = useRef<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const volumeDragRef = useRef(false);
  const clickTimerRef = useRef<number | null>(null);
  const lastClickRef = useRef(0);
  const resumeRealRef = useRef<number | null>(null);
  const autoPlayRef = useRef(false);
  const seekStartRef = useRef<number | null>(null);
  const stallStartRef = useRef<number | null>(null);
  const statusOptsRef = useRef<{ audio: number | null; start: number; pos: number; res: number | null }>({
    audio: null,
    start: 0,
    pos: 0,
    res: null,
  });
  // Счётчик попыток recovery текущей HLS-сессии (сбрасывается при новой сессии).
  const hlsRetriesRef = useRef(0);
  // Сторож нефатальных таймаутов/сталлов (fragLoadTimeOut и т.п.): серия событий в
  // коротком окне = клин после перемотки — принудительно перезапускаем загрузку.
  const stallWatchRef = useRef<{ count: number; lastAt: number }>({ count: 0, lastAt: 0 });
  // Какому fileIndex соответствует текущий media (гейт HLS-эффекта против гонки
  // «новый fileIndex + старый media» при переключении эпизодов).
  const mediaFileRef = useRef<number | null>(null);
  // Одноразовая цель восстановления из истории: {fileIndex, позиция} для старта
  // плеера с последней серии. Потребляется probe-эффектом при успешном старте файла.
  const pendingResumeRef = useRef<{ fileIndex: number; position: number } | null>(null);
  // Одноразовые настройки звука из истории: применяются к <video>, как только он
  // появляется в DOM.
  const pendingPrefsRef = useRef<{ volume: number; muted: boolean } | null>(null);
  // Выбранные в истории дорожки (озвучка/субтитры): применяются к каждому файлу
  // (серии) при probe; обновляются при выборе в меню и сохраняются на сервер.
  const avPrefsRef = useRef<{ audioTrack: number | null; subtitleTrack: number | null }>({
    audioTrack: null,
    subtitleTrack: null,
  });
  // Последний сохранённый прогресс (для дедупликации записей на интервале).
  const lastSavedResumeRef = useRef<{ fileIndex: number; position: number } | null>(null);

  const [files, setFiles] = useState<StreamFile[] | null>(null);
  const [fileIndex, setFileIndex] = useState<number | null>(null);
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [transcodedSec, setTranscodedSec] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Инкремент пересоздаёт HLS-сессию (кнопка «Повторить» после фатальной ошибки).
  const [retryNonce, setRetryNonce] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  const [subMenuOpen, setSubMenuOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [draft, setDraft] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioSel, setAudioSel] = useState(0);
  const [subSel, setSubSel] = useState(0);
  const [resSel, setResSel] = useState<number | null>(null);
  const [sessionStart, setSessionStart] = useState(0);
  const [subWindowStart, setSubWindowStart] = useState(0);
  const [subCues, setSubCues] = useState<SubCue[]>([]);
  const [subSize, setSubSize] = useState(20);
  const [seeking, setSeeking] = useState(false);
  const [thumbPreview, setThumbPreview] = useState<{ index: number; frac: number } | null>(null);
  // Видимость превью: показываем только после onLoad готового кадра (скрываем при 404).
  const [thumbVisible, setThumbVisible] = useState(false);
  // Для сброса thumbVisible при входе в ховер (а не при каждой смене слота — иначе мерцание).
  const thumbPreviewPrevRef = useRef<{ index: number; frac: number } | null>(null);
  useEffect(() => {
    if (thumbPreview && thumbPreviewPrevRef.current === null) {
      setThumbVisible(false);
    }
    thumbPreviewPrevRef.current = thumbPreview;
  }, [thumbPreview]);

  const duration = media?.durationSec && media.durationSec > 0 ? media.durationSec : videoDuration;
  const selectedAbs = media?.audioTracks[audioSel]?.index ?? null;
  const defaultAbs = media
    ? (media.audioTracks.find((t) => t.default)?.index ?? media.audioTracks[0]?.index ?? null)
    : null;
  const directPlay = media ? media.canDirectPlay && selectedAbs === defaultAbs : false;

  // Сохраняет прогресс просмотра на сервере (в записи истории). force — финальное
  // сохранение при размонтировании: игнорируем дельту, но не порог «просмотрено
  // не с 0:00».
  const saveResume = (fileIndex: number, position: number, force = false) => {
    if (position < RESUME_MIN_SEC) return;
    const last = lastSavedResumeRef.current;
    const pos = Math.floor(position);
    if (!force && last && last.fileIndex === fileIndex && pos - last.position < RESUME_SAVE_DELTA_SEC) {
      return;
    }
    lastSavedResumeRef.current = { fileIndex, position: pos };
    api.historySetResume(topicId, fileIndex, pos).catch(() => {});
  };

  // Сохраняет громкость/mute (выбранные на слайдере) на сервере, в записи истории.
  const persistVolume = () => {
    const video = videoRef.current;
    if (!video) return;
    api.historySetVolume(topicId, video.volume, video.muted).catch(() => {});
  };

  // Сохраняет выбранные дорожки (озвучка/субтитры) на сервере, в записи истории.
  const persistTracks = () => {
    const p = avPrefsRef.current;
    api.historySetTracks(topicId, p.audioTrack, p.subtitleTrack).catch(() => {});
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFiles(null);
    setFileIndex(null);
    setMedia(null);
    setStatus(null);
    // Параллельно со списком файлов спрашиваем, с какой серии продолжить (раздача
    // в истории): сервер — источник истины, поэтому работает и по прямой ссылке.
    Promise.all([
      api.streamFiles(topicId),
      api.historyResume(topicId).catch(() => ({
        fileIndex: null,
        position: null,
        volume: null,
        muted: null,
        audioTrack: null,
        subtitleTrack: null,
      })),
    ])
      .then(([f, resume]) => {
        if (cancelled) return;
        setFiles(f);
        pendingResumeRef.current = null;
        pendingPrefsRef.current = null;
        if (resume.volume != null) {
          pendingPrefsRef.current = { volume: resume.volume, muted: resume.muted === true };
        }
        avPrefsRef.current = {
          audioTrack: resume.audioTrack ?? null,
          subtitleTrack: resume.subtitleTrack ?? null,
        };
        const target =
          resume.fileIndex != null ? f.find((x) => x.index === resume.fileIndex && x.isVideo) : null;
        if (target) {
          setFileIndex(target.index);
          if (resume.position != null && resume.position > 0) {
            pendingResumeRef.current = { fileIndex: target.index, position: resume.position };
          }
          return;
        }
        const def = f.find((x) => x.isVideo) ?? f[0] ?? null;
        setFileIndex(def ? def.index : null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Не удалось получить список файлов.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [topicId]);

  useEffect(() => {
    if (fileIndex == null) return;
    let cancelled = false;
    setMedia(null);
    setBuffering(true);
    setPlaying(false);
    setCurrentTime(0);
    setVideoDuration(0);
    setDraft(null);
    setSessionStart(0);
    setSubWindowStart(0);
    setTranscodedSec(null);
    // Смена файла = новая попытка: сбрасываем прошлую ошибку (иначе «мёртвый» экран
    // остаётся навсегда и блокирует переключение эпизодов).
    setError(null);
    setRetryNonce((n) => n + 1);
    mediaFileRef.current = null;
    api
      .streamProbe(topicId, fileIndex)
      .then((m) => {
        if (cancelled) return;
        // Выбранные дорожки из истории применяем к каждой серии: ищем сохранённые
        // потоки в текущем файле, не нашли — дефолт (default audio, субтитры off).
        const aIdx = m.audioTracks.findIndex((t) => t.default);
        let audioIdx = aIdx >= 0 ? aIdx : 0;
        if (avPrefsRef.current.audioTrack != null) {
          const found = m.audioTracks.findIndex((t) => t.index === avPrefsRef.current.audioTrack);
          if (found >= 0) audioIdx = found;
        }
        setAudioSel(audioIdx);
        let subIdx = 0;
        if (avPrefsRef.current.subtitleTrack != null) {
          const found = m.subtitleTracks.findIndex(
            (t) => t.index === avPrefsRef.current.subtitleTrack && t.isText,
          );
          if (found >= 0) subIdx = found + 1;
        }
        setSubSel(subIdx);
        // Старт последней серии с сохранённой позиции: direct-play восстановит
        // currentTime по loadedmetadata; HLS стартует от границы сегмента (sessionStart).
        const pending = pendingResumeRef.current;
        pendingResumeRef.current = null;
        const direct =
          m.canDirectPlay &&
          (m.audioTracks[audioIdx]?.index ?? null) ===
            (m.audioTracks.find((t) => t.default)?.index ?? m.audioTracks[0]?.index ?? null);
        if (pending && pending.fileIndex === fileIndex && pending.position > 0) {
          if (direct) {
            setSessionStart(0);
            setSubWindowStart(0);
            resumeRealRef.current = pending.position;
          } else {
            const start = roundStart(pending.position);
            setSessionStart(start);
            setSubWindowStart(Math.max(0, start - SUB_LEAD));
            resumeRealRef.current = null;
          }
        } else {
          setSessionStart(0);
          setSubWindowStart(0);
          resumeRealRef.current = null;
        }
        // По умолчанию — максимальное качество (выше исходника сервер и так не масштабирует).
        setResSel(maxResFor(m.height));
        mediaFileRef.current = fileIndex;
        setMedia(m);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Не удалось определить параметры файла.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [topicId, fileIndex]);

  // Запускаем фоновую генерацию превьюшек при выборе файла (идемпотентно).
  useEffect(() => {
    if (fileIndex == null) return;
    api.thumbnailsEnsure(topicId, fileIndex);
  }, [topicId, fileIndex]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || fileIndex == null || !media) return;
    // Гонка при смене эпизода: media ещё от старого файла — не стартуем сессию с
    // неверными audio/res, пока не придёт probe нового файла.
    if (mediaFileRef.current !== fileIndex) return;
    hlsRetriesRef.current = 0;
    stallWatchRef.current = { count: 0, lastAt: 0 };

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const resumeReal = resumeRealRef.current;
    resumeRealRef.current = null;
    const shouldAutoPlay = autoPlayRef.current;
    autoPlayRef.current = false;

    let nativeRestore: (() => void) | null = null;

    if (directPlay) {
      api.hlsStop(topicId, fileIndex);
      video.src = streamUrl(topicId, fileIndex);
      if (resumeReal != null && resumeReal > 0) {
        nativeRestore = () => {
          const v = videoRef.current;
          if (v) v.currentTime = resumeReal;
        };
        video.addEventListener('loadedmetadata', nativeRestore);
      }
    } else if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        // Буфер вперёд ограничиваем и по времени, и по байтам: maxBufferSize:0 +
        // 600 с (600 МБ+) вызывали bufferFullError/риск памяти на слабых машинах.
        maxBufferLength: 120,
        maxMaxBufferLength: 240,
        backBufferLength: 60,
        maxBufferSize: 256 * 1024 * 1024,
        fragLoadingTimeOut: 8000,
        fragLoadingMaxRetry: 3,
        fragLoadingRetryDelay: 500,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 2,
        levelLoadingTimeOut: 20000,
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        const payload: Record<string, unknown> = {
          topicId,
          fileIndex,
          type: data.type,
          details: data.details,
          fatal: data.fatal,
          reason: data.reason,
          errmsg: data.error instanceof Error ? data.error.message : String(data.error ?? ''),
        };
        if (data.frag) {
          payload.frag = {
            sn: data.frag.sn,
            start: data.frag.start,
            duration: data.frag.duration,
            type: data.frag.type,
            level: data.frag.level,
          };
        }
        api.clientLog(payload);
        if (!data.fatal) {
          // Нефатальные таймауты/сталлы hls.js сам ретраит, но зацикливается и
          // «вешает» плеер на минуты (в т.ч. после перемотки). Считаем серию таких
          // событий и принудительно перезапускаем загрузку (пересинхронизация с
          // живым краем плейлиста), чтобы выйти из клина.
          if (
            data.details === 'fragLoadTimeOut' ||
            data.details === 'levelLoadTimeOut' ||
            data.details === 'bufferStalledError'
          ) {
            const now = Date.now();
            const w = stallWatchRef.current;
            if (now - w.lastAt > 15000) w.count = 0;
            w.count += 1;
            w.lastAt = now;
            if (w.count >= 3) {
              w.count = 0;
              window.setTimeout(() => {
                if (hlsRef.current === hls) {
                  try {
                    hls.startLoad();
                  } catch {
                    /* ignore */
                  }
                }
              }, 300);
            }
          }
          return;
        }
        // Каноничный recovery hls.js: кратковременные сетевые/медиа-сбои не должны
        // «убивать» плеер (торрент-HLS фризит на докачке).
        if (
          data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          hlsRetriesRef.current < 3
        ) {
          hlsRetriesRef.current++;
          window.setTimeout(() => {
            if (hlsRef.current === hls) hls.startLoad();
          }, 800);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && hlsRetriesRef.current < 4) {
          hlsRetriesRef.current++;
          hls.recoverMediaError();
          return;
        }
        const detail = data.details ? ` (${data.details})` : '';
        const reason = data.reason ? ` — ${data.reason}` : '';
        setError(`Ошибка HLS: ${data.type}${detail}${reason}`);
      });
      hls.loadSource(hlsPlaylistUrl(topicId, fileIndex, selectedAbs, sessionStart, resSel));
      hls.attachMedia(video);
      if (shouldAutoPlay) {
        video.play().catch(() => {});
      }
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsPlaylistUrl(topicId, fileIndex, selectedAbs, sessionStart, resSel);
      if (resumeReal != null && resumeReal > 0) {
        nativeRestore = () => {
          const v = videoRef.current;
          if (v) v.currentTime = resumeReal;
        };
        video.addEventListener('loadedmetadata', nativeRestore);
      }
    } else {
      setError('HLS не поддерживается этим браузером.');
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (nativeRestore) video.removeEventListener('loadedmetadata', nativeRestore);
    };
  }, [topicId, fileIndex, media, audioSel, resSel, sessionStart, directPlay, selectedAbs, retryNonce]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Завершает измерение задержки перемотки/фриза: игра началась/можно играть.
    const finishSeek = () => {
      setSeeking(false);
      if (seekStartRef.current != null) {
        api.perfRecord('player.seekLatency.ms', performance.now() - seekStartRef.current);
        seekStartRef.current = null;
      }
      if (stallStartRef.current != null) {
        api.perfRecord('player.stall.ms', performance.now() - stallStartRef.current);
        stallStartRef.current = null;
      }
    };

    const onPlaying = () => {
      setPlaying(true);
      setBuffering(false);
      finishSeek();
    };
    const onPause = () => setPlaying(false);
    const onTime = () => {
      setCurrentTime(video.currentTime);
      if (!video.paused) {
        setPlaying(true);
        setBuffering(false);
      }
    };
    const onMeta = () => {
      setBuffering(false);
      const d = video.duration;
      if (Number.isFinite(d) && d > 0) setVideoDuration(d);
    };
    const onCanPlay = () => finishSeek();
    const onWaiting = () => {
      setBuffering(true);
      if (stallStartRef.current == null) stallStartRef.current = performance.now();
    };
    const onVolume = () => {
      setMuted(video.muted);
      setVolume(video.volume);
    };
    const onErr = () => {
      api.clientLog({
        topicId,
        fileIndex,
        event: 'video:error',
        code: video.error?.code,
        message: video.error?.message,
        readyState: video.readyState,
        networkState: video.networkState,
        currentTime: video.currentTime,
      });
    };
    const onStalled = () => {
      api.clientLog({
        topicId,
        fileIndex,
        event: 'video:stalled',
        readyState: video.readyState,
        currentTime: video.currentTime,
      });
    };
    video.addEventListener('playing', onPlaying);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('durationchange', onMeta);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('volumechange', onVolume);
    video.addEventListener('error', onErr);
    video.addEventListener('stalled', onStalled);
    return () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('durationchange', onMeta);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('volumechange', onVolume);
      video.removeEventListener('error', onErr);
      video.removeEventListener('stalled', onStalled);
    };
  }, [topicId, fileIndex, media, loading]);

  useEffect(() => {
    if (subSel === 0 || !media) return;
    const real = sessionStart + currentTime;
    const desired = Math.max(0, Math.floor(real - SUB_LEAD));
    if (desired < subWindowStart || desired > subWindowStart + SUB_WINDOW - SUB_MARGIN) {
      setSubWindowStart(desired);
    }
  }, [currentTime, sessionStart, subSel, media, subWindowStart]);

  // Подтягиваем окно субтитров: сервер отдаёт WebVTT-окно (частичное, пока
  // кластеры окна не скачаны). Парсим куи и рендерим оверлеем.
  useEffect(() => {
    if (subSel === 0 || fileIndex == null || !media) {
      setSubCues([]);
      return;
    }
    const sel = media.subtitleTracks[subSel - 1];
    if (!sel || !sel.isText) {
      setSubCues([]);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let fetching = false;

    const fetchWindow = async () => {
      if (fetching) return;
      fetching = true;
      const url = subtitleUrl(topicId, fileIndex, sel.index, {
        window: subWindowStart,
        dur: SUB_WINDOW,
        shift: sessionStart,
        rev: Date.now(),
      });
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        const done = res.headers.get('X-Sub-Window-Done') === '1';
        const text = await res.text();
        if (cancelled) return;
        const parsed = parseWebVtt(text);
        if (parsed.length > 0) setSubCues(parsed);
        else if (done) setSubCues([]);
        if (done && timer !== undefined) {
          window.clearInterval(timer);
          timer = undefined;
        }
      } catch {
        /* преходящие сетевые ошибки игнорируем */
      } finally {
        fetching = false;
      }
    };

    void fetchWindow();
    timer = window.setInterval(fetchWindow, SUB_POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [topicId, fileIndex, media, subSel, subWindowStart, sessionStart]);

  useEffect(() => {
    statusOptsRef.current = {
      audio: selectedAbs,
      start: sessionStart,
      pos: sessionStart + currentTime,
      res: resSel,
    };
  });

  useEffect(() => {
    if (fileIndex == null) return;
    const ac = new AbortController();
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const o = statusOptsRef.current;
      api
        .streamStatus(topicId, fileIndex, o, ac.signal)
        .then((s) => {
          if (!alive) return;
          setStatus(s);
          setTranscodedSec(s.transcodedSec);
        })
        .catch(() => {});
    };
    tick();
    const iv = window.setInterval(tick, 1500);
    return () => {
      alive = false;
      ac.abort();
      window.clearInterval(iv);
    };
  }, [topicId, fileIndex]);

  // Периодическое сохранение прогресса просмотра (для «продолжить с последней
  // серии»). Пишем только когда файл реально проигрывается не с 0:00.
  useEffect(() => {
    if (fileIndex == null || media == null) return;
    const tick = () => {
      if (mediaFileRef.current !== fileIndex) return;
      const o = statusOptsRef.current;
      saveResume(fileIndex, o.pos);
    };
    tick();
    const iv = window.setInterval(tick, RESUME_SAVE_INTERVAL_MS);
    return () => window.clearInterval(iv);
  }, [fileIndex, media]);

  useEffect(() => {
    return () => {
      if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
      if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current);
      if (hlsRef.current) hlsRef.current.destroy();
      // Финальная фиксация прогресса активной серии и громкости при закрытии плеера.
      const fi = mediaFileRef.current;
      if (fi != null) {
        const o = statusOptsRef.current;
        saveResume(fi, o.pos, true);
      }
      persistVolume();
      api.streamStop(topicId).catch(() => {});
    };
  }, [topicId]);

  // Применяет сохранённые в истории настройки звука, как только <video> доступен.
  useEffect(() => {
    const video = videoRef.current;
    const p = pendingPrefsRef.current;
    if (!video || !p) return;
    pendingPrefsRef.current = null;
    const v = Math.min(1, Math.max(0, p.volume));
    video.muted = p.muted;
    video.volume = v;
    setMuted(p.muted);
    setVolume(v);
  });

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    const syncIos = () => setFullscreen(Boolean(iosVideo(videoRef.current)?.webkitDisplayingFullscreen));
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitbeginfullscreen', syncIos);
    document.addEventListener('webkitendfullscreen', syncIos);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitbeginfullscreen', syncIos);
      document.removeEventListener('webkitendfullscreen', syncIos);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Горячие клавиши не должны перехватываться, когда пользователь работает с
      // интерактивными элементами: кнопки, поля, меню плеера/страницы.
      if (target && target.closest) {
        if (
          target.closest(
            'button, a, input, textarea, select, [role="button"], [role="slider"], .player-menu, .player-settings, .player-ep-wrap, .dropdown, .sort-menu',
          )
        ) {
          return;
        }
      }
      const video = videoRef.current;
      if (!video) return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        video.paused ? video.play() : video.pause();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const delta = e.key === 'ArrowLeft' ? -5 : 5;
        const maxFrag = directPlay
          ? (duration || Infinity)
          : Math.max(0, (duration || 0) - sessionStart);
        video.currentTime = Math.max(0, Math.min(video.currentTime + delta, maxFrag));
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        setSubSize((s) => Math.min(60, s + 2));
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        setSubSize((s) => Math.max(10, s - 2));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [directPlay, duration, sessionStart]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
    }, 2500);
  }, []);

  useEffect(() => {
    if (playing) showControls();
  }, [playing, showControls]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    video.paused ? video.play() : video.pause();
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    persistVolume();
  };

  const setVolumeFromSlider = (v: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = v;
    video.muted = false;
  };

  const volumeFromClientX = (clientX: number): number => {
    const el = volumeRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const onVolumeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    volumeDragRef.current = true;
    setVolumeFromSlider(volumeFromClientX(e.clientX));
    (e.currentTarget as HTMLDivElement).setPointerCapture?.(e.pointerId);
  };
  const onVolumeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!volumeDragRef.current) return;
    setVolumeFromSlider(volumeFromClientX(e.clientX));
  };
  const onVolumeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!volumeDragRef.current) return;
    volumeDragRef.current = false;
    (e.currentTarget as HTMLDivElement).releasePointerCapture?.(e.pointerId);
    persistVolume();
  };

  const isControlTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return !!target.closest(
      'button, a, .player-seek, .player-menu, .player-ep-wrap, .player-volume, .player-top, .player-bottom, .player-settings',
    );
  };

  const onStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isControlTarget(e.target)) return;
    const now = Date.now();
    if (now - lastClickRef.current < 250) {
      lastClickRef.current = 0;
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      toggleFullscreen();
      return;
    }
    lastClickRef.current = now;
    if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      togglePlay();
    }, 250);
  };

  type IosVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
};

const iosVideo = (v: HTMLVideoElement | null): IosVideo | null => v as IosVideo | null;

const toggleFullscreen = () => {
    const video = iosVideo(videoRef.current);
    const iosFs = Boolean(video?.webkitDisplayingFullscreen);
    if (document.fullscreenElement || iosFs) {
      if (video?.webkitExitFullscreen) video.webkitExitFullscreen();
      else void document.exitFullscreen();
    } else if (video?.webkitEnterFullscreen) {
      // iOS Safari: fullscreen делаем на самом <video> через webkitEnterFullscreen.
      video.webkitEnterFullscreen();
    } else {
      void stageRef.current?.requestFullscreen?.();
    }
  };

  const selectAudio = (i: number) => {
    const video = videoRef.current;
    const t = media?.audioTracks[i];
    // Запоминаем выбранную озвучку (поток), субтитры не трогаем.
    avPrefsRef.current = { ...avPrefsRef.current, audioTrack: t?.index ?? null };
    persistTracks();
    if (!media || !video) {
      setAudioSel(i);
      return;
    }
    const newDefault =
      media.audioTracks.find((x) => x.default)?.index ?? media.audioTracks[0]?.index ?? null;
    const newDirect = media.canDirectPlay && (t?.index ?? null) === newDefault;
    const real = sessionStart + video.currentTime;
    autoPlayRef.current = !video.paused;
    resumeRealRef.current = real;
    setAudioSel(i);
    if (newDirect) {
      setSessionStart(0);
      setCurrentTime(real);
    } else {
      setSessionStart(roundStart(real));
      setCurrentTime(0);
    }
    setSubWindowStart(Math.max(0, real - SUB_LEAD));
    setPlaying(false);
    setBuffering(true);
    setTranscodedSec(null);
    if (!newDirect) {
      seekStartRef.current = performance.now();
      setSeeking(true);
    }
  };

  // Выбор субтитров: 0 = off; i > 0 — позиция дорожки в списке (trackList[i-1]).
  const selectSubtitle = (i: number) => {
    const tracks = media?.subtitleTracks ?? [];
    const stream = i > 0 ? (tracks[i - 1]?.index ?? null) : null;
    avPrefsRef.current = { ...avPrefsRef.current, subtitleTrack: stream };
    setSubSel(i);
    persistTracks();
  };

  // Смена потолка разрешения транскода: перезапускаем HLS-сессию с текущей позиции.
  const selectRes = (r: number | null) => {
    const video = videoRef.current;
    if (r === resSel) return;
    const real = sessionStart + (video?.currentTime ?? 0);
    autoPlayRef.current = !video?.paused;
    resumeRealRef.current = real;
    setResSel(r);
    setSessionStart(roundStart(real));
    setCurrentTime(0);
    setSubWindowStart(Math.max(0, real - SUB_LEAD));
    setPlaying(false);
    setBuffering(true);
    setTranscodedSec(null);
    seekStartRef.current = performance.now();
    setSeeking(true);
  };

  const seekTo = (target: number) => {
    const video = videoRef.current;
    if (!video) return;
    const T = Math.max(0, Math.min(target, duration || 0));
    if (directPlay) {
      video.currentTime = T;
      setCurrentTime(T);
      return;
    }
    const transcoded = transcodedSec ?? 0;
    if (T >= sessionStart && T <= sessionStart + transcoded) {
      video.currentTime = T - sessionStart;
      setCurrentTime(T - sessionStart);
    } else {
      const s0 = roundStart(T);
      autoPlayRef.current = !video.paused;
      setSessionStart(s0);
      setCurrentTime(0);
      setSubWindowStart(Math.max(0, s0 - SUB_LEAD));
      setPlaying(false);
      setBuffering(true);
      setTranscodedSec(null);
      seekStartRef.current = performance.now();
      setSeeking(true);
    }
  };

  const seekFromClientX = (clientX: number) => {
    const el = seekRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac;
  };

  const previewForFrac = (frac: number): { index: number; frac: number } | null => {
    if (!duration || duration <= 0) return null;
    const t = frac * duration;
    return { index: Math.floor(t / THUMB_INTERVAL_SEC), frac };
  };

  const onSeekDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const frac = seekFromClientX(e.clientX);
    dragRef.current = frac;
    setDraft(frac);
    setThumbPreview(previewForFrac(frac));
    (e.currentTarget as HTMLDivElement).setPointerCapture?.(e.pointerId);
  };
  const onSeekMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const frac = seekFromClientX(e.clientX);
    if (dragRef.current == null) {
      // hover без перетаскивания — просто превью
      setThumbPreview(previewForFrac(frac));
      return;
    }
    dragRef.current = frac;
    setDraft(frac);
    setThumbPreview(previewForFrac(frac));
  };
  const onSeekLeave = () => {
    if (dragRef.current == null) setThumbPreview(null);
  };
  const onSeekUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current == null) return;
    const frac = dragRef.current;
    dragRef.current = null;
    setDraft(null);
    setThumbPreview(null);
    if (duration > 0) seekTo(frac * duration);
    (e.currentTarget as HTMLDivElement).releasePointerCapture?.(e.pointerId);
  };

  if (error) {
    return (
      <div className="player-state">
        <p>{error}</p>
        <button
          className="btn"
          onClick={() => {
            setError(null);
            setRetryNonce((n) => n + 1);
          }}
        >
          Повторить
        </button>
      </div>
    );
  }

  if (loading || fileIndex == null) {
    return (
      <div className="player-state">
        <div className="spinner" />
        <span className="player-state-msg">Загрузка файлов раздачи…</span>
      </div>
    );
  }

  const selected = files?.find((f) => f.index === fileIndex) ?? null;
  const videos = (files ?? []).filter((f) => f.isVideo);
  const realTime = sessionStart + currentTime;
  const displayTime = draft != null ? draft * duration : Math.min(realTime, duration || Infinity);
  const playFrac = duration > 0 ? displayTime / duration : 0;
  const downFrac =
    status?.file && status.file.length > 0 ? status.file.downloaded / status.file.length : 0;
  const transcodeStart = duration > 0 ? Math.min(1, sessionStart / duration) : 0;
  const transcodeWidth =
    duration > 0 && transcodedSec != null ? Math.min(1, transcodedSec / duration) : 0;
  // Насколько транскод впереди плейхеда (сек) — для индикации «+MM:SS» в таймере.
  const aheadSec =
    !directPlay && transcodedSec != null ? Math.max(0, transcodedSec - currentTime) : null;
  const overlayShow =
    controlsVisible || !playing || menuOpen || settingsOpen || audioMenuOpen || subMenuOpen;

  const selectedSub = subSel > 0 ? media?.subtitleTracks[subSel - 1] : null;
  const activeCue =
    selectedSub && selectedSub.isText
      ? subCues.find((c) => c.start <= currentTime && currentTime < c.end)
      : null;
  const subLines = activeCue ? activeCue.text.split('\n') : null;

  return (
    <div className="player">
      <div className="player-stage" ref={stageRef} onClick={onStageClick} onMouseMove={showControls}>
        <video ref={videoRef} className="player-video" playsInline />
        {subLines && (
          <div className="player-subtitle" style={{ fontSize: `${subSize}px` }}>
            {subLines.map((line, i) => (
              <span className="player-subtitle-line" key={i}>
                {line}
                {i < subLines.length - 1 && <br />}
              </span>
            ))}
          </div>
        )}

        {buffering && (
          <div className="player-buffering">
            <div className="spinner" />
            <div className="player-buffering-text">
              {seeking ? 'Перемотка…' : 'Буферизация…'}
            </div>
          </div>
        )}

        {!playing && !loading && !buffering && (
          <button className="player-big-play" onClick={togglePlay} aria-label="Играть">
            <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        )}

        <div className={`player-overlay ${overlayShow ? 'show' : ''}`}>
          <div className="player-top">
            {selected && (
              <div className="player-title" title={selected.name}>
                {selected.name}
              </div>
            )}
            <div className={`player-top-menu ${videos.length > 1 ? 'player-top-menu-spread' : ''}`}>
              {videos.length > 1 && (
                <div className="player-ep-wrap">
                  <button
                    className="player-ep-btn"
                    onClick={() => {
                      setMenuOpen((v) => !v);
                      setAudioMenuOpen(false);
                      setSubMenuOpen(false);
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M5 3l14 9-14 9z" strokeLinejoin="round" />
                    </svg>
                    <span className="player-ep-text">
                      {selected ? episodeLabel(selected.name) : 'Серии'}
                    </span>
                    <span className="player-ep-text-mobile">Серия</span>
                  </button>
                  {menuOpen && (
                    <div className="player-menu player-menu-episodes">
                      {videos.map((f) => (
                        <button
                          key={f.index}
                          className={`player-menu-item ${f.index === fileIndex ? 'active' : ''}`}
                          onClick={() => {
                            setFileIndex(f.index);
                            setMenuOpen(false);
                          }}
                        >
                          {episodeLabel(f.name)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="player-ep-wrap">
                <button
                  className="player-ep-btn"
                  onClick={() => {
                    setAudioMenuOpen((v) => !v);
                    setMenuOpen(false);
                    setSubMenuOpen(false);
                  }}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 5 6 9H3v6h3l5 4z" strokeLinejoin="round" />
                    <path d="M15.5 9.5a4 4 0 0 1 0 5" strokeLinecap="round" />
                  </svg>
                  Озвучка
                </button>
                {audioMenuOpen && (
                  <div className="player-menu">
                    {media?.audioTracks && media.audioTracks.length > 0 ? (
                      media.audioTracks.map((t, i) => (
                        <button
                          key={t.index}
                          className={`player-menu-item ${audioSel === i ? 'active' : ''}`}
                          onClick={() => {
                            selectAudio(i);
                            setAudioMenuOpen(false);
                          }}
                        >
                          {trackLabel(t, i, 'audio')}
                        </button>
                      ))
                    ) : (
                      <div className="player-menu-empty">Нет данных</div>
                    )}
                  </div>
                )}
              </div>

              <div className="player-ep-wrap">
                <button
                  className="player-ep-btn"
                  onClick={() => {
                    setSubMenuOpen((v) => !v);
                    setMenuOpen(false);
                    setAudioMenuOpen(false);
                  }}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 5h18v14H3z" strokeLinejoin="round" />
                    <path d="M7 10h4M7 14h6M13 14h4" strokeLinecap="round" />
                  </svg>
                  Субтитры
                </button>
                {subMenuOpen && (
                  <div className="player-menu">
                    <button
                      className={`player-menu-item ${subSel === 0 ? 'active' : ''}`}
                      onClick={() => {
                        selectSubtitle(0);
                        setSubMenuOpen(false);
                      }}
                    >
                      Выключены
                    </button>
                    {(media?.subtitleTracks ?? []).length === 0 && (
                      <div className="player-menu-empty">Нет субтитров</div>
                    )}
                    {(media?.subtitleTracks ?? []).map((t, i) => (
                      <button
                        key={t.index}
                        className={`player-menu-item ${subSel === i + 1 ? 'active' : ''}`}
                        onClick={() => {
                          selectSubtitle(i + 1);
                          setSubMenuOpen(false);
                        }}
                        disabled={!t.isText}
                        title={t.isText ? undefined : 'Не поддерживается'}
                      >
                        {t.isText
                          ? trackLabel(t, i, 'sub')
                          : `${trackLabel(t, i, 'sub')} · не поддерживается`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="player-bottom">
            <button className="player-ctl" onClick={togglePlay} aria-label={playing ? 'Пауза' : 'Играть'}>
              {playing ? (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                  <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            <div className="player-time">
              {formatTime(displayTime)}
              {!directPlay && (
                <span className="player-time-ahead">
                  {' +'}
                  {formatTime(draft != null ? 0 : aheadSec ?? 0)}
                </span>
              )}
              {' / '}
              {formatTime(duration)}
            </div>

            <div
              className="player-seek"
              ref={seekRef}
              onPointerDown={onSeekDown}
              onPointerMove={onSeekMove}
              onPointerUp={onSeekUp}
              onPointerLeave={onSeekLeave}
            >
              {thumbPreview && fileIndex != null && (
                <div
                  className="player-seek-preview"
                  style={{ left: `${thumbPreview.frac * 100}%` }}
                >
                  <img
                    src={thumbnailUrl(topicId, fileIndex, thumbPreview.index)}
                    alt=""
                    style={{ visibility: thumbVisible ? 'visible' : 'hidden' }}
                    onLoad={() => setThumbVisible(true)}
                    onError={() => setThumbVisible(false)}
                  />
                  <div className="player-seek-preview-time">
                    {formatTime(thumbPreview.index * THUMB_INTERVAL_SEC)}
                  </div>
                </div>
              )}
              <div className="player-seek-track">
                <div
                  className="player-seek-download"
                  style={{ width: `${downFrac * 100}%` }}
                />
                <div
                  className="player-seek-transcode"
                  style={{ left: `${transcodeStart * 100}%`, width: `${transcodeWidth * 100}%` }}
                />
                <div className="player-seek-play" style={{ width: `${playFrac * 100}%` }} />
              </div>
              <div className="player-seek-thumb" style={{ left: `${playFrac * 100}%` }} />
            </div>

            <div className="player-volume">
              <button className="player-ctl" onClick={toggleMute} aria-label="Звук">
                {muted || volume === 0 ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 5 6 9H3v6h3l5 4z" strokeLinejoin="round" />
                    <path d="M16 9l6 6M22 9l-6 6" strokeLinecap="round" />
                  </svg>
                ) : volume < 0.5 ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 5 6 9H3v6h3l5 4z" strokeLinejoin="round" />
                    <path d="M15.5 9.5a4 4 0 0 1 0 5" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 5 6 9H3v6h3l5 4z" strokeLinejoin="round" />
                    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" strokeLinecap="round" />
                  </svg>
                )}
              </button>
              <div
                ref={volumeRef}
                className="player-volume-slider"
                style={{ ['--vol' as string]: `${(muted ? 0 : volume) * 100}%` }}
                onPointerDown={onVolumeDown}
                onPointerMove={onVolumeMove}
                onPointerUp={onVolumeUp}
                aria-label="Громкость"
                role="slider"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round((muted ? 0 : volume) * 100)}
              >
                <div className="player-volume-fill" />
                <div className="player-volume-thumb" />
              </div>
            </div>

            <div className="player-settings-wrap">
              <button
                className="player-ctl"
                onClick={() => {
                  setSettingsOpen((v) => !v);
                  setMenuOpen(false);
                  setAudioMenuOpen(false);
                  setSubMenuOpen(false);
                }}
                aria-label="Настройки"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
              {settingsOpen && (
                <div className="player-settings">
                  {!directPlay && (
                    <div className="player-settings-group">
                      <div className="player-settings-title">Качество</div>
                      {(() => {
                        const opts = RES_OPTIONS.filter(
                          (r) => r <= fullResFor(media?.height),
                        );
                        return opts.length > 0 ? (
                          opts.map((r) => (
                            <button
                              key={r}
                              className={`player-menu-item ${resSel === r ? 'active' : ''}`}
                              onClick={() => selectRes(r)}
                            >
                              {resLabel(r)}
                            </button>
                          ))
                        ) : (
                          <div className="player-menu-empty">Исходное разрешение</div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
            </div>

            <button className="player-ctl" onClick={toggleFullscreen} aria-label="Во весь экран">
              {fullscreen ? (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" strokeLinecap="round" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
