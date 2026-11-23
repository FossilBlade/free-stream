import { pause as pauseNav, resume as resumeNav } from '@noriginmedia/norigin-spatial-navigation';
import { AlertTriangle, ArrowLeft, AudioLines, Captions, Layers, Maximize, Pause, Play, RotateCcw, RotateCw, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, convertUrl, formatBytes, formatTime, streamUrl, subtitleUrl, type Details, type Episode, type MediaInfo, type MediaType, type PlayInfo, type Release, type TorrentStatus } from '../api';
import { autoCandidates, shortLabel, sourceOf } from '../autoPick';
import { runBackHandlers } from '../back';
import { Spinner } from '../components/ui';
import {
  audioLabel,
  canDecodeVideo,
  choosePlayMode,
  convertAudioCodec,
  defaultAudioIndex,
  preferredAudioIndex,
  rememberAudio,
  rememberedAudio,
  supportsAudioTracks,
  type PlayMode,
} from '../playback';
import { useProfile } from '../profile';
import { isBackKey, isTV, KEY } from '../tv';

const SEEK_STEP = 10;
const HIDE_AFTER_MS = 4000;
const SAVE_EVERY_MS = 10000;
const UP_NEXT_SECONDS = 30;

type Zone = 'timeline' | 'buttons' | 'subs' | 'audio';
type ButtonId = 'play' | 'back10' | 'fwd10' | 'subs' | 'audio' | 'next' | 'source' | 'mute' | 'fullscreen';

/** A source picked automatically that hasn't started: give up on it with no peers after this long, */
const NO_PEERS_MS = 30000;
/** or when it's still barely moving after this long. */
const TOO_SLOW_MS = 90000;
const TOO_SLOW_BPS = 250_000;
/** Opening an automatically picked source (finding peers, reading the file list) gets this long. */
const OPEN_MS = 40000;

