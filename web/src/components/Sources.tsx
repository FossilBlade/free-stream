import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { ChevronDown, ChevronRight, Clapperboard, Eye, RefreshCw, Sparkles, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, downloadMessage, formatBytes, OUTCOME_TONE, releaseSource, type DownloadRow, type MediaType, type Release, type SavedSource } from '../api';
import { screenHeight } from '../screen';
import { canPlayDolbyAudio } from '../tv';
import { FocusGroup, Focusable } from './Focusable';
import { PreviewModal } from './Preview';
import { toast } from './Toast';
import { Badge, Button, Message, Spinner } from './ui';

/** Audio this device can't decode (DTS/TrueHD anywhere, Dolby outside TVs and Safari) while the video itself is fine. */
function audioOnlyProblem(r: Release): boolean {
  const videoOk = r.info.codec !== 'AV1' && r.info.codec !== 'XviD' && r.info.source !== 'Remux';
  const dolby = (r.info.audio === 'AC3' || r.info.audio === 'EAC3') && !canPlayDolbyAudio;
  return videoOk && (dolby || r.info.audio === 'DTS' || r.info.audio === 'TrueHD');
}

/** How a source will play here: quietly fine, with converted audio, or probably not at all. */
function playNote(r: Release, canConvert: boolean): 'convert' | 'risky' | null {
  if (audioOnlyProblem(r)) return canConvert ? 'convert' : 'risky';
  return r.playability === 'risky' ? 'risky' : null;
}

export type PickMode = 'play' | 'download';

export interface SourcesProps {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year?: string;
  season?: number;
  episode?: number;
  /** What choosing a source does. */
  mode: PickMode;
  /** Shown under the heading, e.g. "Season 1 · Episode 3 · Pilot". */
  subtitle?: string;
  /** Open with the theater copies expanded (e.g. "Watch theater copy" on an in-theaters title). */
  theaterFocus?: boolean;
  busy?: boolean;
  /** Existing downloads of this movie/episode, to mark sources already on the Mac. */
  downloads?: DownloadRow[];
  onDownloaded?: () => void;
  onPlay: (source: SavedSource) => void;
}

type Filter = 'all' | '2160p' | '1080p' | '720p';

