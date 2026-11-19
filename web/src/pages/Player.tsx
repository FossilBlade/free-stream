import { pause as pauseNav, resume as resumeNav } from '@noriginmedia/norigin-spatial-navigation';
import { AlertTriangle, ArrowLeft, Captions, Maximize, Pause, Play, RotateCcw, RotateCw, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, formatBytes, formatTime, streamUrl, subtitleUrl, type Details, type Episode, type MediaType, type PlayInfo, type TorrentStatus } from '../api';
import { runBackHandlers } from '../back';
import { Spinner } from '../components/ui';
import { isBackKey, isTV, KEY } from '../tv';

const SEEK_STEP = 10;
const HIDE_AFTER_MS = 4000;
const SAVE_EVERY_MS = 10000;
const UP_NEXT_SECONDS = 30;

type Zone = 'timeline' | 'buttons' | 'subs';
type ButtonId = 'play' | 'back10' | 'fwd10' | 'subs' | 'next' | 'mute' | 'fullscreen';

export function Player() {
  const { type: typeParam, id: idParam } = useParams();
  const type = (typeParam === 'tv' ? 'tv' : 'movie') as MediaType;
  const id = Number(idParam);
  const [params] = useSearchParams();
  const season = params.get('season') ? Number(params.get('season')) : undefined;
  const episode = params.get('episode') ? Number(params.get('episode')) : undefined;
  const location = useLocation();
  const navigate = useNavigate();

  const video = useRef<HTMLVideoElement>(null);
  const [info, setInfo] = useState<PlayInfo | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const [fatal, setFatal] = useState<{ message: string; canChangeSource: boolean } | null>(null);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [muted, setMuted] = useState(false);
  const [subIdx, setSubIdx] = useState<number | null>(null);
  const [status, setStatus] = useState<TorrentStatus | null>(null);

  const [visible, setVisible] = useState(true);
  const [zone, setZone] = useState<Zone>('timeline');
  const [btn, setBtn] = useState<ButtonId>('play');
  const [subCursor, setSubCursor] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const stallTimer = useRef<number | undefined>(undefined);
  const lastTime = useRef(-1);

  /**
   * Show "Buffering" only for real stalls: wait half a second before showing it, and hide it as soon as
   * playback is moving. (Some TV browsers don't fire canplay/playing after a seek, which left the card stuck.)
   */
  const setStall = useCallback((on: boolean) => {
    window.clearTimeout(stallTimer.current);
    if (on) stallTimer.current = window.setTimeout(() => setWaiting(true), 500);
    else setWaiting(false);
  }, []);
  useEffect(() => () => window.clearTimeout(stallTimer.current), []);

  // ---- load the stream (from the title page's state, or by asking the server) -------------------
  useEffect(() => {
    const fromState = (location.state as { play?: PlayInfo } | null)?.play;
    setInfo(null);
    setFatal(null);
    setTime(0);
    setDuration(0);
    setCountdown(null);
    setWaiting(true);
    if (fromState) {
      setInfo(fromState);
      return;
    }
    let live = true;
    api
      .play({ mediaType: type, tmdbId: id, season, episode })
      .then((p) => live && setInfo(p))
      .catch((e: ApiError) => {
        if (!live) return;
        if (e.status === 409 || e.status === 422) {
          navigate(`/title/${type}/${id}?pick=1${season != null ? `&season=${season}&episode=${episode}` : ''}`, { replace: true });
        } else setFatal({ message: e.message, canChangeSource: true });
      });
    return () => {
      live = false;
    };
    // location.key changes when "next episode" replaces the route
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  useEffect(() => {
    api
      .title(type, id)
      .then((r) => setDetails(r.details))
      .catch(() => {});
  }, [type, id]);

  useEffect(() => {
    if (type !== 'tv' || season == null) return;
    api
      .season(id, season)
      .then((r) => setEpisodes(r.episodes))
      .catch(() => {});
  }, [type, id, season]);

  // Default to the first English subtitle only when the file came with subtitles and the user hasn't chosen.
  useEffect(() => {
    setSubIdx(null);
  }, [info]);

  const currentEpisode = episodes?.find((e) => e.number === episode);
  const nextEpisode = (() => {
    if (type !== 'tv' || season == null || episode == null || !details) return null;
    if (episodes && episodes.some((e) => e.number === episode + 1)) return { season, episode: episode + 1 };
    if (episodes && details.seasons.some((s) => s.number === season + 1)) return { season: season + 1, episode: 1 };
    return null;
  })();

  // ---- progress saving ----------------------------------------------------------------------------
  const saveState = useRef({ info, details, season, episode, episodeTitle: currentEpisode?.name });
  saveState.current = { info, details, season, episode, episodeTitle: currentEpisode?.name };

  const saveProgress = useCallback(
    (beacon = false) => {
      const v = video.current;
      const s = saveState.current;
      if (!v || !s.info || !v.duration || !isFinite(v.duration) || v.currentTime < 5) return;
      const body = {
        mediaType: type,
        tmdbId: id,
        season: s.season,
        episode: s.episode,
        episodeTitle: s.episodeTitle,
        title: s.details?.title || '',
        posterPath: s.details?.posterPath ?? null,
        backdropPath: s.details?.backdropPath ?? null,
        position: v.currentTime,
        duration: v.duration,
        infoHash: s.info.infoHash,
        fileIdx: s.info.fileIdx,
      };
      if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/progress', new Blob([JSON.stringify(body)], { type: 'application/json' }));
      else api.saveProgress(body).catch(() => {});
    },
    [type, id],
  );

  useEffect(() => {
    const t = setInterval(() => {
      if (video.current && !video.current.paused) saveProgress();
    }, SAVE_EVERY_MS);
    const onHide = () => saveProgress(true);
    window.addEventListener('pagehide', onHide);
    return () => {
      clearInterval(t);
      window.removeEventListener('pagehide', onHide);
      saveProgress();
    };
  }, [saveProgress, info]);

  // ---- torrent stats while buffering ---------------------------------------------------------------
  useEffect(() => {
    if (!info || (!waiting && !visible)) return;
    const tick = () =>
      api
        .torrentStatus(info.infoHash, info.fileIdx)
        .then(setStatus)
        .catch(() => {});
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, [info, waiting, visible]);

  // ---- controls visibility ------------------------------------------------------------------------
  const poke = useCallback(() => {
    setVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      const v = video.current;
      if (v && !v.paused) {
        setVisible(false);
        setZone((z) => (z === 'subs' ? z : 'timeline'));
      }
    }, HIDE_AFTER_MS);
  }, []);

  useEffect(() => {
    poke();
    return () => window.clearTimeout(hideTimer.current);
  }, [poke]);

  useEffect(() => {
    if (!playing) setVisible(true);
    else poke();
  }, [playing, poke]);

  // ---- actions ------------------------------------------------------------------------------------
  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const seekBy = useCallback((d: number) => {
    const v = video.current;
    if (!v || !v.duration) return;
    v.currentTime = Math.max(0, Math.min(v.duration - 1, v.currentTime + d));
    setTime(v.currentTime);
  }, []);

  const exit = useCallback(() => {
    saveProgress();
    const idx = (window.history.state as { idx?: number } | null)?.idx;
    if (idx && idx > 0) navigate(-1);
    else navigate(`/title/${type}/${id}`, { replace: true });
  }, [navigate, saveProgress, type, id]);

  const goNext = useCallback(() => {
    if (!nextEpisode) return;
    saveProgress();
    setCountdown(null);
    navigate(`/watch/tv/${id}?season=${nextEpisode.season}&episode=${nextEpisode.episode}`, { replace: true, state: null });
  }, [nextEpisode, navigate, id, saveProgress]);

  const changeSource = useCallback(async () => {
    await api.forgetSource(type, id, season).catch(() => {});
    navigate(`/title/${type}/${id}?pick=1${season != null ? `&season=${season}&episode=${episode}` : ''}`, { replace: true });
  }, [navigate, type, id, season, episode]);

  const toggleFullscreen = useCallback(() => {
    const d = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.());
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else el.webkitRequestFullscreen?.();
  }, []);

  const subtitles = info?.subtitles || [];
  const buttons: ButtonId[] = ['play', 'back10', 'fwd10', ...(subtitles.length ? (['subs'] as ButtonId[]) : []), ...(nextEpisode ? (['next'] as ButtonId[]) : []), ...(isTV ? [] : (['mute', 'fullscreen'] as ButtonId[]))];

  const activate = useCallback(
    (b: ButtonId) => {
      if (b === 'play') togglePlay();
      else if (b === 'back10') seekBy(-SEEK_STEP);
      else if (b === 'fwd10') seekBy(SEEK_STEP);
      else if (b === 'subs') {
        setZone('subs');
        setSubCursor(subIdx == null ? 0 : subtitles.findIndex((s) => s.idx === subIdx) + 1);
      } else if (b === 'next') goNext();
      else if (b === 'mute') setMuted((m) => !m);
      else if (b === 'fullscreen') toggleFullscreen();
    },
    [togglePlay, seekBy, goNext, toggleFullscreen, subIdx, subtitles],
  );

  // ---- up next prompt ---------------------------------------------------------------------------------
  const remaining = duration - time;
  const showUpNext = !!nextEpisode && duration > 0 && remaining < UP_NEXT_SECONDS && remaining > 0;

  // ---- remote / keyboard ---------------------------------------------------------------------------
  useEffect(() => {
    pauseNav(); // the player handles keys itself
    return () => resumeNav();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.keyCode;
      if (isBackKey(e)) {
        e.preventDefault();
        if (zone === 'subs') setZone('buttons');
        else if (!runBackHandlers()) exit();
        return;
      }
      if (k === KEY.PLAY) return video.current?.play().catch(() => {}), poke();
      if (k === KEY.PAUSE) return video.current?.pause(), poke();
      if (k === KEY.PLAY_PAUSE || (k === KEY.SPACE && zone !== 'subs')) return e.preventDefault(), togglePlay(), poke();
      if (k === KEY.STOP) return exit();
      if (k === KEY.FAST_FWD) return seekBy(30), poke();
      if (k === KEY.REWIND) return seekBy(-30), poke();
      if (![KEY.LEFT, KEY.RIGHT, KEY.UP, KEY.DOWN, KEY.ENTER].includes(k as never)) return;
      e.preventDefault();

      const wasHidden = !visible;
      poke();

      if (fatal) return;

      // While "Next episode" is offered, OK takes it (unless the user is in the button bar).
      if ((countdown != null || showUpNext) && k === KEY.ENTER && zone === 'timeline') return goNext();

      if (zone === 'subs') {
        const n = subtitles.length + 1; // + "Off"
        if (k === KEY.UP) setSubCursor((c) => (c - 1 + n) % n);
        else if (k === KEY.DOWN) setSubCursor((c) => (c + 1) % n);
        else if (k === KEY.ENTER) {
          setSubIdx(subCursor === 0 ? null : subtitles[subCursor - 1].idx);
          setZone('buttons');
        } else if (k === KEY.LEFT || k === KEY.RIGHT) setZone('buttons');
        return;
      }

      if (zone === 'timeline') {
        if (k === KEY.LEFT) seekBy(-SEEK_STEP);
        else if (k === KEY.RIGHT) seekBy(SEEK_STEP);
        else if (k === KEY.ENTER) togglePlay();
        else if (k === KEY.DOWN && !wasHidden) {
          setZone('buttons');
          setBtn('play');
        }
        return;
      }

      // zone === 'buttons'
      const i = Math.max(0, buttons.indexOf(btn));
      if (k === KEY.LEFT) setBtn(buttons[Math.max(0, i - 1)]);
      else if (k === KEY.RIGHT) setBtn(buttons[Math.min(buttons.length - 1, i + 1)]);
      else if (k === KEY.UP) setZone('timeline');
      else if (k === KEY.ENTER) activate(btn);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zone, btn, buttons, visible, fatal, countdown, showUpNext, subtitles, subCursor, poke, togglePlay, seekBy, exit, goNext, activate]);

  // Lift subtitles above the control bar while it's showing.
  useEffect(() => {
    const tt = video.current?.textTracks[0];
    if (!tt || !tt.cues) return;
    for (let i = 0; i < tt.cues.length; i++) {
      const c = tt.cues[i] as VTTCue;
      c.line = visible ? -5 : 'auto';
    }
  }, [visible, subIdx, time]);

  // ---- up next ---------------------------------------------------------------------------------------

  useEffect(() => {
    if (countdown == null) return;
    if (countdown <= 0) {
      goNext();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c == null ? c : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, goNext]);

  // ---- video events ------------------------------------------------------------------------------------
  const onLoadedMetadata = () => {
    const v = video.current!;
    setDuration(v.duration);
    if (info?.resumeAt && info.resumeAt < v.duration - 10) v.currentTime = info.resumeAt;
    v.play().catch(() => setPlaying(false));
  };

  const onTimeUpdate = () => {
    const v = video.current!;
    if (!v.paused && v.currentTime !== lastTime.current && lastTime.current >= 0) setStall(false);
    lastTime.current = v.currentTime;
    setTime(v.currentTime);
    const b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= v.currentTime + 0.5 && b.end(i) >= v.currentTime) {
        setBufferedEnd(b.end(i));
        break;
      }
    }
  };

  const onVideoError = () => {
    const code = video.current?.error?.code;
    setFatal({
      message:
        code === 4
          ? 'This device can’t play this file’s format. It’s usually HEVC/x265, AV1, or DTS audio inside an MKV. Choose another source — ones marked “Plays well” are the safest.'
          : 'Playback stopped because the file couldn’t be decoded. Try another source.',
      canChangeSource: true,
    });
  };

  // ---- render ------------------------------------------------------------------------------------
  const title = details?.title || (location.state as { title?: string } | null)?.title || '';
  const subtitleLine = type === 'tv' && season != null ? `S${season}:E${episode}${currentEpisode ? ` · ${currentEpisode.name}` : ''}` : '';
  const pct = duration ? (time / duration) * 100 : 0;
  const bufPct = duration ? (bufferedEnd / duration) * 100 : 0;

  const ctl = (id: ButtonId, icon: ReactNode, label: string, extra?: ReactNode) => (
    <button
      key={id}
      className={`pbtn${zone === 'buttons' && btn === id ? ' is-focused' : ''}${id === 'subs' && subIdx != null ? ' is-on' : ''}`}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        setBtn(id);
        activate(id);
        poke();
      }}
      onMouseEnter={() => {
        setZone('buttons');
        setBtn(id);
      }}
    >
      {icon}
      {extra}
    </button>
  );

  return (
    <div className={`player${visible ? '' : ' is-idle'}`} onMouseMove={poke}>
      {info && (
        <video
          ref={video}
          key={`${info.infoHash}-${info.fileIdx}`}
          src={streamUrl(info)}
          autoPlay
          playsInline
          muted={muted}
          onClick={() => {
            togglePlay();
            poke();
          }}
          onDoubleClick={toggleFullscreen}
          onLoadedMetadata={onLoadedMetadata}
          onDurationChange={() => setDuration(video.current!.duration)}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => {
            setPlaying(false);
            saveProgress();
          }}
          onWaiting={() => setStall(true)}
          onSeeking={() => setStall(true)}
          onSeeked={() => video.current && video.current.readyState >= 3 && setStall(false)}
          onPlaying={() => setStall(false)}
          onCanPlay={() => setStall(false)}
          onEnded={() => {
            saveProgress();
            if (nextEpisode) setCountdown(10);
            else exit();
          }}
          onError={onVideoError}
        >
          {subIdx != null && (
            <track
              key={subIdx}
              kind="subtitles"
              src={subtitleUrl(info.infoHash, subIdx)}
              srcLang="en"
              label={subtitles.find((s) => s.idx === subIdx)?.label}
              default
              onLoad={(e) => {
                const tt = (e.target as HTMLTrackElement).track;
                if (tt) tt.mode = 'showing';
              }}
            />
          )}
        </video>
      )}

      {(!info || waiting) && !fatal && (
        <div className="player-center">
          <Spinner
            label={
              !info
                ? 'Finding peers and fetching the file list…'
                : status
                  ? `Buffering · ${status.peers} peer${status.peers === 1 ? '' : 's'} · ${formatBytes(status.downloadSpeed)}/s`
                  : 'Buffering…'
            }
          />
        </div>
      )}

      {fatal && (
        <div className="player-center player-error">
          <AlertTriangle className="warn-icon" />
          <h2>Can’t play this</h2>
          <p>{fatal.message}</p>
          <div className="actions">
            {fatal.canChangeSource && (
              <button className="btn btn-primary" onClick={changeSource} autoFocus>
                Choose another source
              </button>
            )}
            <button className="btn btn-secondary" onClick={exit}>
              Back
            </button>
          </div>
          {isTV && <p className="muted small">Press OK to choose another source, or Back to leave.</p>}
          <FatalKeys onOk={changeSource} enabled={!!fatal} />
        </div>
      )}

      <div className="player-top">
        <button className="pbtn" aria-label="Back" onClick={exit}>
          <ArrowLeft />
        </button>
        <div>
          <div className="player-title">{title}</div>
          {subtitleLine && <div className="player-sub">{subtitleLine}</div>}
        </div>
      </div>

      {(showUpNext || countdown != null) && nextEpisode && (
        <button className="up-next" onClick={goNext}>
          <SkipForward />
          <span>
            {countdown != null ? `Next episode in ${countdown}s` : 'Next episode'}
            <small>
              S{nextEpisode.season}:E{nextEpisode.episode} · press OK
            </small>
          </span>
        </button>
      )}

      <div className="player-bottom" onClick={(e) => e.stopPropagation()}>
        <div
          className={`timeline${zone === 'timeline' ? ' is-focused' : ''}`}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const v = video.current;
            if (v && duration) v.currentTime = ((e.clientX - r.left) / r.width) * duration;
          }}
          onMouseEnter={() => setZone('timeline')}
        >
          <div className="timeline-buffer" style={{ width: `${bufPct}%` }} />
          <div className="timeline-fill" style={{ width: `${pct}%` }} />
          <div className="timeline-knob" style={{ left: `${pct}%` }} />
        </div>
        <div className="player-row">
          <div className="player-buttons">
            {ctl('play', playing ? <Pause /> : <Play />, playing ? 'Pause' : 'Play')}
            {ctl('back10', <RotateCcw />, 'Back 10 seconds', <span className="pbtn-num">10</span>)}
            {ctl('fwd10', <RotateCw />, 'Forward 10 seconds', <span className="pbtn-num">10</span>)}
            {subtitles.length > 0 && ctl('subs', <Captions />, 'Subtitles')}
            {nextEpisode && ctl('next', <SkipForward />, 'Next episode')}
            {!isTV && ctl('mute', muted ? <VolumeX /> : <Volume2 />, muted ? 'Unmute' : 'Mute')}
            {!isTV && ctl('fullscreen', <Maximize />, 'Full screen')}
          </div>
          <div className="player-time">
            {formatTime(time)} / {formatTime(duration)}
            {status && status.progress < 1 && <span className="muted"> · {Math.round(status.progress * 100)}% downloaded</span>}
          </div>
        </div>
        {isTV && visible && <div className="player-hint muted small">◀ ▶ seek · OK play/pause · ▼ more controls</div>}
      </div>

      {zone === 'subs' && (
        <div className="subs-menu" onClick={(e) => e.stopPropagation()}>
          <h3>Subtitles</h3>
          {[{ idx: -1, label: 'Off' }, ...subtitles].map((s, i) => (
            <button
              key={s.idx}
              className={`subs-item${subCursor === i ? ' is-focused' : ''}${(s.idx === -1 ? subIdx == null : subIdx === s.idx) ? ' is-on' : ''}`}
              onMouseEnter={() => setSubCursor(i)}
              onClick={() => {
                setSubIdx(s.idx === -1 ? null : s.idx);
                setZone('buttons');
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** On the error screen, OK on the remote picks another source. */
function FatalKeys({ onOk, enabled }: { onOk: () => void; enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => e.keyCode === KEY.ENTER && onOk();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onOk, enabled]);
  return null;
}