export function Player() {
  const { type: typeParam, id: idParam } = useParams();
  const type = (typeParam === 'tv' ? 'tv' : 'movie') as MediaType;
  const id = Number(idParam);
  const [params] = useSearchParams();
  const season = params.get('season') ? Number(params.get('season')) : undefined;
  const episode = params.get('episode') ? Number(params.get('episode')) : undefined;
  const location = useLocation();
  const navigate = useNavigate();
  const { profile, isKid } = useProfile();

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
  /** Nothing chosen yet: the sources Play is trying by itself, best first, and which one is on. */
  const autoRef = useRef<{ list: Release[]; i: number } | null>(null);
  /** What the automatic pick is doing, shown while nothing plays yet. */
  const [pickNote, setPickNote] = useState<string | null>(null);
  /** Bumped on every new load, so a slow answer for an earlier one is ignored. */
  const loadGen = useRef(0);
  /** Bumped on every automatic attempt, so a source that answers after we moved on is ignored. */
  const attemptRef = useRef(0);
  /** The current source has started playing. */
  const startedRef = useRef(false);
  const statusRef = useRef<TorrentStatus | null>(null);
  statusRef.current = status;

  const [visible, setVisible] = useState(true);
  const [zone, setZone] = useState<Zone>('timeline');
  const [btn, setBtn] = useState<ButtonId>('play');
  const [subCursor, setSubCursor] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  // Direct play, or ffmpeg conversion on the server (decided from the file's real codecs).
  const [mode, setMode] = useState<PlayMode | null>(null);
  /** Where the current conversion was asked to start (the stream itself begins at the keyframe before it). */
  const [convertStart, setConvertStart] = useState(0);
  /**
   * Converted streams carry the file's own timestamps, so the video clock is the position in the file.
   * Only a browser that restarts the clock at 0 gets the requested start added back here.
   */
  const [clockBase, setClockBase] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  /** Audio tracks in the file, and the one playing (chosen from the profile's languages). */
  const [audioTracks, setAudioTracks] = useState<MediaInfo['audio']>([]);
  const [audioIdx, setAudioIdx] = useState(0);
  const [audioCursor, setAudioCursor] = useState(0);
  const modeRef = useRef<PlayMode | null>(null);
  const clockBaseRef = useRef(0);
  /** The video clock where the converted stream begins (browsers report everything before it as buffered). */
  const streamStart = useRef(0);
  /** Whether this converted stream's clock has been checked (Chrome reports 0 until the first frame plays). */
  const clockKnown = useRef(false);
  const mediaDurRef = useRef(0);
  const mediaRef = useRef<MediaInfo | null>(null);
  const canConvertRef = useRef(false);
  const timeRef = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  /** Where direct play should start after switching back from a converted stream (else the resume point). */
  const directStartAt = useRef<number | null>(null);
  const seekTimer = useRef<number | undefined>(undefined);
  modeRef.current = mode;
  clockBaseRef.current = clockBase;
  mediaDurRef.current = mediaDuration;
  const converting = mode?.kind === 'convert';
  const infoRef = useRef<PlayInfo | null>(null);
  infoRef.current = info;

  /** Start (or restart) the conversion at `t` seconds into the file. */
  const convertFrom = useCallback((t: number, m: Extract<PlayMode, { kind: 'convert' }>) => {
    if (!infoRef.current) return;
    clockKnown.current = false;
    timeRef.current = t;
    setTime(t);
    setConvertStart(t);
    setMode(m);
  }, []);
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

  /** Clears everything about the current stream before another one starts. */
  const resetStream = () => {
    setInfo(null);
    setFatal(null);
    setStatus(null);
    setTime(0);
    setDuration(0);
    setCountdown(null);
    setWaiting(true);
    setMode(null);
    setConvertStart(0);
    setClockBase(0);
    setMediaDuration(0);
    setAudioTracks([]);
    setAudioIdx(0);
    mediaRef.current = null;
    pendingSeek.current = null;
    startedRef.current = false;
  };

  /** Moves on to the next automatically picked source; after the last one, hands over the full list. */
  const tryNext = async (gen: number, why?: string) => {
    const a = autoRef.current;
    if (!a || gen !== loadGen.current) return;
    a.i += 1;
    const r = a.list[a.i];
    if (!r) {
      autoRef.current = null;
      setPickNote(null);
      // Don't come back to the last one that failed next time.
      api.forgetSource(type, id, season, episode).catch(() => {});
      setFatal({ message: `${why ? `${why} ` : ''}None of the top ${a.list.length} sources would play here. Choose one from the full list.`, canChangeSource: true });
      return;
    }
    const attempt = ++attemptRef.current;
    const current = () => gen === loadGen.current && attempt === attemptRef.current;
    resetStream();
    setPickNote(why ? `${why} Trying the next best (${a.i + 1} of ${a.list.length}) · ${shortLabel(r)}` : `Starting the best source · ${shortLabel(r)}`);
    const tooLong = window.setTimeout(() => current() && tryNext(gen, 'That source didn’t respond.'), OPEN_MS);
    try {
      const p = await api.play({ mediaType: type, tmdbId: id, season, episode, source: sourceOf(r) });
      if (current()) setInfo(p);
    } catch {
      if (current()) tryNext(gen, 'That source wouldn’t open.');
    } finally {
      window.clearTimeout(tooLong);
    }
  };

  /** No source chosen yet: search, rank for this device, and start the best one. */
  const startAuto = async (gen: number) => {
    setPickNote('Finding the best source…');
    try {
      const d = (await api.title(type, id)).details;
      const list = await autoCandidates(type, id, d.title, d.year, season, episode);
      if (gen !== loadGen.current) return;
      if (!list.length) {
        setPickNote(null);
        return setFatal({ message: 'Couldn’t find a source that should play well here. Choose one from the full list.', canChangeSource: true });
      }
      autoRef.current = { list, i: -1 };
      tryNext(gen);
    } catch (e) {
      if (gen !== loadGen.current) return;
      setPickNote(null);
      setFatal({ message: (e as ApiError).message, canChangeSource: true });
    }
  };

  // ---- load the stream (from the title page's state, or by asking the server) -------------------
  useEffect(() => {
    const fromState = (location.state as { play?: PlayInfo } | null)?.play;
    const gen = ++loadGen.current;
    autoRef.current = null;
    setPickNote(null);
    resetStream();
    if (fromState) {
      setInfo(fromState);
      return;
    }
    api
      .play({ mediaType: type, tmdbId: id, season, episode })
      .then((p) => gen === loadGen.current && setInfo(p))
      .catch((e: ApiError) => {
        if (gen !== loadGen.current) return;
        if (e.status === 409 || e.status === 422) {
          // Nothing chosen for this yet (or the season pack lacks it): pick the best source automatically.
          if (!isKid) return void startAuto(gen);
          navigate(`/title/${type}/${id}?pick=1${season != null ? `&season=${season}&episode=${episode}` : ''}`, { replace: true });
        } else setFatal({ message: e.message, canChangeSource: true });
      });
    // location.key changes when "next episode" replaces the route
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  // Picked automatically but not starting (nobody sharing it, or far too slow): move on by itself.
  useEffect(() => {
    if (!info || !autoRef.current) return;
    const gen = loadGen.current;
    const t0 = Date.now();
    const timer = window.setInterval(() => {
      if (startedRef.current || gen !== loadGen.current) return window.clearInterval(timer);
      const st = statusRef.current?.infoHash === info.infoHash ? statusRef.current : null;
      const age = Date.now() - t0;
      if (age > NO_PEERS_MS && !st?.peers) {
        window.clearInterval(timer);
        tryNext(gen, 'Nobody is sharing that source right now.');
      } else if (age > TOO_SLOW_MS && (st?.downloadSpeed || 0) < TOO_SLOW_BPS) {
        window.clearInterval(timer);
        tryNext(gen, 'That source is too slow to start.');
      }
    }, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

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

  // Check the file's real codecs: play directly if this device can, otherwise convert on the server.
  useEffect(() => {
    if (!info) return;
    let live = true;
    // Don't keep people waiting on a slow probe: after 25s just try playing directly.
    const fallback = window.setTimeout(() => live && !modeRef.current && setMode({ kind: 'direct' }), 25000);
    api
      .media(info.infoHash, info.fileIdx)
      .then((r) => {
        if (!live) return;
        canConvertRef.current = r.canConvert;
        mediaRef.current = r.info;
        if (r.info?.durationSec) setMediaDuration(r.info.durationSec);
        // Play the profile's language (or the one chosen earlier for this show), not just the file's default.
        const aIdx = preferredAudioIndex(r.info, profile?.languages || ['en'], rememberedAudio(type, id));
        setAudioTracks(r.info?.audio || []);
        setAudioIdx(aIdx);
        const m = choosePlayMode(r.info, r.canConvert, aIdx);
        const cur = modeRef.current;
        if (!cur) {
          if (m.kind !== 'convert') return setMode(m);
          const resume = info.resumeAt && (!r.info?.durationSec || info.resumeAt < r.info.durationSec - 10) ? info.resumeAt : 0;
          convertFrom(resume, m);
        } else if (cur.kind === 'direct' && m.kind === 'convert') {
          // Started directly after the timeout, but it can't play here: switch, keeping the place.
          convertFrom(timeRef.current, m);
        }
      })
      .catch(() => live && !modeRef.current && setMode({ kind: 'direct' }));
    return () => {
      live = false;
      window.clearTimeout(fallback);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, convertFrom]);
  useEffect(() => () => window.clearTimeout(seekTimer.current), []);

  /** Position in the file. */
  const absTime = useCallback(() => {
    if (modeRef.current?.kind !== 'convert') return video.current?.currentTime || 0;
    return clockKnown.current ? (video.current?.currentTime || 0) + clockBaseRef.current : timeRef.current;
  }, []);
  const totalDuration = useCallback(() => {
    const d = video.current?.duration;
    if (modeRef.current?.kind === 'convert') return mediaDurRef.current;
    return d && isFinite(d) ? d : mediaDurRef.current;
  }, []);
  useEffect(() => {
    if (converting && mediaDuration) setDuration(mediaDuration);
  }, [converting, mediaDuration]);

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
      const dur = totalDuration();
      const pos = pendingSeek.current ?? absTime();
      if (!v || !s.info || !dur || pos < 5 || pos > dur + 5) return;
      const body = {
        mediaType: type,
        tmdbId: id,
        season: s.season,
        episode: s.episode,
        episodeTitle: s.episodeTitle,
        title: s.details?.title || '',
        posterPath: s.details?.posterPath ?? null,
        backdropPath: s.details?.backdropPath ?? null,
        position: pos,
        duration: dur,
        infoHash: s.info.infoHash,
        fileIdx: s.info.fileIdx,
      };
      if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/progress', new Blob([JSON.stringify(body)], { type: 'application/json' }));
      else api.saveProgress(body).catch(() => {});
    },
    [type, id, absTime, totalDuration],
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

  /** Seek to a position in the file. Converted streams restart on the server unless it's already converted. */
  const seekTo = useCallback(
    (abs: number) => {
      const v = video.current;
      const dur = totalDuration();
      if (!v || !dur) return;
      const target = Math.max(0, Math.min(dur - 1, abs));
      setTime(target);
      timeRef.current = target;
      if (modeRef.current?.kind !== 'convert') {
        v.currentTime = target;
        return;
      }
      const rel = target - clockBaseRef.current;
      const b = v.buffered;
      for (let i = 0; i < b.length && rel >= streamStart.current; i++) {
        if (rel >= b.start(i) && rel <= b.end(i) - 1) {
          v.currentTime = rel;
          return;
        }
      }
      // Not converted yet: restart the conversion there (debounced so repeated presses restart once).
      pendingSeek.current = target;
      setStall(true);
      window.clearTimeout(seekTimer.current);
      seekTimer.current = window.setTimeout(() => {
        const m = modeRef.current;
        if (m?.kind !== 'convert') return;
        convertFrom(target, m);
        if (pendingSeek.current === target) pendingSeek.current = null;
      }, 600);
    },
    [totalDuration, setStall, convertFrom],
  );

  const seekBy = useCallback((d: number) => seekTo((pendingSeek.current ?? absTime()) + d), [seekTo, absTime]);

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

  /** Change source (player controls): the full list for this episode or movie; resumes where you are. */
  const pickAnother = useCallback(() => {
    saveProgress();
    navigate(`/title/${type}/${id}?pick=1${season != null ? `&season=${season}&episode=${episode}` : ''}`, { replace: true });
  }, [navigate, saveProgress, type, id, season, episode]);

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

  /** Direct play in browsers that can switch tracks themselves (Safari, some TVs). */
  const enableNativeTrack = (i: number) => {
    const tracks = (video.current as (HTMLVideoElement & { audioTracks?: { length: number; [n: number]: { enabled: boolean } } }) | null)?.audioTracks;
    if (!tracks || tracks.length < 2) return false;
    for (let n = 0; n < tracks.length; n++) tracks[n].enabled = n === i;
    return true;
  };

  /** Audio menu choice: switch in the player when it can, otherwise restart the conversion with that track. */
  const chooseAudio = (i: number) => {
    setZone('buttons');
    if (i === audioIdx) return;
    const track = audioTracks[i];
    if (track?.language && track.language !== 'und') rememberAudio(type, id, track.language);
    setAudioIdx(i);
    const m = modeRef.current;
    if (m?.kind === 'direct' && supportsAudioTracks && enableNativeTrack(i)) return;
    const media = mediaRef.current;
    const next = choosePlayMode(media, canConvertRef.current, i);
    if (next.kind === 'direct') {
      // Back to the file's own default track: play the original again, from the same place.
      directStartAt.current = absTime();
      setMode(next);
      return;
    }
    convertFrom(absTime(), m?.kind === 'convert' && m.video === 'h264' ? { ...next, video: 'h264' } : next);
  };

  const subtitles = info?.subtitles || [];
  const buttons: ButtonId[] = ['play', 'back10', 'fwd10', ...(subtitles.length ? (['subs'] as ButtonId[]) : []), ...(audioTracks.length > 1 ? (['audio'] as ButtonId[]) : []), ...(nextEpisode ? (['next'] as ButtonId[]) : []), ...(isKid ? [] : (['source'] as ButtonId[])), ...(isTV ? [] : (['mute', 'fullscreen'] as ButtonId[]))];

  const activate = useCallback(
    (b: ButtonId) => {
      if (b === 'play') togglePlay();
      else if (b === 'back10') seekBy(-SEEK_STEP);
      else if (b === 'fwd10') seekBy(SEEK_STEP);
      else if (b === 'subs') {
        setZone('subs');
        setSubCursor(subIdx == null ? 0 : subtitles.findIndex((s) => s.idx === subIdx) + 1);
      } else if (b === 'audio') {
        setZone('audio');
        setAudioCursor(audioIdx);
      } else if (b === 'next') goNext();
      else if (b === 'source') pickAnother();
      else if (b === 'mute') setMuted((m) => !m);
      else if (b === 'fullscreen') toggleFullscreen();
    },
    [togglePlay, seekBy, goNext, pickAnother, toggleFullscreen, subIdx, subtitles, audioIdx],
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
        if (zone === 'subs' || zone === 'audio') setZone('buttons');
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

      if (zone === 'audio') {
        const n = audioTracks.length;
        if (k === KEY.UP) setAudioCursor((c) => (c - 1 + n) % n);
        else if (k === KEY.DOWN) setAudioCursor((c) => (c + 1) % n);
        else if (k === KEY.ENTER) chooseAudio(audioCursor);
        else if (k === KEY.LEFT || k === KEY.RIGHT) setZone('buttons');
        return;
      }

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, btn, buttons, visible, fatal, countdown, showUpNext, subtitles, subCursor, audioTracks, audioCursor, poke, togglePlay, seekBy, exit, goNext, activate]);

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
    setDuration(totalDuration());
    // Converted streams start at the resume point (or seek target); their clock is checked once they play.
    if (converting) clockKnown.current = false;
    else {
      const startAt = directStartAt.current ?? info?.resumeAt ?? 0;
      directStartAt.current = null;
      if (startAt && startAt < v.duration - 10) v.currentTime = startAt;
      enableNativeTrack(audioIdx);
    }
    v.play().catch(() => setPlaying(false));
  };

  const onTimeUpdate = () => {
    const v = video.current!;
    if (!v.paused && v.currentTime !== lastTime.current && lastTime.current >= 0) setStall(false);
    lastTime.current = v.currentTime;
    if (converting && !clockKnown.current) {
      if (v.currentTime <= 0) return;
      // The stream carries the file's timestamps, starting at the keyframe just before the requested point.
      // A browser that restarts the clock at 0 instead shows far less than that: add the start back.
      const rebased = convertStart > 30 && v.currentTime < convertStart - 30;
      clockBaseRef.current = rebased ? convertStart : 0;
      setClockBase(clockBaseRef.current);
      streamStart.current = v.currentTime;
      clockKnown.current = true;
    }
    if (pendingSeek.current != null) return; // the bar shows the seek target until the restart
    const base = converting ? clockBaseRef.current : 0;
    timeRef.current = base + v.currentTime;
    setTime(base + v.currentTime);
    const b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= v.currentTime + 0.5 && b.end(i) >= v.currentTime) {
        setBufferedEnd(base + b.end(i));
        break;
      }
    }
  };

  const onVideoError = () => {
    const code = video.current?.error?.code;
    // Can't decode it here: convert on the server before giving up (audio first, then video too).
    if (canConvertRef.current) {
      const m = modeRef.current;
      const media = mediaRef.current;
      if (m?.kind !== 'convert') {
        convertFrom(timeRef.current, { kind: 'convert', video: media && !canDecodeVideo(media.videoCodec) ? 'h264' : 'copy', reason: 'Converting this file for this device' });
        return;
      }
      if (m.video === 'copy') {
        convertFrom(timeRef.current, { kind: 'convert', video: 'h264', reason: 'Converting video and audio for this device' });
        return;
      }
    }
    // Picked automatically: try the next best instead of stopping here.
    if (autoRef.current) {
      saveProgress();
      tryNext(loadGen.current, 'This device couldn’t play that source.');
      return;
    }
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
      {info && mode && (
        <video
          ref={video}
          key={`${info.infoHash}-${info.fileIdx}-${mode.kind}-${mode.kind === 'convert' ? `${mode.video}-${convertStart}-${mode.audio ?? 0}` : ''}`}
          src={
            mode.kind === 'convert'
              ? convertUrl(info, convertStart, mode.video, false, mode.audio ?? 0, convertAudioCodec(audioTracks[mode.audio ?? 0]))
              : streamUrl(info)
          }
          autoPlay
          playsInline
          muted={muted}
          onClick={() => {
            togglePlay();
            poke();
          }}
          onDoubleClick={toggleFullscreen}
          onLoadedMetadata={onLoadedMetadata}
          onDurationChange={() => setDuration(totalDuration())}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => {
            setPlaying(false);
            saveProgress();
          }}
          onWaiting={() => setStall(true)}
          onSeeking={() => setStall(true)}
          onSeeked={() => video.current && video.current.readyState >= 3 && setStall(false)}
          onPlaying={() => {
            startedRef.current = true;
            setStall(false);
          }}
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
              src={subtitleUrl(info.infoHash, subIdx, converting ? clockBase : 0)}
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

      {(!info || !mode || waiting) && !fatal && (
        <div className="player-center">
          <Spinner
            label={
              !info
                ? pickNote || 'Finding peers and fetching the file list…'
                : !mode
                  ? 'Checking the file format…'
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
          {mode?.kind === 'convert' && <div className="player-sub player-convert">{mode.reason}</div>}
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
            if (duration) seekTo(((e.clientX - r.left) / r.width) * duration);
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
            {audioTracks.length > 1 && ctl('audio', <AudioLines />, 'Audio')}
            {nextEpisode && ctl('next', <SkipForward />, 'Next episode')}
            {!isKid && ctl('source', <Layers />, 'Change source')}
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

      {zone === 'audio' && (
        <div className="subs-menu" onClick={(e) => e.stopPropagation()}>
          <h3>Audio</h3>
          {audioTracks.map((a, i) => (
            <button
              key={i}
              className={`subs-item${audioCursor === i ? ' is-focused' : ''}${audioIdx === i ? ' is-on' : ''}`}
              onMouseEnter={() => setAudioCursor(i)}
              onClick={() => chooseAudio(i)}
            >
              {audioLabel(a, i)}
              {i === defaultAudioIndex(mediaRef.current) && audioTracks.length > 1 ? <span className="muted small"> · file default</span> : null}
            </button>
          ))}
        </div>
      )}

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
