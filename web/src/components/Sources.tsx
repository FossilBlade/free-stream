import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { CheckCircle2, ChevronDown, ChevronRight, Clapperboard, Download, Eye, RefreshCw, Sparkles, Users } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
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

/** Covers this season: a pack of it, or a multi-season pack (e.g. "S01-S05") that includes it. */
function packCovers(r: Release, season: number | undefined): boolean {
  if (!r.info.pack) return false;
  if (season == null || r.info.season == null || r.info.season === season) return true;
  const range = r.title.match(/\bS(?:easons?)?\s?(\d{1,2})\s?-\s?S?(\d{1,2})\b/i);
  return !!range && Number(range[1]) <= season && season <= Number(range[2]);
}

/** play/download one movie or episode, or pack: a full-season source for several episodes at once. */
export type PickMode = 'play' | 'download' | 'pack';

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
  /** pack mode: a season pack was chosen. */
  onPack?: (source: SavedSource) => void;
  /** pack mode: the episode Preview opens (the search itself is for the whole season). */
  previewEpisode?: number;
  /** Shown under the heading / after the list (pack mode: options and the no-pack fallback). */
  extra?: ReactNode;
  footer?: ReactNode;
}

type Filter = 'all' | '2160p' | '1080p' | '720p';

export function Sources({ mediaType, tmdbId, title, year, season, episode, mode, subtitle, theaterFocus, busy, downloads = [], onDownloaded, onPlay, onPack, previewEpisode, extra, footer }: SourcesProps) {
  const packs = mode === 'pack';
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
  const anyShown = !!releases && (packs ? releases.some((r) => packCovers(r, season)) : releases.length > 0);
  useEffect(() => {
    if (!releases && !error) return;
    const t = setTimeout(() => setFocus(anyShown ? 'sources-list' : 'sources-retry'), 60);
    return () => clearTimeout(t);
  }, [releases, error, anyShown]);

  const downloadedBy = useMemo(() => {
    const m = new Map<string, DownloadRow>();
    for (const d of downloads) if (d.complete || d.downloading) m.set(d.infoHash, d);
    return m;
  }, [downloads]);

  const candidates = useMemo(() => (packs ? (releases || []).filter((r) => packCovers(r, season)) : releases || []), [releases, packs, season]);
  const shown = useMemo(() => candidates.filter((r) => filter === 'all' || r.info.resolution === filter), [candidates, filter]);
  // The best pick goes first; the rest keep the server's order.
  const full = shown.filter((r) => r.tier === 'full').sort((a, b) => Number(!!b.best) - Number(!!a.best));
  const theater = shown.filter((r) => r.tier === 'theater');
  const theaterOpen = showTheater || !full.length;

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of candidates) if (r.info.resolution) c[r.info.resolution] = (c[r.info.resolution] || 0) + 1;
    return c;
  }, [candidates]);

  const download = async (source: SavedSource) => {
    try {
      const r = await api.download({ mediaType, tmdbId, season, episode, source });
      toast(downloadMessage(r));
      onDownloaded?.();
    } catch (e) {
      toast((e as ApiError).message, 'error');
    }
  };

  const choose = (r: Release) => (packs ? onPack?.(releaseSource(r)) : mode === 'download' ? download(releaseSource(r)) : onPlay(releaseSource(r)));

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
            {dl && <Badge tone="good">{packs ? 'Already in use' : dl.complete ? '✓ On this Mac' : `Downloading ${Math.floor(dl.progress * 100)}%`}</Badge>}
            {r.info.resolution && <Badge tone="accent">{r.info.resolution === '2160p' ? '4K' : r.info.resolution}</Badge>}
            {r.tier === 'theater' && <Badge tone="ok">{r.info.theater === 'screener' ? 'Screener' : 'Theater recording'}</Badge>}
            {r.info.multiAudio ? <Badge title="Several audio languages: FreeStream plays your profile’s language and you can switch with Audio in the player. Preview lists the tracks.">Dual audio</Badge> : r.info.languages.slice(0, 2).map((l) => <Badge key={l}>{l}</Badge>)}
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
        {packs ? null : dl?.complete ? (
          <Focusable className="btn btn-secondary release-download is-done" disabled={busy} title="On this Mac — play it" onSelect={() => onPlay(releaseSource(r))}>
            <CheckCircle2 />
            <span>Downloaded</span>
          </Focusable>
        ) : dl?.downloading ? (
          <Focusable className="btn btn-secondary release-download is-progress" title="Downloading — open Downloads" onSelect={() => navigate('/downloads')}>
            {Math.floor(dl.progress * 100)}%
          </Focusable>
        ) : (
          <Focusable className="btn btn-secondary release-download" disabled={busy} title="Download this source to the Mac" onSelect={() => download(releaseSource(r))}>
            <Download />
            <span>Download</span>
          </Focusable>
        )}
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
        <h2>{packs ? 'Choose a full-season source' : mode === 'download' ? 'Choose a source to download' : 'Choose a source to watch'}</h2>
        {subtitle && <p className="muted">{subtitle}</p>}
        {extra}
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
      ) : !candidates.length ? (
        <Message title={packs ? 'No full-season sources found' : 'No sources found'} action={retry}>
          {packs ? 'FreeStream can find each episode on its own instead (below).' : undefined}
        </Message>
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
      {footer}

      {preview && (
        <PreviewModal
          source={releaseSource(preview)}
          release={{ size: preview.size, seeders: preview.seeders, indexer: preview.indexer }}
          mediaType={mediaType}
          tmdbId={tmdbId}
          season={season}
          episode={packs ? previewEpisode : episode}
          onClose={() => {
            setPreview(null);
            setTimeout(() => setFocus('sources-list'), 50);
          }}
          onDownload={(src) => {
            setPreview(null);
            if (packs) onPack?.(src);
            else download(src);
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
