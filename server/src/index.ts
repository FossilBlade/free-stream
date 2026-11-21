import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import express, { type NextFunction, type Request, type Response } from 'express';
import { IndexerError, searchReleases, testIndexer, type SearchRequest } from './indexers.ts';
import { rankForDevice, type RankedRelease } from './pick.ts';
import { markNotInterested, moreLikeThis, rebuild, startSuggestions, suggestedBecause, suggestionRows, suggestionStatus } from './suggest.ts';
import { remoteDefaults, testJudge } from './llm.ts';
import { guessTitle, parseRelease } from './release.ts';
import { deepCheck, getVerdict, hasFfmpeg, setSelfBaseUrl, verdictForHash } from './verify.ts';
import { addWatch, autoSource, markSeen, removeWatch, startWatcher } from './watcher.ts';
import {
  adultsOnly,
  ageOf,
  createProfile,
  deleteProfile,
  filterAllowed,
  hasPin,
  isKid,
  isParent,
  parentOnly,
  profileMiddleware,
  profileOf,
  ProfileError,
  requireAllowed,
  setPin,
  unlock,
  updateProfile,
} from './profiles.ts';
import {
  allProgress,
  db,
  DATA_DIR,
  profileData,
  flush,
  getSettings,
  progressKey,
  save,
  sourceKey,
  episodeSourceKey,
  rememberSource,
  sourceFor,
  type MediaRef,
  type MediaType,
  type Progress,
  type CachedDownload,
  type SavedSource,
  type Settings,
} from './store.ts';
import { shiftVtt, srtToVtt } from './subtitles.ts';
import { keyframeAt, mediaInfo, setTranscodeBaseUrl, transcode } from './transcode.ts';
import { doctor, startDoctor } from './doctor.ts';
import * as tmdb from './tmdb.ts';
import {
  addSource,
  backfillTitles,
  deleteDownload,
  deleteDownloadFile,
  discardPreview,
  finishedFilePath,
  folderName,
  getTorrent,
  markPlayed,
  migrateLegacyFolders,
  prewarm,
  prioritizeEdges,
  saveAllBitfields,
  rememberFile,
  resumeDownloads,
  setKept,
  startDownload,
  listDownloads,
  pickFile,
  isSeasonPack,
  readFileText,
  shutdown,
  statusOf,
  streamClosed,
  streamOpened,
  subtitlesFor,
  TorrentError,
} from './torrents.ts';