export function Sources({ mediaType, tmdbId, title, year, season, episode, mode, subtitle, theaterFocus, busy, downloads = [], onDownloaded, onPlay }: SourcesProps) {
  const navigate = useNavigate();
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [canConvert, setCanConvert] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [preview, setPreview] = useState<Release | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [showTheater, setShowTheater] = useState(!!theaterFocus);

  useEffect(() => {
    let live = true;
    setReleases(null);
    setError(null);
    api
      .sources({ type: mediaType, id: tmdbId, title, year, season, episode, screen: screenHeight(), dolby: canPlayDolbyAudio ? 1 : 0 })
      .then((r) => {
        if (!live) return;
        setReleases(r.releases);
        setCanConvert(!!r.canConvert);
      })
      .catch((e: ApiError) => live && setError(e));
    return () => {
      live = false;
    };
  }, [mediaType, title, year, season, episode, attempt]);

  // Once results arrive, put the remote on the best source (or on "Search again" if there's nothing to pick).
  useEffect(() => {
    if (!releases && !error) return;
    const t = setTimeout(() => setFocus(releases && releases.length ? 'sources-list' : 'sources-retry'), 60);
    return () => clearTimeout(t);
  }, [releases, error]);

  const downloadedBy = useMemo(() => {
    const m = new Map<string, DownloadRow>();
    for (const d of downloads) if (d.complete || d.downloading) m.set(d.infoHash, d);
    return m;
  }, [downloads]);

  const shown = useMemo(() => (releases || []).filter((r) => filter === 'all' || r.info.resolution === filter), [releases, filter]);
  // The best pick goes first; the rest keep the server's order.
  const full = shown.filter((r) => r.tier === 'full').sort((a, b) => Number(!!b.best) - Number(!!a.best));
  const theater = shown.filter((r) => r.tier === 'theater');
  const theaterOpen = showTheater || !full.length;

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of releases || []) if (r.info.resolution) c[r.info.resolution] = (c[r.info.resolution] || 0) + 1;
    return c;
  }, [releases]);

  const download = async (source: SavedSource) => {
    try {
      const r = await api.download({ mediaType, tmdbId, season, episode, source });
      toast(downloadMessage(r));
      onDownloaded?.();
    } catch (e) {
      toast((e as ApiError).message, 'error');
    }
  };

  const choose = (r: Release) => (mode === 'download' ? download(releaseSource(r)) : onPlay(releaseSource(r)));

  const renderRow = (r: Release) => {
    const dl = r.infoHash ? downloadedBy.get(r.infoHash) : undefined;
    return (
      <div className={`release${r.best ? ' is-best' : ''}`} key={(r.infoHash || '') + r.title}>
        <Focusable className="release-main" disabled={busy} onSelect={() => choose(r)}>
          <div className="release-title">{r.title}</div>
          <div className="release-badges">
            {r.best && (
              <Badge tone="good">
                <Sparkles className="inline-icon" /> Best pick
              </Badge>
            )}
            {dl && <Badge tone="good">{dl.complete ? '✓ On this Mac' : `Downloading ${Math.floor(dl.progress * 100)}%`}</Badge>}
            {r.info.resolution && <Badge tone="accent">{r.info.resolution === '2160p' ? '4K' : r.info.resolution}</Badge>}
            {r.tier === 'theater' && <Badge tone="ok">{r.info.theater === 'screener' ? 'Screener' : 'Theater recording'}</Badge>}
            {r.info.multiAudio ? <Badge>Dual audio</Badge> : r.info.languages.slice(0, 2).map((l) => <Badge key={l}>{l}</Badge>)}
            {r.info.pack && <Badge>Full season</Badge>}
            {playNote(r, canConvert) === 'risky' && <Badge tone="risky">May not play here</Badge>}
            {playNote(r, canConvert) === 'convert' && <Badge>Audio converted here</Badge>}
            {r.sizeFlag === 'small' && <Badge tone="risky">Small for {r.info.resolution === '2160p' ? '4K' : r.info.resolution} — low quality?</Badge>}
            {r.sizeFlag === 'large' && <Badge>Very large — slower to stream</Badge>}
            <span className="release-stats">
              <span>{formatBytes(r.size)}</span>
              <span className="seeds">
                <Users /> {r.seeders}
              </span>
            </span>
          </div>
          {r.best && r.pickReason && <div className="release-pick">{r.pickReason}</div>}
          {r.verdict && !r.best && (
            <div className={`release-verdict tone-${OUTCOME_TONE[r.verdict.outcome]}`}>
              {r.verdict.outcome === 'verified' ? '✓ ' : ''}
              {r.verdict.label}
              {r.verdict.summary ? ` — ${r.verdict.summary}` : ''}
            </div>
          )}
        </Focusable>
        <Focusable className="btn btn-secondary release-preview" disabled={busy} title="Preview and check this source" onSelect={() => setPreview(r)}>
          <Eye />
          <span>Preview</span>
        </Focusable>
      </div>
    );
  };

  const retry = (
    <Button focusKey="sources-retry" icon={<RefreshCw />} onSelect={() => setAttempt((a) => a + 1)}>
      Search again
    </Button>
  );

  return (
    <section className="sources">
      <div className="sources-head">
        <h2>{mode === 'download' ? 'Choose a source to download' : 'Choose a source to watch'}</h2>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>

      {error ? (
        error.status === 412 ? (
          <Message
            title="Source search isn’t set up"
            action={
              <Button focusKey="sources-retry" variant="primary" onSelect={() => navigate('/settings')}>
                Open Settings
              </Button>
            }
          />
        ) : (
          <Message title="Couldn’t search right now" action={retry} />
        )
      ) : !releases ? (
        <Spinner label="Searching…" />
      ) : !releases.length ? (
        <Message title="No sources found" action={retry} />
      ) : (
        <>
          <FocusGroup focusKey="sources-filters" className="chips">
            {(['all', '2160p', '1080p', '720p'] as Filter[])
              .filter((f) => f === 'all' || counts[f])
              .map((f) => (
                <Focusable key={f} className={`chip${filter === f ? ' is-active' : ''}`} onSelect={() => setFilter(f)}>
                  {f === 'all' ? 'All' : f === '2160p' ? '4K' : f}
                </Focusable>
              ))}
          </FocusGroup>
          <FocusGroup focusKey="sources-list" className="release-list">
            {full.map((r) => renderRow(r))}
            {theater.length > 0 && (
              <>
                <Focusable className="chip theater-toggle" onSelect={() => setShowTheater((v) => !v)}>
                  {theaterOpen ? <ChevronDown /> : <ChevronRight />} <Clapperboard /> Theater copies ({theater.length})
                </Focusable>
                {theaterOpen && (
                  <>
                    <p className="muted small theater-note">Recorded in a cinema or leaked screeners — lower picture and sound quality. Shown because the film may not be out digitally yet.</p>
                    {theater.map((r) => renderRow(r))}
                  </>
                )}
              </>
            )}
          </FocusGroup>
        </>
      )}

      {preview && (
        <PreviewModal
          source={releaseSource(preview)}
          release={{ size: preview.size, seeders: preview.seeders, indexer: preview.indexer }}
          mediaType={mediaType}
          tmdbId={tmdbId}
          season={season}
          episode={episode}
          onClose={() => {
            setPreview(null);
            setTimeout(() => setFocus('sources-list'), 50);
          }}
          onDownload={(src) => {
            setPreview(null);
            download(src);
          }}
          onWatch={(src) => {
            setPreview(null);
            onPlay(src);
          }}
        />
      )}
    </section>
  );
}

/** Text input that works with the TV remote: OK starts typing, Down/Back stops. */
export function TextField({
  value,
  onChange,
  onSubmit,
  placeholder,
  autoFocus,
  focusKey,
  type = 'text',
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  focusKey?: string;
  type?: string;
}) {
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  useEffect(() => {
    if (autoFocus && input && !/web0s|webos/i.test(navigator.userAgent)) input.focus();
  }, [autoFocus, input]);
  return (
    <Focusable focusKey={focusKey} className="field" onSelect={() => input?.focus()}>
      <input
        ref={setInput}
        type={type}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Keep arrow keys inside the text box while typing; Enter submits, Down/Esc leaves.
          e.stopPropagation();
          if (e.keyCode === 13) {
            onSubmit?.();
            input?.blur();
          } else if (e.keyCode === 40 || e.keyCode === 27 || e.keyCode === 461) {
            input?.blur();
          }
        }}
      />
    </Focusable>
  );
}
