import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { AlertTriangle, CheckCircle2, Download, Play, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, convertUrl, formatBytes, formatTime, streamUrl, type MediaInfo, type MediaType, type PlayInfo, type SavedSource, type TorrentStatus, type Verdict } from '../api';
import { audioLabel, canDecodeVideo, choosePlayMode, convertAudioCodec, preferredAudioIndex, supportsAudioTracks, type PlayMode } from '../playback';
import { useProfile } from '../profile';
import { useBackHandler } from '../back';
import { FocusGroup, Focusable } from './Focusable';
import { Button, Spinner } from './ui';
import { VerdictCard } from './VerdictCard';

const JUMPS = [0.1, 0.4, 0.7];

function qualityLabel(w: number): string {
  // By width: widescreen films are often 1920×800, so height alone undersells them.
  if (w >= 3200) return '4K';
  if (w >= 1800) return '1080p';
  if (w >= 1200) return '720p';
  return 'SD';
}

/**
 * Plays a few spots of a release so you can judge picture quality and check it actually
 * plays on this device, without downloading the whole file.
 */
export function PreviewModal({
  source,
  release,
  mediaType,
  tmdbId,
  season,
  episode,
  onClose,
  onWatch,
  onDownload,
}: {
  source: SavedSource;
  /** Search-result facts passed to the deep check. */
  release?: { size?: number; seeders?: number; indexer?: string };
  mediaType?: MediaType;
  tmdbId?: number;
  season?: number;
  episode?: number;
  onClose: () => void;
  onWatch: (s: SavedSource) => void;
  onDownload?: (s: SavedSource) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [info, setInfo] = useState<(PlayInfo & { fileSize: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [res, setRes] = useState<{ w: number; h: number } | null>(null);
  const [noAudio, setNoAudio] = useState(false);
  const [buffering, setBuffering] = useState(true);
  // Sound on by default; if the browser blocks autoplay with sound, fall back to muted (the button shows it).
  const [muted, setMuted] = useState(false);
  const [jump, setJump] = useState(0);
  const [status, setStatus] = useState<TorrentStatus | null>(null);
  const [duration, setDuration] = useState(0);
  const watching = useRef(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  // Direct play, or the server's ffmpeg conversion when this device can't decode the file.
  const [mode, setMode] = useState<PlayMode | null>(null);
  const [convertStart, setConvertStart] = useState(0);
  const media = useRef<MediaInfo | null>(null);
  const canConvert = useRef(false);
  const { profile } = useProfile();
  const [audioTracks, setAudioTracks] = useState<MediaInfo['audio']>([]);
  const [audioIdx, setAudioIdx] = useState(0);

  /** Converted previews restart at each spot (from the keyframe just before it). */
  const convertAt = (t: number, m: Extract<PlayMode, { kind: 'convert' }>) => {
    if (!info) return;
    setBuffering(true);
    setConvertStart(t);
    setMode(m);
  };

  // Check the file's real codecs before playing it.
  useEffect(() => {
    if (!info) return;
    let live = true;
    setMode(null);
    const fallback = window.setTimeout(() => live && setMode((m) => m || { kind: 'direct' }), 25000);
    api
      .media(info.infoHash, info.fileIdx, true)
      .then((r) => {
        if (!live) return;
        media.current = r.info;
        canConvert.current = r.canConvert;
        // Preview in the profile's language, like the player.
        const aIdx = preferredAudioIndex(r.info, profile?.languages || ['en'], null);
        setAudioTracks(r.info?.audio || []);
        setAudioIdx(aIdx);
        const m = choosePlayMode(r.info, r.canConvert, aIdx);
        if (m.kind === 'convert') {
          if (r.info?.durationSec) setDuration(r.info.durationSec);
          convertAt((r.info?.durationSec || 0) * JUMPS[0], m);
        } else setMode((cur) => cur || m);
      })
      .catch(() => live && setMode((m) => m || { kind: 'direct' }));
    return () => {
      live = false;
      window.clearTimeout(fallback);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  useEffect(() => {
    let live = true;
    api
      .preview({ source, season, episode, mediaType, tmdbId })
      .then((r) => live && setInfo(r))
      .catch((e: ApiError) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [source, season, episode, mediaType, tmdbId]);

  // Once the torrent is open, run the deep check (runtime, file list, AI) alongside the preview.
  useEffect(() => {
    if (!info || !mediaType || tmdbId == null) return;
    let live = true;
    setChecking(true);
    api
      .verify({ source: { ...source, infoHash: info.infoHash }, mediaType, tmdbId, season, episode, release })
      .then((v) => live && setVerdict(v))
      .catch((e: ApiError) => live && setCheckError(e.message))
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
    // run once per opened torrent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.infoHash]);

  // Drop the preview from the cache unless it turned into a real watch.
  useEffect(() => {
    return () => {
      if (info && !watching.current) api.discardPreview(info.infoHash).catch(() => {});
    };
  }, [info]);

  useEffect(() => {
    const t = setTimeout(() => setFocus(info || error ? 'preview-watch' : 'preview-close'), 50);
    return () => clearTimeout(t);
  }, [info, error]);

  // Show swarm stats while waiting for data.
  useEffect(() => {
    if (!buffering && info) return;
    const hash = info?.infoHash || source.infoHash;
    if (!hash) return;
    const tick = () =>
      api
        .torrentStatus(hash, info?.fileIdx)
        .then(setStatus)
        .catch(() => {});
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [buffering, info, source.infoHash]);

  // Chrome-family browsers report decoded audio bytes; zero after a few seconds of playback
  // means the audio codec (often DTS/TrueHD) isn't supported here.
  useEffect(() => {
    if (buffering || !res) return;
    const t = setTimeout(() => {
      const v = video.current as (HTMLVideoElement & { webkitAudioDecodedByteCount?: number }) | null;
      if (v && typeof v.webkitAudioDecodedByteCount === 'number' && v.webkitAudioDecodedByteCount === 0 && !v.paused) setNoAudio(true);
    }, 5000);
    return () => clearTimeout(t);
  }, [buffering, res, jump]);

  useBackHandler(() => {
    onClose();
    return true;
  });

  /** Plays with sound when allowed; if the browser refuses autoplay with sound, plays muted instead. */
  const playSafely = (v: HTMLVideoElement) => {
    v.play().catch((e: DOMException) => {
      if (e?.name !== 'NotAllowedError' || v.muted) return;
      v.muted = true;
      setMuted(true);
      v.play().catch(() => {});
    });
  };

  const seekTo = (i: number) => {
    const v = video.current;
    setJump(i);
    if (mode?.kind === 'convert') {
      convertAt((media.current?.durationSec || duration) * JUMPS[i], mode);
      return;
    }
    if (v && v.duration) {
      v.currentTime = v.duration * JUMPS[i];
      playSafely(v);
    }
  };

  /** Direct play where the browser can switch tracks itself (Safari, some TVs). */
  const enableNativeTrack = (i: number) => {
    const tracks = (video.current as (HTMLVideoElement & { audioTracks?: { length: number; [n: number]: { enabled: boolean } } }) | null)?.audioTracks;
    if (!tracks || tracks.length < 2) return false;
    for (let n = 0; n < tracks.length; n++) tracks[n].enabled = n === i;
    return true;
  };

  /** Hear another audio track of this source. */
  const chooseAudio = (i: number) => {
    if (i === audioIdx) return;
    setAudioIdx(i);
    if (mode?.kind === 'direct' && supportsAudioTracks && enableNativeTrack(i)) return;
    const next = choosePlayMode(media.current, canConvert.current, i);
    const at = (media.current?.durationSec || duration) * JUMPS[jump];
    if (next.kind === 'direct') {
      setMode(next);
      return;
    }
    convertAt(at, mode?.kind === 'convert' && mode.video === 'h264' ? { ...next, video: 'h264' } : next);
  };

  const onMeta = () => {
    const v = video.current!;
    if (mode?.kind !== 'convert') enableNativeTrack(audioIdx);
    if (mode?.kind === 'convert') {
      // Converted streams already start at the chosen spot; re-encoded video may be scaled, so report the file's size.
      const m = media.current;
      setRes(mode.video === 'h264' && m?.width ? { w: m.width, h: m.height } : { w: v.videoWidth, h: v.videoHeight });
      if (m?.durationSec) setDuration(m.durationSec);
      playSafely(v);
      return;
    }
    setRes({ w: v.videoWidth, h: v.videoHeight });
    setDuration(v.duration);
    if (!v.videoWidth) setPlayError('This file has no video this device can decode.');
    v.currentTime = v.duration * JUMPS[0];
    playSafely(v);
  };

  const onVideoError = () => {
    const code = video.current?.error?.code;
    // Can't decode it here: try the server's conversion before giving up.
    if (canConvert.current && mode?.kind !== 'convert') {
      const m = media.current;
      convertAt((m?.durationSec || duration) * JUMPS[jump], { kind: 'convert', video: m && !canDecodeVideo(m.videoCodec) ? 'h264' : 'copy', reason: 'Converting this file for this device' });
      return;
    }
    if (canConvert.current && mode?.kind === 'convert' && mode.video === 'copy') {
      convertAt((media.current?.durationSec || duration) * JUMPS[jump], { kind: 'convert', video: 'h264', reason: 'Converting video and audio for this device' });
      return;
    }
    setPlayError(
      code === 4
        ? 'This device can’t play this file’s format (usually HEVC/x265, AV1, or DTS audio in an MKV). Try a source marked “Plays well”.'
        : 'Playback failed while decoding this file. Try another source.',
    );
    setBuffering(false);
  };

  const watch = () => {
    watching.current = true;
    onWatch(info ? { ...source, infoHash: info.infoHash } : source);
  };

  const download = () => {
    watching.current = true; // keep the data already fetched
    onDownload?.(info ? { ...source, infoHash: info.infoHash } : source);
  };

  const quality = res && res.w ? qualityLabel(res.w) : null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Preview">
      <FocusGroup focusKey="preview" boundary className="modal preview">
        <div className="preview-head">
          <div className="preview-name">{info?.fileName || source.releaseTitle}</div>
          <Focusable focusKey="preview-close" className="btn btn-ghost btn-icon" title="Close" onSelect={onClose}>
            <X />
          </Focusable>
        </div>

        <div className="preview-stage">
          {error ? (
            <div className="preview-overlay">
              <AlertTriangle className="warn-icon" />
              <p>{error}</p>
            </div>
          ) : !info || !mode ? (
            <div className="preview-overlay">
              <Spinner label={info ? 'Checking the file format…' : status ? `Connecting… ${status.peers} peers` : 'Fetching torrent info from peers…'} />
            </div>
          ) : (
            <>
              <video
                ref={video}
                key={mode.kind === 'convert' ? `convert-${mode.video}-${convertStart}-${mode.audio ?? 0}` : 'direct'}
                src={
                  mode.kind === 'convert'
                    ? convertUrl(info, convertStart, mode.video, true, mode.audio ?? 0, convertAudioCodec(audioTracks[mode.audio ?? 0]))
                    : streamUrl(info, true)
                }
                muted={muted}
                playsInline
                preload="metadata"
                onLoadedMetadata={onMeta}
                onWaiting={() => setBuffering(true)}
                onSeeking={() => setBuffering(true)}
                onSeeked={() => video.current && video.current.readyState >= 3 && setBuffering(false)}
                onTimeUpdate={() => video.current && !video.current.paused && setBuffering(false)}
                onPlaying={() => setBuffering(false)}
                onCanPlay={() => setBuffering(false)}
                onError={onVideoError}
              />
              {playError ? (
                <div className="preview-overlay">
                  <AlertTriangle className="warn-icon" />
                  <p>{playError}</p>
                </div>
              ) : (
                buffering && (
                  <div className="preview-overlay preview-overlay-soft">
                    <Spinner label={status ? `Buffering… ${status.peers} peers · ${formatBytes(status.downloadSpeed)}/s` : 'Buffering…'} />
                  </div>
                )
              )}
            </>
          )}
        </div>

        <div className="preview-facts">
          {quality && (
            <span className="fact fact-strong">
              {quality} <span className="muted">({res!.w}×{res!.h})</span>
            </span>
          )}
          {info && <span className="fact">{formatBytes(info.fileSize)}</span>}
          {duration > 0 && <span className="fact">{formatTime(duration)}</span>}
          {info && info.subtitles.length > 0 && <span className="fact">{info.subtitles.length} subtitle file(s)</span>}
          {quality && !playError && !noAudio && (
            <span className="fact fact-good">
              <CheckCircle2 /> {mode?.kind === 'convert' ? (mode.video === 'copy' ? 'Plays here with converted audio' : 'Plays here, converted (uses more CPU)') : 'Plays on this device'}
            </span>
          )}
          {noAudio && (
            <span className="fact fact-warn">
              <AlertTriangle /> No audio decoded — the audio format may not be supported here
            </span>
          )}
        </div>

        {audioTracks.length > 1 && (
          <FocusGroup focusKey="preview-audio" className="preview-audio chips">
            <span className="muted small">Audio:</span>
            {audioTracks.map((a, i) => (
              <Focusable key={i} className={`chip${audioIdx === i ? ' is-active' : ''}`} disabled={!!playError} onSelect={() => chooseAudio(i)}>
                {audioLabel(a, i)}
              </Focusable>
            ))}
          </FocusGroup>
        )}

        {verdict ? (
          <VerdictCard v={verdict} />
        ) : checking ? (
          <p className="muted small verdict-checking">Checking this source — measuring runtime{' '}and asking the AI…</p>
        ) : checkError ? (
          <p className="muted small">Couldn’t check this source: {checkError}</p>
        ) : null}

        <div className="preview-controls">
          <FocusGroup focusKey="preview-jumps" className="actions actions-tight">
            {JUMPS.map((j, i) => (
              <Focusable key={j} className={`chip${jump === i ? ' is-active' : ''}`} disabled={!res || !!playError} onSelect={() => seekTo(i)}>
                {Math.round(j * 100)}%
              </Focusable>
            ))}
            <Focusable className="chip" disabled={!res || !!playError} title={muted ? 'Unmute' : 'Mute'} onSelect={() => setMuted((m) => !m)}>
              {muted ? <VolumeX /> : <Volume2 />}
            </Focusable>
          </FocusGroup>
          <div className="actions actions-tight">
            <Button onSelect={onClose}>Close</Button>
            {onDownload && (
              <Button icon={<Download />} disabled={!!error} onSelect={download}>
                Download
              </Button>
            )}
            <Button focusKey="preview-watch" variant="primary" icon={<Play />} disabled={!!error} onSelect={watch}>
              Watch this
            </Button>
          </div>
        </div>
        <p className="muted small">Preview only downloads the few seconds you watch. Closing discards it.</p>
      </FocusGroup>
    </div>
  );
}