const PORT = Number(process.env.PORT) || 8080;
const WEB_DIST = join(import.meta.dirname, '../../web/dist');

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use('/api', profileMiddleware);

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const mediaType = (v: unknown): MediaType => {
  if (v === 'movie' || v === 'tv') return v;
  throw new HttpError(400, 'type must be "movie" or "tv"');
};
const int = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} must be a number`);
  return n;
};
const optInt = (v: unknown, name: string) => (v === undefined || v === null || v === '' ? undefined : int(v, name));
const hash = (v: unknown): string => {
  const s = String(v).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(s)) throw new HttpError(400, 'bad infoHash');
  return s;
};

const FINISHED = 0.92;

/** "The Odyssey (2026)" for a movie/show, used for the download folder and the Downloads page. */
async function titleFor(type: MediaType, id: number): Promise<{ folder?: string; title?: string; mediaType: MediaType; tmdbId: number }> {
  try {
    const d = await tmdb.details(type, id);
    const folder = folderName(d.title, d.year);
    return { folder: folder || undefined, title: folder || d.title, mediaType: type, tmdbId: id };
  } catch {
    return { mediaType: type, tmdbId: id };
  }
}

// --- status & settings ----------------------------------------------------------

app.get('/api/status', (_req, res) => {
  const s = getSettings();
  // `health` drives the red dot on the Settings icon (adults only; the details need the parent PIN).
  res.json({ tmdbConfigured: !!s.tmdbApiKey, indexerConfigured: !!s.indexerApiKey, indexerType: s.indexerType, health: db.health?.status || null });
});

/** Last health check (runs one if there's none yet). */
app.get('/api/doctor', parentOnly, async (_req, res) => {
  res.json(db.health || (await doctor()));
});

/** Run the health check now. */
app.post('/api/doctor', parentOnly, async (_req, res) => {
  res.json(await doctor());
});

app.get('/api/settings', parentOnly, (_req, res) => {
  res.json({ ...getSettings(), aiProviders: remoteDefaults(), hasFfmpeg });
});

app.put('/api/settings', parentOnly, (req, res) => {
  const b = req.body as Partial<Settings>;
  const s = db.settings;
  if (typeof b.tmdbApiKey === 'string') s.tmdbApiKey = b.tmdbApiKey.trim();
  if (b.indexerType === 'prowlarr' || b.indexerType === 'jackett') s.indexerType = b.indexerType;
  if (typeof b.indexerUrl === 'string') s.indexerUrl = b.indexerUrl.trim();
  if (typeof b.indexerApiKey === 'string') s.indexerApiKey = b.indexerApiKey.trim();
  if (typeof b.downloadDir === 'string' && b.downloadDir.trim()) s.downloadDir = b.downloadDir.trim();
  if (b.cacheLimitGb != null) s.cacheLimitGb = Math.max(1, Number(b.cacheLimitGb) || 50);
  if (b.aiMode && ['off', 'local', 'remote', 'local+remote'].includes(b.aiMode)) s.aiMode = b.aiMode;
  if (typeof b.aiFrames === 'boolean') s.aiFrames = b.aiFrames;
  if (typeof b.aiLocalUrl === 'string') s.aiLocalUrl = b.aiLocalUrl.trim();
  if (typeof b.aiLocalModel === 'string') s.aiLocalModel = b.aiLocalModel.trim();
  if (b.aiRemoteProvider && ['google', 'anthropic', 'openai', 'xai', 'openrouter', 'custom'].includes(b.aiRemoteProvider)) s.aiRemoteProvider = b.aiRemoteProvider;
  if (typeof b.aiRemoteApiKey === 'string') s.aiRemoteApiKey = b.aiRemoteApiKey.trim();
  if (typeof b.aiRemoteModel === 'string') s.aiRemoteModel = b.aiRemoteModel.trim();
  if (typeof b.aiRemoteBaseUrl === 'string') s.aiRemoteBaseUrl = b.aiRemoteBaseUrl.trim();
  if (typeof b.watchAutoDownload === 'boolean') s.watchAutoDownload = b.watchAutoDownload;
  if (b.watchResolution && ['2160p', '1080p', '720p', 'any'].includes(b.watchResolution)) s.watchResolution = b.watchResolution;
  if (b.watchMaxSizeGb != null) s.watchMaxSizeGb = Math.max(1, Number(b.watchMaxSizeGb) || 8);
  if (typeof b.shareUploads === 'boolean') s.shareUploads = b.shareUploads; // applies to torrents started after the change
  if (typeof b.suggestAi === 'boolean') s.suggestAi = b.suggestAi;
  save();
  res.json({ ...getSettings(), aiProviders: remoteDefaults(), hasFfmpeg });
});

app.post('/api/settings/test-ai', parentOnly, async (req, res) => {
  res.json(await testJudge((req.body as { which?: string }).which === 'remote' ? 'remote' : 'local'));
});

app.post('/api/settings/test-indexer', parentOnly, async (_req, res) => {
  res.json(await testIndexer());
});

// --- profiles & parent PIN ----------------------------------------------------------------

app.get('/api/profiles', (req, res) => {
  res.json({ profiles: Object.values(db.profiles).sort((a, b) => a.createdAt - b.createdAt), hasPin: hasPin(), parentUnlocked: isParent(req) });
});

app.post('/api/profiles', parentOnly, (req, res) => {
  res.json(createProfile(req.body));
});

app.put('/api/profiles/:id', parentOnly, (req, res) => {
  res.json(updateProfile(String(req.params.id), req.body));
});

app.delete('/api/profiles/:id', parentOnly, (req, res) => {
  deleteProfile(String(req.params.id));
  res.json({ ok: true });
});

app.post('/api/parent/unlock', (req, res) => {
  res.json({ token: unlock(String((req.body as { pin?: string }).pin || '')) });
});

/** Set the parent PIN (first time: anyone on an adult profile; afterwards: needs the current PIN). */
app.post('/api/parent/pin', (req, res) => {
  if (isKid(res)) throw new ProfileError('Ask a parent to change the PIN.', 403, 'kids');
  setPin(req, String((req.body as { pin?: string }).pin || ''));
  res.json({ ok: true });
});

// --- catalog --------------------------------------------------------------------

function continueWatching(profileId: string): Progress[] {
  const latestPerTitle = new Map<string, Progress>();
  for (const p of Object.values(profileData(profileId).progress)) {
    const k = `${p.mediaType}:${p.tmdbId}`;
    const cur = latestPerTitle.get(k);
    if (!cur || p.updatedAt > cur.updatedAt) latestPerTitle.set(k, p);
  }
  return [...latestPerTitle.values()]
    .filter((p) => p.duration > 0 && p.position / p.duration < FINISHED && p.position > 30)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20);
}

/** Kids' rows: every title checked against the profile's age limit; empty rows dropped. */
async function filterRows(res: Response, rows: tmdb.Row[]): Promise<tmdb.Row[]> {
  const profile = profileOf(res);
  if (profile.kind !== 'kid') return rows;
  const out = await Promise.all(rows.map(async (r) => ({ ...r, items: await filterAllowed(profile, r.items) })));
  return out.filter((r) => r.items.length);
}

app.get('/api/home', async (_req, res) => {
  const profile = profileOf(res);
  const data = profileData(profile.id);
  const rows = profile.kind === 'kid' ? await tmdb.kidsRows(undefined, profile.languages, profile.maxAge) : await tmdb.homeRows(profile.languages);
  res.json({ continueWatching: continueWatching(profile.id), myList: data.myList, suggestions: await suggestionRows(profile), rows: await filterRows(res, rows) });
});

// --- suggestions -------------------------------------------------------------------------------

app.get('/api/title/:type/:id/similar', async (req, res) => {
  res.json({ results: await moreLikeThis(profileOf(res), mediaType(req.params.type), int(req.params.id, 'id')) });
});

app.post('/api/suggestions/not-interested', (req, res) => {
  const b = req.body as { mediaType: MediaType; tmdbId: number };
  markNotInterested(profileOf(res).id, mediaType(b.mediaType), int(b.tmdbId, 'tmdbId'));
  res.json({ ok: true });
});

app.get('/api/suggestions/status', parentOnly, (_req, res) => {
  res.json({ profiles: suggestionStatus() });
});

/** Rebuild now (normally nightly at 3am). Runs in the background; poll the status. */
app.post('/api/suggestions/rebuild', parentOnly, (req, res) => {
  const id = (req.body as { profileId?: string }).profileId;
  rebuild(id ? [id] : Object.keys(db.profiles));
  res.json({ ok: true });
});

app.get('/api/browse/:type', async (req, res) => {
  const type = mediaType(req.params.type);
  const profile = profileOf(res);
  const lang = typeof req.query.lang === 'string' && /^[a-z]{2}$/.test(req.query.lang) ? req.query.lang : undefined;
  const rows = profile.kind === 'kid' ? await tmdb.kidsRows(type, profile.languages, profile.maxAge) : await tmdb.browseRows(type, lang);
  res.json({ rows: await filterRows(res, rows) });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return void res.json({ results: [], people: [], hasMore: false });
  const profile = profileOf(res);
  const r = await tmdb.search(q, { languages: profile.languages, page: optInt(req.query.page, 'page') });
  const f = filtersFrom(req.query as Record<string, string | undefined>);
  res.json({ ...r, results: await filterAllowed(profile, r.results.filter((c) => tmdb.matchesFilters(c, f))) });
});

function filtersFrom(qs: Record<string, string | undefined>): tmdb.DiscoverFilters {
  return {
    type: qs.type === 'movie' || qs.type === 'tv' ? qs.type : 'all',
    language: qs.language && /^[a-z]{2}$/.test(qs.language) ? qs.language : undefined,
    genre: qs.genre && tmdb.genreNames().includes(qs.genre) ? qs.genre : undefined,
    decade: (['this-year', '2020s', '2010s', '2000s', 'older'] as const).find((d) => d === qs.decade),
    sort: qs.sort === 'newest' || qs.sort === 'top' ? qs.sort : 'popular',
    page: optInt(qs.page, 'page'),
  };
}

/** Browse without typing: type / language / genre / decade / sort. */
app.get('/api/discover', async (req, res) => {
  const qs = req.query as Record<string, string | undefined>;
  const f: tmdb.DiscoverFilters = {
    type: qs.type === 'movie' || qs.type === 'tv' ? qs.type : 'all',
    language: qs.language && /^[a-z]{2}$/.test(qs.language) ? qs.language : undefined,
    genre: qs.genre && tmdb.genreNames().includes(qs.genre) ? qs.genre : undefined,
    decade: (['this-year', '2020s', '2010s', '2000s', 'older'] as const).find((d) => d === qs.decade),
    sort: qs.sort === 'newest' || qs.sort === 'top' ? qs.sort : 'popular',
    page: optInt(qs.page, 'page'),
  };
  const r = await tmdb.discover(f);
  res.json({ ...r, results: await filterAllowed(profileOf(res), r.results) });
});

app.get('/api/genres', (_req, res) => {
  res.json({ genres: tmdb.genreNames(), languages: tmdb.LANGUAGE_NAMES });
});

app.get('/api/person/:id', async (req, res) => {
  const r = await tmdb.personCredits(int(req.params.id, 'id'));
  res.json({ ...r, results: await filterAllowed(profileOf(res), r.results) });
});

app.get('/api/title/:type/:id', async (req, res) => {
  const type = mediaType(req.params.type);
  const id = int(req.params.id, 'id');
  await requireAllowed(res, type, id);
  const profile = profileOf(res);
  const data = profileData(profile.id);
  const details = await tmdb.details(type, id);
  const progress = Object.values(data.progress)
    .filter((p) => p.mediaType === type && p.tmdbId === id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({
    details,
    ageRating: await ageOf(type, id),
    inMyList: data.myList.some((m) => m.mediaType === type && m.tmdbId === id),
    lastWatched: progress[0] || null,
    savedSource: type === 'movie' ? db.sources[sourceKey(type, id)] || null : null,
    downloads: await listDownloads({ mediaType: type, tmdbId: id }),
    suggestedBecause: suggestedBecause(profile.id, type, id),
    ...titleExtras(type, id),
  });
});

/** Watch state, "better version found", and what the deep check said about the current source. */
function titleExtras(type: MediaType, id: number) {
  const watches = Object.values(db.watches).filter((w) => w.mediaType === type && w.tmdbId === id);
  const current = type === 'movie' ? db.sources[sourceKey(type, id)] : undefined;
  return {
    // Any active watch for the title counts as "Notifying" (a release watch, or a better-version watch).
    watch: watches.find((w) => w.reason === 'release' && w.season == null) || watches.find((w) => w.reason === 'upgrade' && w.status === 'waiting') || null,
    upgrade: watches.find((w) => w.reason === 'upgrade' && w.status === 'found' && w.found && w.found.source.infoHash !== current?.infoHash) || null,
    watches,
    sourceVerdict: current?.infoHash ? verdictForHash(current.infoHash) || null : null,
  };
}

app.get('/api/title/tv/:id/season/:n', async (req, res) => {
  const id = int(req.params.id, 'id');
  const n = int(req.params.n, 'season');
  await requireAllowed(res, 'tv', id);
  const progressMap = profileData(profileOf(res).id).progress;
  const episodes = await tmdb.season(id, n);
  const downloads = (await listDownloads({ mediaType: 'tv', tmdbId: id })).filter((d) => d.season === n);
  res.json({
    episodes: episodes.map((e) => {
      const p = progressMap[progressKey('tv', id, n, e.number)];
      // Best download of this episode: finished beats in-progress; ignore files only partly cached by watching.
      const dl = downloads
        .filter((d) => d.episode === e.number && (d.complete || d.downloading))
        .sort((a, b) => Number(b.complete) - Number(a.complete) || b.progress - a.progress)[0];
      return {
        ...e,
        progress: p ? Math.min(1, p.position / (p.duration || 1)) : 0,
        download: dl ? { infoHash: dl.infoHash, fileIdx: dl.fileIdx, progress: dl.progress, complete: dl.complete, downloading: dl.downloading } : null,
        // The source this episode would play from (its own choice, else the season pack).
        source: (() => {
          const src = sourceFor('tv', id, n, e.number);
          return src ? { releaseTitle: src.releaseTitle, infoHash: src.infoHash || null, own: !!db.sources[episodeSourceKey(id, n, e.number)] } : null;
        })(),
      };
    }),
    savedSource: db.sources[sourceKey('tv', id, n)] || null,
    downloads,
  });
});

// --- sources & playback -----------------------------------------------------------

app.get('/api/sources', adultsOnly, async (req, res) => {
  const type = mediaType(req.query.type);
  const id = optInt(req.query.id, 'id');
  const d = id ? await tmdb.details(type, id).catch(() => null) : null;
  const screen = optInt(req.query.screen, 'screen');
  const request: SearchRequest = {
    mediaType: type,
    title: String(req.query.title || ''),
    year: req.query.year ? String(req.query.year) : undefined,
    season: optInt(req.query.season, 'season'),
    episode: optInt(req.query.episode, 'episode'),
    ...(d ? releaseHints(d, profileOf(res).languages) : {}),
    // What this device can show and decode, so the best pick suits it.
    screen: screen && [720, 1080, 2160].includes(screen) ? screen : undefined,
    dolby: req.query.dolby === '0' ? false : req.query.dolby === '1' ? true : undefined,
    canConvert: hasFfmpeg,
  };
  const { releases, skipped } = await searchReleases(request);
  // Attach what earlier deep checks found, so the list can show it.
  const withVerdicts: RankedRelease[] = releases
    .map((r) => {
      const v = r.infoHash ? verdictForHash(r.infoHash) : undefined;
      return { ...r, verdict: v ? { outcome: v.outcome, label: v.label, summary: v.ai?.summary || null, checkedBy: v.ai ? `${v.ai.provider} · ${v.ai.model}` : null } : null };
    })
    .filter((r) => r.verdict?.outcome !== 'rejected');
  res.json({ releases: rankForDevice(withVerdicts, request), skipped, canConvert: hasFfmpeg });
});

/** Search hints from TMDB: every plausible release year, other titles, preferred audio languages. */
function releaseHints(d: tmdb.Details, languages: string[]) {
  const years = [...new Set([d.year, d.release.theatrical?.slice(0, 4), d.release.digital?.slice(0, 4)].filter((y): y is string => !!y))];
  return {
    runtime: d.runtime,
    years,
    altTitles: d.originalTitle && d.originalTitle !== d.title && /^[\x00-\x7f]+$/.test(d.originalTitle) ? [d.originalTitle] : [],
    preferLanguages: languages.map((l) => tmdb.LANGUAGE_NAMES[l]).filter(Boolean),
  };
}

/** Deep check: file list + runtime probe + AI. Slow (seconds to a minute); results are cached. */
app.post('/api/verify', adultsOnly, async (req, res) => {
  const b = req.body as { source?: SavedSource; mediaType: MediaType; tmdbId: number; season?: number; episode?: number; release?: { size?: number; seeders?: number; indexer?: string }; force?: boolean };
  if (!b.source) throw new HttpError(400, 'source is required');
  res.json(
    await deepCheck({
      source: b.source,
      mediaType: mediaType(b.mediaType),
      tmdbId: int(b.tmdbId, 'tmdbId'),
      season: optInt(b.season, 'season'),
      episode: optInt(b.episode, 'episode'),
      release: b.release,
      force: !!b.force,
    }),
  );
});

app.get('/api/verdict/:hash/:idx', (req, res) => {
  res.json({ verdict: getVerdict(hash(req.params.hash), int(req.params.idx, 'file')) || null });
});

// --- watching (notify me / better version) -------------------------------------------------

app.get('/api/watching', (_req, res) => {
  if (isKid(res)) return void res.json({ watches: [], unseen: 0 });
  const watches = Object.values(db.watches).sort((a, b) => Number(b.status === 'found' && !b.seen) - Number(a.status === 'found' && !a.seen) || b.createdAt - a.createdAt);
  res.json({ watches, unseen: watches.filter((w) => w.status === 'found' && !w.seen).length });
});

app.post('/api/watch', adultsOnly, async (req, res) => {
  const b = req.body as { mediaType: MediaType; tmdbId: number; season?: number; episode?: number };
  res.json(await addWatch({ mediaType: mediaType(b.mediaType), tmdbId: int(b.tmdbId, 'tmdbId'), season: optInt(b.season, 'season'), episode: optInt(b.episode, 'episode'), reason: 'release' }));
});

app.delete('/api/watch/:key', adultsOnly, (req, res) => {
  removeWatch(String(req.params.key));
  res.json({ ok: true });
});

app.post('/api/watching/:key/seen', adultsOnly, (req, res) => {
  markSeen(String(req.params.key));
  res.json({ ok: true });
});

/** Playing/downloading a theater copy: start looking for a proper version in the background. */
function watchForUpgrade(type: MediaType, tmdbId: number, infoHash: string, releaseTitle: string, season?: number, episode?: number) {
  const theater = !!parseRelease(releaseTitle).theater || Object.values(db.verdicts).some((v) => v.infoHash === infoHash && v.outcome === 'theater');
  if (theater) addWatch({ mediaType: type, tmdbId, season, episode, reason: 'upgrade', currentInfoHash: infoHash }).catch(() => {});
}

app.post('/api/play', async (req, res) => {
  const b = req.body as {
    mediaType: MediaType;
    tmdbId: number;
    season?: number;
    episode?: number;
    source?: SavedSource;
  };
  const type = mediaType(b.mediaType);
  const tmdbId = int(b.tmdbId, 'tmdbId');
  const season = optInt(b.season, 'season');
  const episode = optInt(b.episode, 'episode');
  await requireAllowed(res, type, tmdbId);
  // Kids just press Play: FreeStream picks a verified source itself (never a theater copy).
  const source = isKid(res) ? await autoSource(type, tmdbId, season, episode) : b.source || sourceFor(type, tmdbId, season, episode);
  if (!source) throw new HttpError(409, isKid(res) ? 'This one isn’t ready yet — ask a grown-up to set it up.' : 'No source chosen yet.');

  const t = await addSource(source, await titleFor(type, tmdbId));
  const fileIdx = pickFile(t, season, episode);
  prioritizeEdges(t, fileIdx);
  markPlayed(t.infoHash);
  rememberFile(t, fileIdx, { season, episode });
  rememberSource(type, tmdbId, { magnet: source.magnet, downloadUrl: source.downloadUrl, infoHash: t.infoHash, releaseTitle: source.releaseTitle || t.name }, { season, episode, seasonPack: isSeasonPack(t) });
  watchForUpgrade(type, tmdbId, t.infoHash, source.releaseTitle || t.name, season, episode);
  save();

  const p = profileData(profileOf(res).id).progress[progressKey(type, tmdbId, season, episode)];
  // Resume follows the title, not the exact copy: switching to the downloaded version keeps your place.
  const resumeAt = p && p.position / (p.duration || 1) < FINISHED ? p.position : 0;
  res.json({
    infoHash: t.infoHash,
    fileIdx,
    fileName: t.files[fileIdx].name,
    subtitles: subtitlesFor(t, fileIdx),
    resumeAt,
  });
});

/**
 * Opens a source just far enough to preview it: fetches the file list and picks the video,
 * but doesn't remember the source or start downloading the whole file.
 */
app.post('/api/preview', adultsOnly, async (req, res) => {
  const b = req.body as { source?: SavedSource; season?: number; episode?: number; mediaType?: MediaType; tmdbId?: number };
  if (!b.source) throw new HttpError(400, 'source is required');
  const named = b.mediaType && b.tmdbId ? await titleFor(mediaType(b.mediaType), int(b.tmdbId, 'tmdbId')) : {};
  const t = await addSource(b.source, { preview: true, ...named });
  const fileIdx = pickFile(t, optInt(b.season, 'season'), optInt(b.episode, 'episode'));
  prioritizeEdges(t, fileIdx);
  const file = t.files[fileIdx];
  res.json({ infoHash: t.infoHash, fileIdx, fileName: file.name, fileSize: file.length, subtitles: subtitlesFor(t, fileIdx), resumeAt: 0 });
});

app.delete('/api/preview/:hash', async (req, res) => {
  res.json({ discarded: await discardPreview(hash(req.params.hash)) });
});

/** Download button: fetch the whole file in the background without playing it. */
app.post('/api/download', adultsOnly, async (req, res) => {
  const b = req.body as { mediaType: MediaType; tmdbId: number; season?: number; episode?: number; source?: SavedSource };
  const type = mediaType(b.mediaType);
  const tmdbId = int(b.tmdbId, 'tmdbId');
  const season = optInt(b.season, 'season');
  const episode = optInt(b.episode, 'episode');
  const source = b.source || sourceFor(type, tmdbId, season, episode);
  if (!source) throw new HttpError(409, 'No source chosen yet.');

  const t = await addSource(source, await titleFor(type, tmdbId));
  const fileIdx = pickFile(t, season, episode);
  const status = startDownload(t, fileIdx, { season, episode });
  rememberSource(type, tmdbId, { magnet: source.magnet, downloadUrl: source.downloadUrl, infoHash: t.infoHash, releaseTitle: source.releaseTitle || t.name }, { season, episode, seasonPack: isSeasonPack(t) });
  watchForUpgrade(type, tmdbId, t.infoHash, source.releaseTitle || t.name, season, episode);
  save();
  res.json({ status, infoHash: t.infoHash, fileIdx, fileName: t.files[fileIdx].name });
});

/** Title page opened: connect to the remembered source's peers now, so Play starts faster. */
app.post('/api/prewarm', async (req, res) => {
  const b = req.body as { mediaType: MediaType; tmdbId: number; season?: number; episode?: number };
  const type = mediaType(b.mediaType);
  const tmdbId = int(b.tmdbId, 'tmdbId');
  const source = sourceFor(type, tmdbId, optInt(b.season, 'season'), optInt(b.episode, 'episode'));
  if (source) prewarm(source, await titleFor(type, tmdbId));
  res.json({ ok: !!source });
});

/** Forget the remembered source (e.g. it doesn't play) so the user can pick another. */
app.delete('/api/sources/:type/:id', adultsOnly, (req, res) => {
  const type = mediaType(req.params.type);
  const id = int(req.params.id, 'id');
  const season = optInt(req.query.season, 'season');
  const episode = optInt(req.query.episode, 'episode');
  if (type === 'tv' && season != null && episode != null) {
    // Just this episode. The season's pack stays for the other episodes, unless it's this episode's single file.
    const own = db.sources[episodeSourceKey(id, season, episode)];
    delete db.sources[episodeSourceKey(id, season, episode)];
    const seasonSrc = db.sources[sourceKey('tv', id, season)];
    if (seasonSrc && (!own || own.infoHash === seasonSrc.infoHash) && !parseRelease(seasonSrc.releaseTitle).pack) delete db.sources[sourceKey('tv', id, season)];
  } else delete db.sources[sourceKey(type, id, season)];
  save();
  res.json({ ok: true });
});

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.wmv': 'video/x-ms-wmv',
};

app.get('/api/stream/:hash/:idx', async (req, res) => {
  const infoHash = hash(req.params.hash);
  const t = await getTorrent(infoHash);
  const file = t.files[int(req.params.idx, 'file')];
  if (!file) throw new HttpError(404, 'No such file');

  const size = file.length;
  let start = 0;
  let end = size - 1;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (!m[1] && !m[2])) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(m[2])); // suffix range: last N bytes
    }
    if (start >= size || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', MIME[extname(file.name).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Content-Length', String(end - start + 1));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  // Watching: keep fetching the rest of the file in the background, in order.
  // Previewing: fetch only the byte ranges the player asks for.
  if (req.query.preview === undefined) file.select();
  streamOpened(infoHash);
  const started = Date.now();
  let sent = 0;
  const source = file.createReadStream({ start, end });
  source.on('data', (c: Buffer) => (sent += c.length));
  try {
    await pipeline(source, res);
  } catch {
    // Players abort range requests constantly when seeking; that's normal.
  } finally {
    streamClosed(infoHash);
    const ms = Date.now() - started;
    // Log substantial responses so slow playback can be diagnosed (who, how much, how fast).
    if (sent > 4 * 1024 * 1024 || ms > 10000) {
      const ua = String(req.headers['user-agent'] || '');
      const device = /web0s|webos|smart-?tv/i.test(ua) ? 'TV' : /android|iphone|ipad/i.test(ua) ? 'phone' : 'browser';
      console.log(`[stream] ${device} ${file.name.slice(0, 40)} from ${(start / 1e6).toFixed(0)}MB: ${(sent / 1e6).toFixed(1)}MB in ${(ms / 1000).toFixed(1)}s = ${((sent / 1e6) / Math.max(ms / 1000, 0.001)).toFixed(2)} MB/s`);
    }
  }
});

app.get('/api/subs/:hash/:idx', async (req, res) => {
  const t = await getTorrent(hash(req.params.hash));
  const idx = int(String(req.params.idx).replace(/\.vtt$/, ''), 'file');
  const text = await readFileText(t, idx);
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  const vtt = t.files[idx].name.toLowerCase().endsWith('.vtt') ? text : srtToVtt(text);
  // Converted streams start mid-file; their subtitles are shifted to match.
  const offset = Number(req.query.offset) || 0;
  res.send(offset > 0 ? shiftVtt(vtt, offset) : vtt);
});

/** Real codecs of a file, so the player can decide between direct play and conversion. */
app.get('/api/media/:hash/:idx', async (req, res) => {
  const t = await getTorrent(hash(req.params.hash));
  const idx = int(req.params.idx, 'file');
  if (!t.files[idx]) throw new HttpError(404, 'No such file');
  if (!hasFfmpeg) return void res.json({ canConvert: false, info: null });
  try {
    res.json({ canConvert: true, info: await mediaInfo(t.infoHash, idx, t.files[idx].name, req.query.preview !== undefined) });
  } catch (e) {
    res.json({ canConvert: true, info: null, error: (e as Error).message });
  }
});

/** Where a copied-video conversion starting near `at` really starts (the keyframe at or before it). */
app.get('/api/convert/:hash/:idx/start', async (req, res) => {
  const t = await getTorrent(hash(req.params.hash));
  const idx = int(req.params.idx, 'file');
  if (!t.files[idx]) throw new HttpError(404, 'No such file');
  const at = Math.max(0, Number(req.query.at) || 0);
  res.json({ start: hasFfmpeg ? await keyframeAt(t.infoHash, idx, at, req.query.preview !== undefined) : at });
});

/** Live ffmpeg conversion to fragmented MP4: AAC audio, video copied or re-encoded to H.264. */
app.get('/api/convert/:hash/:idx', async (req, res) => {
  if (!hasFfmpeg) throw new HttpError(501, 'ffmpeg isn’t installed on the server, so files can’t be converted.');
  const t = await getTorrent(hash(req.params.hash));
  const idx = int(req.params.idx, 'file');
  if (!t.files[idx]) throw new HttpError(404, 'No such file');
  const preview = req.query.preview !== undefined;
  const info = await mediaInfo(t.infoHash, idx, t.files[idx].name, preview).catch(() => null);
  await transcode(req, res, {
    infoHash: t.infoHash,
    fileIdx: idx,
    start: Math.max(0, Number(req.query.start) || 0),
    video: req.query.video === 'h264' ? 'h264' : 'copy',
    audioTrack: Math.max(0, optInt(req.query.audio, 'audio') || 0),
    videoCodec: info?.videoCodec || '',
    interlaced: !!info?.interlaced,
    videoDelaySec: info?.videoDelaySec || 0,
    preview,
    audioCodec: req.query.acodec === 'ac3' ? 'ac3' : 'aac',
    audioChannels: info?.audio[Math.max(0, optInt(req.query.audio, 'audio') || 0)]?.channels || 2,
  });
});

app.get('/api/torrents/:hash/status', async (req, res) => {
  const s = await statusOf(hash(req.params.hash), optInt(req.query.file, 'file'));
  if (!s) throw new HttpError(404, 'Unknown torrent');
  res.json(s);
});

// --- progress & my list -----------------------------------------------------------------

app.post('/api/progress', (req, res) => {
  const b = req.body as Progress;
  const type = mediaType(b.mediaType);
  const tmdbId = int(b.tmdbId, 'tmdbId');
  const season = optInt(b.season, 'season');
  const episode = optInt(b.episode, 'episode');
  const p: Progress = {
    mediaType: type,
    tmdbId,
    season,
    episode,
    episodeTitle: b.episodeTitle,
    title: String(b.title || ''),
    posterPath: b.posterPath ?? null,
    backdropPath: b.backdropPath ?? null,
    position: Math.max(0, Number(b.position) || 0),
    duration: Math.max(0, Number(b.duration) || 0),
    infoHash: hash(b.infoHash),
    fileIdx: int(b.fileIdx, 'fileIdx'),
    updatedAt: Date.now(),
  };
  profileData(profileOf(res).id).progress[progressKey(type, tmdbId, season, episode)] = p;
  save();
  res.json({ ok: true });
});

app.delete('/api/progress/:type/:id', (req, res) => {
  const type = mediaType(req.params.type);
  const id = int(req.params.id, 'id');
  const progress = profileData(profileOf(res).id).progress;
  for (const [k, p] of Object.entries(progress)) if (p.mediaType === type && p.tmdbId === id) delete progress[k];
  save();
  res.json({ ok: true });
});

app.post('/api/list', (req, res) => {
  const b = req.body as MediaRef;
  const type = mediaType(b.mediaType);
  const tmdbId = int(b.tmdbId, 'tmdbId');
  const data = profileData(profileOf(res).id);
  if (!data.myList.some((m) => m.mediaType === type && m.tmdbId === tmdbId)) {
    data.myList.unshift({ mediaType: type, tmdbId, title: String(b.title || ''), posterPath: b.posterPath ?? null, backdropPath: b.backdropPath ?? null, addedAt: Date.now() });
    save();
  }
  res.json({ ok: true });
});

app.delete('/api/list/:type/:id', (req, res) => {
  const type = mediaType(req.params.type);
  const id = int(req.params.id, 'id');
  const data = profileData(profileOf(res).id);
  data.myList = data.myList.filter((m) => !(m.mediaType === type && m.tmdbId === id));
  save();
  res.json({ ok: true });
});

// --- downloads ---------------------------------------------------------------------------

app.get('/api/downloads', adultsOnly, async (req, res) => {
  const filter = req.query.type ? { mediaType: mediaType(req.query.type), tmdbId: int(req.query.id, 'id') } : undefined;
  res.json({ downloads: await listDownloads(filter), cacheLimitGb: getSettings().cacheLimitGb });
});

app.post('/api/downloads/:hash/keep', adultsOnly, (req, res) => {
  setKept(hash(req.params.hash), !!(req.body as { kept?: boolean }).kept);
  res.json({ ok: true });
});

/** "Save to this device": sends the finished video as a browser download. */
app.get('/api/downloads/:hash/file', adultsOnly, (req, res) => {
  const f = finishedFilePath(hash(req.params.hash), int(req.query.file, 'file'));
  res.download(f.path, f.name, { dotfiles: 'allow' });
});

app.delete('/api/downloads/:hash', adultsOnly, async (req, res) => {
  const file = optInt(req.query.file, 'file');
  if (file != null) await deleteDownloadFile(hash(req.params.hash), file);
  else await deleteDownload(hash(req.params.hash));
  res.json({ ok: true });
});

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

// --- web app -----------------------------------------------------------------------------

if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST, { index: false, maxAge: '7d', setHeaders: (res, p) => p.endsWith('.html') && res.setHeader('Cache-Control', 'no-cache') }));
  app.get('/{*splat}', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(WEB_DIST, 'index.html'));
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => {
  const known = err instanceof HttpError || err instanceof TorrentError || err instanceof IndexerError || err instanceof tmdb.TmdbError || err instanceof ProfileError;
  const status = known ? (err.status ?? 500) : 500;
  if (!known) console.error(`[api] ${req.method} ${req.path}:`, err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: known ? err.message : 'Something went wrong on the server.', code: err instanceof ProfileError ? err.code : undefined });
});

/** Works out which catalog title an older download belongs to. */
async function resolveDownloadTitle(d: CachedDownload): Promise<{ mediaType: MediaType; tmdbId: number; title?: string } | null> {
  const fromSource = Object.entries(db.sources).find(([, src]) => src.infoHash === d.infoHash)?.[0];
  const fromProgress = allProgress().find((p) => p.infoHash === d.infoHash);
  const [type, id] = fromSource ? fromSource.split(':') : fromProgress ? [fromProgress.mediaType, String(fromProgress.tmdbId)] : [];
  if ((type === 'movie' || type === 'tv') && Number(id)) {
    const t = await titleFor(type, Number(id));
    return { mediaType: type, tmdbId: Number(id), title: t.title };
  }
  // Otherwise search TMDB for the title in the release name ("The.Odyssey.2026.1080p…").
  const guess = guessTitle(d.name);
  if (!guess) return null;
  const m = guess.match(/^(.*?)(?: \((\d{4})\))?$/);
  const name = m?.[1] || guess;
  const year = m?.[2];
  const wantTv = /\bS\d{1,2}(E\d{1,3})?\b/i.test(d.name);
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const hits = (await tmdb.search(name)).results.filter((r) => norm(r.title) === norm(name) && (!year || r.year === year) && (!wantTv || r.mediaType === 'tv'));
  const hit = hits[0];
  return hit ? { mediaType: hit.mediaType, tmdbId: hit.id, title: hit.year ? `${hit.title} (${hit.year})` : hit.title } : null;
}

setSelfBaseUrl(`http://127.0.0.1:${PORT}`);
setTranscodeBaseUrl(`http://127.0.0.1:${PORT}`);
startWatcher();
startSuggestions();
startDoctor();

