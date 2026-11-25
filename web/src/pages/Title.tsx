import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { Bell, BellRing, CalendarClock, Check, CheckCircle2, CheckSquare, Clapperboard, Download, Layers, Link2, ListChecks, ListPlus, ListVideo, Play, Search, Sparkles, Square, Star, ThumbsDown, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, batchMessage, downloadMessage, formatRuntime, img, shortDate, todayIso, type Card, type Details, type DownloadRow, type Episode, type MediaType, type Progress, type SavedSource, type Verdict, type Watch } from '../api';
import { FocusGroup, Focusable } from '../components/Focusable';
import { MagnetModal } from '../components/MagnetModal';
import { Row, TitleCard } from '../components/Row';
import { SeasonDownload, type SeasonBatch } from '../components/SeasonDownload';
import { Sources, type PickMode } from '../components/Sources';
import { toast } from '../components/Toast';
import { VerdictCard } from '../components/VerdictCard';
import { Button, hideBroken, ProgressBar, Spinner } from '../components/ui';
import { SetupNeeded } from './Home';
import { useProfile } from '../profile';

interface Target {
  season?: number;
  episode?: number;
}

/** Watched far enough to count as seen (matches the server). */
const FINISHED = 0.92;
/** Out already (episodes without a date are announced but not scheduled yet). */
const isOut = (e: Episode) => !!e.airDate && e.airDate <= todayIso();
/** Out, and not on the Mac, downloading, or being found already. */
const needsDownload = (e: Episode) => isOut(e) && !e.download?.complete && !e.download?.downloading && !e.finding;