// Theater copies chosen before upgrade-watching existed: start looking for proper versions of those too.
setTimeout(() => {
  for (const [key, src] of Object.entries(db.sources)) {
    const [type, id, s] = key.split(':');
    if ((type !== 'movie' && type !== 'tv') || !src.infoHash || !parseRelease(src.releaseTitle).theater) continue;
    if (Object.values(db.watches).some((w) => w.reason === 'upgrade' && w.tmdbId === Number(id) && w.currentInfoHash === src.infoHash)) continue;
    const season = s ? Number(s.slice(1)) : undefined;
    addWatch({ mediaType: type, tmdbId: Number(id), season, reason: 'upgrade', currentInfoHash: src.infoHash }).catch(() => {});
  }
}, 10000);

const server = app.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);
  console.log(`\nFreeStream is running`);
  if (existsSync('/.dockerenv')) {
    // Inside Docker we only see the container's internal IP, which the TV can't use.
    const port = process.env.HOST_PORT || PORT;
    console.log(`  This Mac:     http://localhost:${port}`);
    console.log(`  On your Wi-Fi: http://<this Mac's Wi-Fi IP>:${port}   (find it with: ipconfig getifaddr en0)`);
  } else {
    console.log(`  This Mac:     http://localhost:${PORT}`);
    for (const ip of ips) console.log(`  On your Wi-Fi: http://${ip}:${PORT}`);
  }
  console.log(`  Data:         ${DATA_DIR}`);
  console.log(`  Downloads:    ${getSettings().downloadDir}\n`);
  migrateLegacyFolders(async (infoHash) => {
    // Work out which title an old download belongs to from the remembered sources / watch progress.
    const d = db.downloads[infoHash];
    const fromSource = Object.entries(db.sources).find(([, src]) => src.infoHash === infoHash)?.[0];
    const fromProgress = allProgress().find((p) => p.infoHash === infoHash);
    const [type, id] = d?.mediaType ? [d.mediaType, String(d.tmdbId)] : fromSource ? fromSource.split(':') : fromProgress ? [fromProgress.mediaType, String(fromProgress.tmdbId)] : [];
    if (type === 'movie' || type === 'tv') {
      const found = (await titleFor(type, Number(id))).folder;
      if (found) return found;
    }
    // Fall back to the release name: "The.Odyssey.2026.1080p…" -> "The Odyssey (2026)".
    return d ? guessTitle(d.name) : null;
  })
    .then(() => backfillTitles(resolveDownloadTitle))
    .then(resumeDownloads)
    .catch((e) => console.error('[startup]', e));
  if (!existsSync(WEB_DIST)) console.log('  (web app not built — use `npm run dev` and open the Vite URL, or run `npm start`)\n');
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.log('\nShutting down…');
  saveAllBitfields();
  flush();
  server.close();
  await Promise.race([shutdown(), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