export function Title() {
  const { type: typeParam, id: idParam } = useParams();
  const type = (typeParam === 'tv' ? 'tv' : 'movie') as MediaType;
  const id = Number(idParam);
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const [details, setDetails] = useState<Details | null>(null);
  const [inList, setInList] = useState(false);
  const [lastWatched, setLastWatched] = useState<Progress | null>(null);
  const [movieSource, setMovieSource] = useState<SavedSource | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  const [season, setSeason] = useState<number | null>(null);
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  /** Downloads of this title (movie) or of the selected season (show). */
  const [downloads, setDownloads] = useState<DownloadRow[]>([]);
  /** The selected season's "download new episodes as they air" watch. */
  const [follow, setFollow] = useState<Watch | null>(null);
  /** Episode numbers ticked in Select mode (null when not selecting). */
  const [selecting, setSelecting] = useState<number[] | null>(null);
  /** Several episodes about to download: choosing a season pack for them. */
  const [batch, setBatch] = useState<SeasonBatch | null>(null);

  const [watch, setWatch] = useState<Watch | null>(null);
  const [upgrade, setUpgrade] = useState<Watch | null>(null);
  const [sourceVerdict, setSourceVerdict] = useState<Verdict | null>(null);
  const [showVerdict, setShowVerdict] = useState(false);
  const [ageRating, setAgeRating] = useState<number | null>(null);
  const [because, setBecause] = useState<string | null>(null);
  const [similar, setSimilar] = useState<Card[]>([]);
  const { isKid } = useProfile();

  /** The source list, open for a movie/episode, to either play or download. */
  const [picking, setPicking] = useState<(Target & { mode: PickMode; theater?: boolean }) | null>(null);
  const [showMagnet, setShowMagnet] = useState(false);
  const [busy, setBusy] = useState(false);
  const sourcesRef = useRef<HTMLDivElement>(null);
  const autoPlayed = useRef(false);

  useEffect(() => {
    setDetails(null);
    setPicking(null);
    api
      .title(type, id)
      .then((r) => {
        setDetails(r.details);
        setInList(r.inMyList);
        setLastWatched(r.lastWatched);
        setMovieSource(r.savedSource);
        setWatch(r.watch);
        setUpgrade(r.upgrade);
        setSourceVerdict(r.sourceVerdict);
        setAgeRating(r.ageRating);
        setBecause(r.suggestedBecause);
        if (type === 'movie') setDownloads(r.downloads);
        if (type === 'tv') setSeason(r.lastWatched?.season ?? r.details.seasons[0]?.number ?? 1);
      })
      .catch(setLoadError);
    setSimilar([]);
    api
      .similar(type, id)
      .then((r) => setSimilar(r.results))
      .catch(() => {});
  }, [type, id]);

  const notInterested = () => {
    api
      .notInterested(type, id)
      .then(() => {
        setBecause(null);
        toast('Got it — we won’t suggest this again.');
        setTimeout(() => setFocus('title-play'), 50);
      })
      .catch((e: ApiError) => toast(e.message, 'error'));
  };

  const loadSeason = useCallback(
    (n: number, quiet = false) => {
      if (!quiet) setEpisodes(null);
      return api
        .season(id, n)
        .then((r) => {
          setEpisodes(r.episodes);
          setDownloads(r.downloads);
          setFollow(r.follow);
        })
        .catch(() => !quiet && setEpisodes([]));
    },
    [id],
  );

  useEffect(() => {
    setSelecting(null);
    setBatch(null);
    if (type === 'tv' && season != null) loadSeason(season);
  }, [type, season, loadSeason]);

  /** Re-reads download state (after starting one, and while any is in progress). */
  const refreshDownloads = useCallback(() => {
    if (type === 'tv') {
      if (season != null) loadSeason(season, true);
    } else {
      api
        .downloads({ type, id })
        .then((r) => setDownloads(r.downloads))
        .catch(() => {});
    }
  }, [type, id, season, loadSeason]);

  const anyDownloading = downloads.some((d) => d.downloading);
  // Episodes still waiting for a source change less often than download progress.
  const anyFinding = type === 'tv' && !!episodes?.some((e) => e.finding);
  useEffect(() => {
    if (!anyDownloading && !anyFinding) return;
    const t = setInterval(refreshDownloads, anyDownloading ? 4000 : 15000);
    return () => clearInterval(t);
  }, [anyDownloading, anyFinding, refreshDownloads]);

  // Movie downloads: a finished copy (the explicitly downloaded one first), or one in progress.
  const completeDl = type === 'movie' ? downloads.filter((d) => d.complete && d.fileIdx != null).sort((a, b) => Number(b.requested) - Number(a.requested))[0] : undefined;
  const activeDl = type === 'movie' ? downloads.find((d) => d.downloading) : undefined;

  useEffect(() => {
    if (details) setTimeout(() => setFocus('title-play'), 50);
  }, [details]);

  // Warm up the remembered source while the page is open, so Play starts faster (no-op if there isn't one).
  useEffect(() => {
    if (!details) return;
    const s = type === 'tv' ? (lastWatched?.season ?? details.seasons[0]?.number) : undefined;
    api.prewarm({ mediaType: type, tmdbId: id, season: s }).catch(() => {});
    // once per page visit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [details]);

  /** The movie, or for a show the episode Play would start (resume point, else S1E1). */
  const mainTarget = useCallback((): Target => {
    if (type === 'movie' || !details) return {};
    return lastWatched?.season != null ? { season: lastWatched.season, episode: lastWatched.episode ?? 1 } : { season: details.seasons[0]?.number ?? 1, episode: 1 };
  }, [type, details, lastWatched]);

  const openPicker = useCallback((t: Target, mode: PickMode, theater = false) => {
    setBatch(null);
    setPicking({ ...t, mode, theater });
    if (t.season != null) setSeason(t.season);
    // Sources focuses its own list once the search finishes.
    setTimeout(() => sourcesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }, []);

  const play = useCallback(
    async (t: Target, source?: SavedSource) => {
      if (!details) return;
      setBusy(true);
      try {
        const info = await api.play({ mediaType: type, tmdbId: id, season: t.season, episode: t.episode, source });
        const q = type === 'tv' ? `?season=${t.season}&episode=${t.episode}` : '';
        navigate(`/watch/${type}/${id}${q}`, { state: { play: info } });
      } catch (e) {
        const err = e as ApiError;
        // Kids never see source lists: just say what happened.
        if (isKid) return void toast(err.message, 'error');
        // No source yet / not in this season pack: the player picks the best one itself.
        if (!source && (err.status === 409 || err.status === 422)) {
          const q = type === 'tv' ? `?season=${t.season}&episode=${t.episode}` : '';
          return void navigate(`/watch/${type}/${id}${q}`);
        }
        // A chosen source that failed: say why and show the list again.
        if (err.status !== 409 && err.status !== 422) toast(err.message, 'error');
        openPicker(t, 'play');
      } finally {
        setBusy(false);
      }
    },
    [details, type, id, navigate, openPicker, isKid],
  );

  /**
   * Plays an episode: from its finished download if there is one, else its own source or the season pack.
   * The server answers 409/422 when there's nothing suitable, and play() then opens the list for that episode.
   */
  const playEpisode = useCallback(
    (n: number, e: number) => {
      if (isKid) return void play({ season: n, episode: e }); // the server picks a verified source
      const ep = n === season ? episodes?.find((x) => x.number === e) : undefined;
      if (ep?.download?.complete) play({ season: n, episode: e }, { infoHash: ep.download.infoHash, releaseTitle: 'Downloaded file' });
      else play({ season: n, episode: e });
    },
    [season, episodes, play, isKid],
  );

  /** Play: a finished download first, then the remembered source, else the player picks the best one. */
  const playMain = useCallback(() => {
    if (!details) return;
    if (isKid && type === 'movie') return void play({});
    if (type === 'movie') {
      const sourceIsDownloaded = !!movieSource && downloads.some((d) => d.complete && d.infoHash === movieSource.infoHash);
      if (completeDl && !sourceIsDownloaded) play({}, { infoHash: completeDl.infoHash, releaseTitle: completeDl.releaseName });
      else if (movieSource) play({});
      else navigate(`/watch/movie/${id}`);
      return;
    }
    const t = mainTarget();
    playEpisode(t.season!, t.episode!);
  }, [details, type, id, navigate, movieSource, downloads, completeDl, mainTarget, play, playEpisode, isKid]);

  // "Play" from the home banner lands here with ?play=1; the player sends ?pick=1 when a source is needed.
  useEffect(() => {
    if (!details || autoPlayed.current) return;
    if (params.get('play')) {
      autoPlayed.current = true;
      playMain();
    } else if (params.get('pick')) {
      autoPlayed.current = true;
      const s = params.get('season');
      const e = params.get('episode');
      openPicker(s ? { season: Number(s), episode: Number(e) || 1 } : {}, 'play');
    }
  }, [details, params, playMain, openPicker]);

  /** Download: the given or remembered source; with neither, the server finds the best one itself. */
  const download = async (t: Target, source?: SavedSource) => {
    try {
      const r = await api.download({ mediaType: type, tmdbId: id, season: t.season, episode: t.episode, source, auto: !source });
      toast(downloadMessage(r));
      refreshDownloads();
      if (r.status === 'searching' && type === 'tv' && t.season != null) loadSeason(t.season, true);
    } catch (e) {
      const err = e as ApiError;
      // A remembered season pack that lacks this episode: show the list for it.
      if (err.status === 409 || err.status === 422) openPicker(t, 'download');
      else toast(err.message, 'error');
    }
  };

  /** Several episodes in one click: remembered sources, else a season pack or each episode found automatically. */
  const downloadBatch = async (eps: number[], airing: boolean) => {
    if (season == null || !eps.length) return;
    setSelecting(null);
    try {
      toast(batchMessage(await api.downloadEpisodes({ tmdbId: id, season, episodes: eps, follow: airing })));
      loadSeason(season, true);
      refreshDownloads();
    } catch (e) {
      toast((e as ApiError).message, 'error');
    }
  };

  /** Several episodes of the shown season: pick a season pack for them (or let FreeStream find each). */
  const openBatch = (eps: number[], label: string, airing: boolean) => {
    if (season == null) return;
    setSelecting(null);
    setPicking(null);
    setBatch({ season, episodes: eps, label, airing });
    setTimeout(() => sourcesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  };

  /** Everything out is on the Mac already: just download new episodes as they air. */
  const followSeason = async () => {
    if (season == null) return;
    try {
      toast(batchMessage(await api.downloadEpisodes({ tmdbId: id, season, episodes: [], follow: true })));
      loadSeason(season, true);
    } catch (e) {
      toast((e as ApiError).message, 'error');
    }
  };

  const stopFollowing = async () => {
    if (!follow) return;
    try {
      await api.unwatch(follow.key);
      setFollow(null);
      toast(`New episodes of season ${follow.season} won’t download automatically any more.`);
    } catch (e) {
      toast((e as ApiError).message, 'error');
    }
  };

  const toggleSelected = (n: number) => setSelecting((sel) => (sel ? (sel.includes(n) ? sel.filter((x) => x !== n) : [...sel, n].sort((a, b) => a - b)) : sel));

  /** Notify me: watch for a proper release in the background. */
  const toggleWatch = async () => {
    try {
      if (watch) {
        await api.unwatch(watch.key);
        setWatch(null);
        toast('Stopped watching for this title.');
      } else {
        const w = await api.watch({ mediaType: type, tmdbId: id });
        setWatch(w);
        toast('We’ll look for a proper release and show it under Watching (🔔).');
      }
    } catch (e) {
      toast((e as ApiError).message, 'error');
    }
  };

  const dismissUpgrade = () => {
    if (upgrade) api.watchSeen(upgrade.key).catch(() => {});
    setUpgrade(null);
  };

  const toggleList = async () => {
    if (!details) return;
    if (inList) await api.removeFromList(type, id);
    else await api.addToList({ mediaType: type, tmdbId: id, title: details.title, posterPath: details.posterPath, backdropPath: details.backdropPath });
    setInList(!inList);
  };

  const startOver = async () => {
    await api.clearProgress(type, id);
    setLastWatched(null);
    if (type === 'movie') playMain();
    else playEpisode(details?.seasons[0]?.number ?? 1, 1);
  };

  /** Change source: for a show, only the episode it's about (the season pack stays for the others). */
  const changeSource = async (t: Target = mainTarget()) => {
    await api.forgetSource(type, id, t.season, t.episode);
    if (type === 'movie') setMovieSource(null);
    else if (t.season != null) loadSeason(t.season, true);
    openPicker(t, 'play');
  };

  if (loadError) return <SetupNeeded error={loadError} />;
  if (!details) return <Spinner />;

  const resuming = !!lastWatched && lastWatched.position > 30;
  const target = mainTarget();
  const playLabel =
    type === 'tv'
      ? `${resuming ? 'Resume' : 'Play'} S${target.season}:E${target.episode}`
      : resuming
        ? `Resume · ${Math.max(1, Math.round((lastWatched!.duration - lastWatched!.position) / 60))}m left`
        : 'Play';

  // For a show: the source of the episode Play would start (its own, or the season pack).
  const targetEpisode = type === 'tv' && target.season === season ? episodes?.find((e) => e.number === target.episode) : undefined;
  const currentSource: SavedSource | null =
    type === 'movie' ? movieSource : targetEpisode?.source ? { releaseTitle: targetEpisode.source.releaseTitle, infoHash: targetEpisode.source.infoHash || undefined } : null;
  const release = details.release;
  /** Something to play already: a source or a finished download. */
  const hasCopy = !!(currentSource || completeDl);
  const pickingEpisode = picking?.episode != null ? episodes?.find((e) => e.number === picking.episode) : undefined;
  const pickerSubtitle = picking && type === 'tv' ? `Season ${picking.season} · Episode ${picking.episode}${pickingEpisode ? ` · ${pickingEpisode.name}` : ''}` : undefined;

  // Downloading several episodes of the shown season.
  const seasonTodo = (episodes || []).filter(needsDownload).map((e) => e.number);
  const anyOut = !!episodes?.some(isOut);
  const airing = !!episodes?.some((e) => !isOut(e)) || release.nextEpisode?.season === season;
  // "Rest of season": from the episode you're up to (the next one if you finished it).
  const upTo = lastWatched?.season === season && lastWatched?.episode != null ? lastWatched.episode : null;
  const restFrom = upTo != null && (episodes?.find((e) => e.number === upTo)?.progress ?? 0) >= FINISHED ? upTo + 1 : upTo;
  const restTodo = restFrom != null ? seasonTodo.filter((n) => n >= restFrom) : [];
  const showRest = restTodo.length > 0 && restTodo.length < seasonTodo.length;
  const selectable = new Set(seasonTodo);

  return (
    <div className="page page-detail">
      <section className="detail-hero">
        <div className="hero-bg" style={{ backgroundImage: `url(${img(details.backdropPath, 'w1280')})` }} />
        <div className="hero-shade" />
        <div className="hero-content">
          {details.logoPath ? <img className="title-logo" src={img(details.logoPath, 'w500')} alt={details.title} /> : <h1 className="hero-title">{details.title}</h1>}
          <div className="meta-line">
            {details.rating > 0 && (
              <span className="rating">
                <Star /> {details.rating.toFixed(1)}
              </span>
            )}
            <span>{details.year}</span>
            {ageRating != null && <span className="age-chip">{ageRating === 0 ? 'All ages' : `${ageRating}+`}</span>}
            {type === 'tv' ? <span>{details.seasons.length} Season{details.seasons.length === 1 ? '' : 's'}</span> : <span>{formatRuntime(details.runtime)}</span>}
            {details.genres.slice(0, 3).map((g) => (
              <span key={g}>{g}</span>
            ))}
          </div>
          {details.tagline && <p className="tagline">{details.tagline}</p>}
          <p className="hero-overview">{details.overview}</p>
          {details.cast.length > 0 && <p className="muted small">Starring {details.cast.join(', ')}</p>}
          {because && (
            <FocusGroup focusKey="title-because" className="suggest-reason small">
              <Sparkles className="inline-icon" />
              <span>Suggested for you: {because}</span>
              {!isKid && (
                <Focusable className="link-btn" scroll="top" onSelect={notInterested}>
                  <ThumbsDown className="inline-icon" /> Not interested
                </Focusable>
              )}
            </FocusGroup>
          )}
          {release.state === 'coming' && (
            <div className="release-pill">
              <CalendarClock /> Coming {release.expected ? shortDate(release.expected) : 'soon'}
            </div>
          )}
          {release.state === 'theaters' && (
            <div className="release-pill is-theaters">
              <Clapperboard /> In theaters · {release.expected ? `digital release expected ${shortDate(release.expected)}` : 'digital release date not announced'}
            </div>
          )}

          {isKid ? (
            <FocusGroup focusKey="title-actions" className="actions">
              {release.state === 'available' && (
                <Button focusKey="title-play" variant="primary" icon={<Play />} scroll="top" disabled={busy} onSelect={playMain}>
                  {busy ? 'Getting it ready…' : playLabel}
                </Button>
              )}
              <Button focusKey={release.state === 'available' ? undefined : 'title-play'} icon={inList ? <Check /> : <ListPlus />} scroll="top" onSelect={toggleList}>
                My List
              </Button>
            </FocusGroup>
          ) : (
          <FocusGroup focusKey="title-actions" className="actions">
            {release.state !== 'coming' &&
              (release.state === 'theaters' && !hasCopy ? (
                <Button focusKey="title-play" variant="primary" icon={<Clapperboard />} scroll="top" disabled={busy} onSelect={() => openPicker({}, 'play', true)}>
                  Watch theater copy
                </Button>
              ) : (
                <Button focusKey="title-play" variant="primary" icon={<Play />} scroll="top" disabled={busy} onSelect={playMain}>
                  {busy ? 'Starting…' : playLabel}
                </Button>
              ))}
            {/* Shows download per source (in each episode's source list), not per title. */}
            {type === 'movie' &&
              release.state !== 'coming' &&
              (release.state !== 'theaters' || hasCopy) &&
              (completeDl ? (
                <Button icon={<CheckCircle2 />} scroll="top" className="btn-done" onSelect={() => navigate('/downloads')}>
                  Downloaded
                </Button>
              ) : activeDl ? (
                <Button icon={<Download />} scroll="top" className="btn-progress" onSelect={() => navigate('/downloads')}>
                  Downloading {Math.floor(activeDl.progress * 100)}%
                </Button>
              ) : (
                <Button icon={<Download />} scroll="top" onSelect={() => download(target)}>
                  Download
                </Button>
              ))}
            {release.state !== 'available' && (
              <Button focusKey={release.state === 'coming' ? 'title-play' : undefined} icon={watch ? <BellRing /> : <Bell />} scroll="top" className={watch ? 'btn-done' : ''} onSelect={toggleWatch}>
                {watch ? 'Notifying' : release.state === 'theaters' ? 'Notify when out' : 'Notify me'}
              </Button>
            )}
            <Button icon={inList ? <Check /> : <ListPlus />} scroll="top" onSelect={toggleList}>
              My List
            </Button>
            <Button icon={<Link2 />} scroll="top" onSelect={() => setShowMagnet(true)}>
              Magnet link
            </Button>
          </FocusGroup>
          )}

          {!isKid && upgrade?.found && (
            <div className="upgrade-banner">
              <div>
                <strong>
                  <Sparkles className="inline-icon" /> Better version found
                </strong>
                <span className="muted small">{upgrade.found.label}</span>
              </div>
              <FocusGroup focusKey="upgrade" className="actions actions-tight">
                <Button variant="primary" icon={<Play />} onSelect={() => play({ season: upgrade.season, episode: upgrade.episode }, upgrade.found!.source)}>
                  Play it
                </Button>
                <Button icon={<Download />} onSelect={() => download({ season: upgrade.season, episode: upgrade.episode }, upgrade.found!.source)}>
                  Download
                </Button>
                <Button variant="ghost" onSelect={dismissUpgrade}>
                  Not now
                </Button>
              </FocusGroup>
            </div>
          )}

          {!isKid && (completeDl || currentSource || resuming || sourceVerdict || release.state === 'available') && (
            <FocusGroup focusKey="title-links" className="title-links muted small">
              {completeDl ? (
                <span>✓ On this Mac{sourceVerdict ? ` · ${sourceVerdict.label}` : ''}</span>
              ) : currentSource ? (
                <span className="source-note">Source: {sourceVerdict ? sourceVerdict.label : currentSource.releaseTitle}</span>
              ) : null}
              {sourceVerdict && (
                <Focusable className="link-btn" scroll="top" onSelect={() => setShowVerdict((v) => !v)}>
                  {showVerdict ? 'Hide details' : 'Details'}
                </Focusable>
              )}
              {currentSource && (
                <Focusable className="link-btn" scroll="top" onSelect={() => changeSource()}>
                  Change source
                </Focusable>
              )}
              {!currentSource && !completeDl && release.state === 'available' && (
                <>
                  <span className="source-note">Play picks the best source automatically</span>
                  <Focusable className="link-btn" scroll="top" onSelect={() => openPicker(mainTarget(), 'play')}>
                    Choose one yourself
                  </Focusable>
                </>
              )}
              {resuming && (
                <Focusable className="link-btn" scroll="top" onSelect={startOver}>
                  Start over
                </Focusable>
              )}
            </FocusGroup>
          )}
          {showVerdict && sourceVerdict && <VerdictCard v={sourceVerdict} />}
        </div>
      </section>

      {type === 'tv' && (
        <section className="episodes-section">
          <FocusGroup focusKey="seasons" className="chips seasons">
            {details.seasons.map((s) => (
              <Focusable key={s.number} className={`chip${season === s.number ? ' is-active' : ''}`} onSelect={() => setSeason(s.number)}>
                {s.name}
              </Focusable>
            ))}
          </FocusGroup>
          {!isKid && episodes && (anyOut || airing) && (
            <FocusGroup focusKey="season-actions" className="actions actions-tight season-actions">
              {selecting ? (
                <>
                  <Button variant="primary" icon={<Download />} disabled={!selecting.length} onSelect={() => downloadBatch(selecting, airing)}>
                    {selecting.length ? `Download ${selecting.length} episode${selecting.length === 1 ? '' : 's'}` : 'Pick episodes below'}
                  </Button>
                  <Button icon={<ListChecks />} onSelect={() => setSelecting(selecting.length === seasonTodo.length ? [] : seasonTodo)}>
                    {selecting.length === seasonTodo.length ? 'Clear' : 'Select all'}
                  </Button>
                  <Button variant="ghost" icon={<X />} onSelect={() => setSelecting(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  {seasonTodo.length > 0 ? (
                    <Button icon={<Download />} onSelect={() => downloadBatch(seasonTodo, airing)}>
                      Download season
                    </Button>
                  ) : airing && !follow ? (
                    <Button icon={<Download />} onSelect={followSeason}>
                      Download new episodes as they air
                    </Button>
                  ) : !airing ? (
                    <Button icon={<CheckCircle2 />} className="btn-done" onSelect={() => navigate('/downloads')}>
                      Season downloaded
                    </Button>
                  ) : null}
                  {showRest && (
                    <Button icon={<Download />} onSelect={() => downloadBatch(restTodo, airing)}>
                      Rest of season
                    </Button>
                  )}
                  {seasonTodo.length > 1 && (
                    <Button variant="ghost" icon={<Layers />} onSelect={() => openBatch(seasonTodo, 'Whole season', airing)}>
                      Choose a season pack
                    </Button>
                  )}
                  {seasonTodo.length > 1 && (
                    <Button icon={<ListChecks />} onSelect={() => setSelecting([])}>
                      Select episodes
                    </Button>
                  )}
                  {follow && (
                    <Button icon={<BellRing />} className="btn-done" onSelect={stopFollowing}>
                      New episodes download automatically
                    </Button>
                  )}
                </>
              )}
            </FocusGroup>
          )}
          {!episodes ? (
            <Spinner />
          ) : (
            <FocusGroup focusKey="episodes" className="episode-list">
              {episodes.map((e) => (
                <div className={`episode-row${selecting ? ' is-picking' : ''}${selecting && !selectable.has(e.number) ? ' is-unselectable' : ''}${selecting?.includes(e.number) ? ' is-selected' : ''}`} key={e.number}>
                  <Focusable
                    className="episode"
                    disabled={busy}
                    title={selecting && !selectable.has(e.number) ? (isOut(e) ? 'Already downloaded or on its way' : 'Not out yet') : undefined}
                    onSelect={() => (selecting ? selectable.has(e.number) && toggleSelected(e.number) : playEpisode(season!, e.number))}
                  >
                    {selecting && <div className="episode-check">{selecting.includes(e.number) ? <CheckSquare /> : <Square />}</div>}
                    <div className="episode-num">{e.number}</div>
                    <div className="episode-still">
                      {e.stillPath ? <img src={img(e.stillPath, 'w300')} alt="" loading="lazy" onError={hideBroken} /> : <div className="card-fallback" />}
                      <div className="card-play">
                        <Play />
                      </div>
                      {e.progress > 0 && <ProgressBar value={e.progress} />}
                    </div>
                    <div className="episode-body">
                      <div className="episode-head">
                        <h3>{e.name}</h3>
                        {e.airDate && e.airDate > todayIso() ? <span className="accent">Airs {shortDate(e.airDate)}</span> : <span className="muted">{formatRuntime(e.runtime)}</span>}
                      </div>
                      <p className="muted">{e.overview}</p>
                    </div>
                  </Focusable>
                  {!isKid && (
                    <Focusable
                      className="btn btn-secondary btn-icon episode-source"
                      disabled={busy}
                      title={e.source ? `Source: ${e.source.releaseTitle} — choose another or preview` : 'Choose a source (with preview)'}
                      onSelect={() => openPicker({ season: season!, episode: e.number }, 'play')}
                    >
                      <ListVideo />
                    </Focusable>
                  )}
                  {isKid ? null : e.download?.complete ? (
                    <Focusable className="btn btn-secondary btn-icon episode-download is-done" disabled={busy} title="On this Mac — play it" onSelect={() => playEpisode(season!, e.number)}>
                      <CheckCircle2 />
                    </Focusable>
                  ) : e.download?.downloading ? (
                    <Focusable className="btn btn-secondary episode-download is-progress" title="Downloading" onSelect={() => navigate('/downloads')}>
                      {Math.floor(e.download.progress * 100)}%
                    </Focusable>
                  ) : e.finding ? (
                    <Focusable className="btn btn-secondary btn-icon episode-download is-finding" title={e.finding} onSelect={() => navigate('/watching')}>
                      <Search />
                    </Focusable>
                  ) : null}
                </div>
              ))}
            </FocusGroup>
          )}
        </section>
      )}

      <div ref={sourcesRef}>
        {batch && !picking && !isKid && (
          <SeasonDownload
            key={`${batch.season}-${batch.episodes.join(',')}`}
            tmdbId={id}
            title={details.title}
            year={details.year}
            batch={batch}
            downloads={downloads}
            busy={busy}
            onPlay={(ep, src) => play({ season: batch.season, episode: ep }, src)}
            onStarted={() => {
              setBatch(null);
              loadSeason(batch.season, true);
              setTimeout(() => setFocus('season-actions'), 50);
            }}
            onCancel={() => {
              setBatch(null);
              setTimeout(() => setFocus('season-actions'), 50);
            }}
          />
        )}
        {picking && !isKid && (
          <Sources
            key={`${picking.mode}-${picking.season}-${picking.episode}`}
            mediaType={type}
            tmdbId={id}
            title={details.title}
            year={details.year}
            season={picking.season}
            episode={picking.episode}
            mode={picking.mode}
            subtitle={pickerSubtitle}
            theaterFocus={picking.theater || release.state === 'theaters'}
            busy={busy}
            downloads={type === 'movie' ? downloads : downloads.filter((d) => d.season === picking.season && d.episode === picking.episode)}
            onDownloaded={() => {
              refreshDownloads();
              setPicking(null);
              setTimeout(() => setFocus('title-play'), 50);
            }}
            onPlay={(src) => play(picking, src)}
          />
        )}
      </div>

      {similar.length > 0 && (
        <div className="rows rows-detail">
          <Row title="More like this" focusKey="row-similar">
            {similar.map((c) => (
              <TitleCard key={`${c.mediaType}-${c.id}`} item={c} />
            ))}
          </Row>
        </div>
      )}

      {showMagnet && (
        <MagnetModal
          onClose={() => {
            setShowMagnet(false);
            setTimeout(() => setFocus('title-play'), 50);
          }}
          onPlay={(src) => {
            setShowMagnet(false);
            play(picking ?? target, src);
          }}
          onDownload={(src) => {
            setShowMagnet(false);
            download(picking ?? target, src);
          }}
        />
      )}
    </div>
  );
}
