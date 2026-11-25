/**
 * Watches titles in the background:
 *  - "release": not out yet (or only in theaters) -> find a proper release once it's out.
 *    Episodes from a batch download that had no source use this too, with `download` set.
 *  - "upgrade": you're on a theater/low copy -> find a proper one.
 *  - "follow": a season still airing -> hand each new episode to a download "release" watch as it airs.
 * Candidates go through the deep check; only "verified" ones count as found.
 */
import { searchReleases, type Release } from './indexers.ts';
import { parseRelease } from './release.ts';
import { db, episodeSourceKey, getSettings, rememberSource, save, sourceFor, type MediaType, type SavedSource, type Watch } from './store.ts';
import * as tmdb from './tmdb.ts';
import { addSource, claimEpisodeDownload, downloadState, episodeFile, pickFile, startDownload } from './torrents.ts';
import { deepCheck, verdictForHash } from './verify.ts';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const GIVE_UP_AFTER = 60 * DAY;
const MAX_CANDIDATES = 3;
const PLAY_RANK = { good: 0, ok: 1, risky: 2 } as const;

export const watchKey = (mediaType: MediaType, tmdbId: number, season?: number, episode?: number) =>
  mediaType === 'tv' && season != null && episode != null ? `tv:${tmdbId}:s${season}e${episode}` : `${mediaType}:${tmdbId}`;

/** A season being followed for new episodes (one per season, separate from its episodes' watches). */
export const followKey = (tmdbId: number, season: number) => `tv:${tmdbId}:s${season}:new`;

export function getWatch(mediaType: MediaType, tmdbId: number, season?: number, episode?: number): Watch | undefined {
  return db.watches[watchKey(mediaType, tmdbId, season, episode)];
}

export async function addWatch(p: { mediaType: MediaType; tmdbId: number; season?: number; episode?: number; reason: Watch['reason']; currentInfoHash?: string; download?: boolean; fromEpisode?: number }): Promise<Watch> {
  const key = p.reason === 'follow' ? followKey(p.tmdbId, p.season!) : watchKey(p.mediaType, p.tmdbId, p.season, p.episode);
  const existing = db.watches[key];
  if (existing && existing.status !== 'gave-up' && existing.reason === p.reason) {
    // Asked to download something already being watched for: download it (now, if it was already found).
    if (p.download && !existing.download) {
      existing.download = true;
      if (existing.status === 'found' && existing.found && !existing.downloaded) await downloadFound(existing).catch((e) => console.error(`[watch] ${existing.title}:`, (e as Error).message));
      save();
    }
    return existing;
  }
  const d = await tmdb.details(p.mediaType, p.tmdbId);
  const w: Watch = {
    key,
    mediaType: p.mediaType,
    tmdbId: p.tmdbId,
    title: d.title,
    year: d.year,
    posterPath: d.posterPath,
    backdropPath: d.backdropPath,
    season: p.season,
    episode: p.episode,
    reason: p.reason,
    currentInfoHash: p.currentInfoHash,
    download: p.download || undefined,
    fromEpisode: p.fromEpisode,
    createdAt: Date.now(),
    nextCheck: Date.now(), // check soon
    checks: 0,
    status: 'waiting',
    note: p.reason === 'upgrade' ? 'Looking for a better version…' : p.reason === 'follow' ? 'Downloads new episodes as they air' : p.download ? 'Finding a source to download…' : 'Waiting for release…',
  };
  db.watches[key] = w;
  save();
  kickWatcher(); // don't wait for the next interval
  return w;
}

/** Starts downloading what a watch found, and remembers it as the source. */
async function downloadFound(w: Watch): Promise<void> {
  const d = await tmdb.details(w.mediaType, w.tmdbId);
  const source = w.found!.source;
  const t = await addSource(source, { mediaType: w.mediaType, tmdbId: w.tmdbId, title: d.year ? `${d.title} (${d.year})` : d.title });
  startDownload(t, pickFile(t, w.season, w.episode), { season: w.season, episode: w.episode });
  rememberSource(w.mediaType, w.tmdbId, source, { season: w.season, episode: w.episode, seasonPack: parseRelease(source.releaseTitle).pack });
  w.downloaded = true;
  w.note = `Found and downloading: ${w.found!.label}`;
}

export function removeWatch(key: string): void {
  delete db.watches[key];
  save();
}

export function markSeen(key: string): void {
  const w = db.watches[key];
  if (w) {
    w.seen = true;
    save();
  }
}

const fmtDate = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** Ranks candidates by the user's quality preference, then seeders. */
function preferenceOrder(releases: Release[]): Release[] {
  const s = getSettings();
  const maxBytes = s.watchMaxSizeGb * 1024 ** 3;
  const resRank = (r: Release) => {
    if (s.watchResolution === 'any') return 0;
    if (r.info.resolution === s.watchResolution) return 0;
    const order = ['2160p', '1080p', '720p', '480p'];
    return 1 + Math.abs(order.indexOf(r.info.resolution || '480p') - order.indexOf(s.watchResolution));
  };
  return releases
    .filter((r) => r.tier === 'full' && r.size <= maxBytes)
    // Normal size for its quality, then preferred resolution, then sources that play everywhere (H.264/AAC), then seeders.
    .sort((a, b) => Number(a.sizeFlag === 'small') - Number(b.sizeFlag === 'small') || resRank(a) - resRank(b) || PLAY_RANK[a.playability] - PLAY_RANK[b.playability] || b.seeders - a.seeders);
}

function schedule(w: Watch, ms: number, note: string): void {
  w.nextCheck = Date.now() + ms;
  w.note = note;
}

/**
 * Following a season: each episode that has aired since gets its own download watch (which finds,
 * checks and downloads a source, retrying until one turns up). Ends once the season is over.
 */
async function followSeason(w: Watch): Promise<void> {
  const season = w.season!;
  const [d, eps] = await Promise.all([tmdb.details('tv', w.tmdbId), tmdb.season(w.tmdbId, season)]);
  const today = tmdb.today();
  const list = [...eps].sort((a, b) => a.number - b.number);
  for (const e of list) {
    if (e.number < (w.fromEpisode ?? 1)) continue;
    if (!e.airDate || e.airDate > today) break;
    if (!claimEpisodeDownload(w.tmdbId, season, e.number)) {
      await addWatch({ mediaType: 'tv', tmdbId: w.tmdbId, season, episode: e.number, reason: 'release', download: true });
      console.log(`[watch] ${w.title}: S${season}E${e.number} is out — finding a source`);
    }
    w.fromEpisode = e.number + 1;
  }

  const next = list.find((e) => e.number >= (w.fromEpisode ?? 1));
  if (next) {
    const until = next.airDate ? Math.min(Math.max(Date.parse(next.airDate) - Date.now(), 6 * HOUR), 2 * DAY) : 2 * DAY;
    schedule(w, until, next.airDate ? `Next: episode ${next.number} airs ${fmtDate(next.airDate)}` : `Next: episode ${next.number} (air date not announced)`);
    return;
  }
  // Every listed episode is out. Over when the next episode is in a later season, or a month has
  // passed with nothing new (a break mid-season shows up as listed episodes without dates).
  const lastAired = list.at(-1)?.airDate;
  const over = (d.release.nextEpisode && d.release.nextEpisode.season > season) || !lastAired || Date.parse(lastAired) + 30 * DAY < Date.now();
  if (over) {
    console.log(`[watch] ${w.title}: season ${season} is over — stopped following`);
    delete db.watches[w.key];
    return;
  }
  schedule(w, 2 * DAY, 'All listed episodes are out — checking for more');
}

async function process(w: Watch): Promise<void> {
  w.lastChecked = Date.now();
  w.checks++;
  if (w.reason === 'follow') return followSeason(w);
  // Asked to download an episode that's since been downloaded some other way: nothing left to do.
  if (w.download && w.season != null && w.episode != null && claimEpisodeDownload(w.tmdbId, w.season, w.episode)) {
    delete db.watches[w.key];
    return;
  }
  const d = await tmdb.details(w.mediaType, w.tmdbId);

  // Not out yet: sleep until the expected date (re-checking at least every 2 days in case dates change).
  if (w.reason === 'release') {
    if (w.mediaType === 'movie' && d.release.state !== 'available') {
      const until = d.release.expected ? Math.max(Date.parse(d.release.expected) - Date.now(), 6 * HOUR) : 2 * DAY;
      schedule(w, Math.min(until, 2 * DAY), d.release.state === 'theaters' ? `In theaters — ${d.release.expected ? `digital release expected ${fmtDate(d.release.expected)}` : 'digital release date not announced'}` : `Coming ${d.release.expected ? fmtDate(d.release.expected) : 'soon'}`);
      return;
    }
    if (w.mediaType === 'tv' && w.season != null && w.episode != null) {
      const eps = await tmdb.season(w.tmdbId, w.season).catch(() => []);
      const ep = eps.find((e) => e.number === w.episode);
      if (ep?.airDate && ep.airDate > tmdb.today()) {
        schedule(w, Math.min(Math.max(Date.parse(ep.airDate) - Date.now(), 6 * HOUR), 2 * DAY), `Airs ${fmtDate(ep.airDate)}`);
        return;
      }
    }
  }

  // Out: search and deep-check the best candidates.
  const releases = await searchReleases({ mediaType: w.mediaType, title: d.title, year: d.year, season: w.season, episode: w.episode, runtime: d.runtime });
  const candidates = preferenceOrder(releases.releases).filter((r) => !r.infoHash || r.infoHash !== w.currentInfoHash).slice(0, MAX_CANDIDATES);

  for (const r of candidates) {
    const source: SavedSource = { magnet: r.magnet, downloadUrl: r.downloadUrl, infoHash: r.infoHash, releaseTitle: r.title };
    try {
      const v = await deepCheck({ source, mediaType: w.mediaType, tmdbId: w.tmdbId, season: w.season, episode: w.episode, release: { size: r.size, seeders: r.seeders, indexer: r.indexer } });
      if (v.outcome !== 'verified' || v.infoHash === w.currentInfoHash) continue;
      w.status = 'found';
      w.seen = false;
      w.found = { source: { ...source, infoHash: v.infoHash }, label: v.label, outcome: v.outcome, resolution: r.info.resolution, size: r.size, foundAt: Date.now() };
      w.note = `Found: ${v.label}`;
      console.log(`[watch] ${w.title}: found ${r.title}`);
      if (w.download || getSettings().watchAutoDownload) await downloadFound(w);
      return;
    } catch (e) {
      console.error(`[watch] ${w.title}: couldn't check ${r.title}:`, (e as Error).message);
    }
  }

  const age = Date.now() - w.createdAt;
  if (age > GIVE_UP_AFTER) {
    w.status = 'gave-up';
    w.note = 'No verified release found after 60 days.';
    return;
  }
  schedule(w, age < 7 * DAY ? 6 * HOUR : DAY, candidates.length ? 'Sources found but none verified yet — will check again' : 'No proper release yet — will check again');
}

/**
 * Watches whose find has been downloaded: once the download is finished there's nothing left to show
 * under Watching, so they're removed. One whose download has gone (stopped or deleted by mistake)
 * starts it again from the source it found.
 */
async function tidyDownloaded(): Promise<void> {
  for (const w of Object.values(db.watches)) {
    if (w.status !== 'found' || !w.downloaded || !w.found || w.reason === 'follow') continue;
    const state = downloadState(w.mediaType, w.tmdbId, w.season, w.episode);
    if (state === 'done') {
      delete db.watches[w.key];
      console.log(`[watch] ${w.title}${w.episode != null ? ` S${w.season}E${w.episode}` : ''}: downloaded — done`);
    } else if (!state) {
      console.log(`[watch] ${w.title}${w.episode != null ? ` S${w.season}E${w.episode}` : ''}: its download is gone — starting it again`);
      await downloadFound(w).catch((e) => console.error(`[watch] ${w.title}: couldn't restart the download:`, (e as Error).message));
    }
  }
  save();
}

/** Starts the watcher's next round now (soon), instead of waiting for the interval. */
export function kickWatcher(): void {
  setTimeout(tick, 2000);
}

let running = false;
async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await tidyDownloaded();
    // A few rounds, so watches added meanwhile (a batch download, a followed season's new episode) start now.
    for (let round = 0; round < 5; round++) {
      const due = Object.values(db.watches).filter((w) => w.status === 'waiting' && w.nextCheck <= Date.now());
      if (!due.length) break;
      for (const w of due) {
        if (db.watches[w.key] !== w) continue; // removed meanwhile
        try {
          await process(w);
        } catch (e) {
          console.error(`[watch] ${w.title}:`, (e as Error).message);
          schedule(w, 6 * HOUR, 'Check failed — will retry');
        }
        save();
      }
    }
  } finally {
    running = false;
  }
}

export function startWatcher(): void {
  setInterval(tick, 5 * 60 * 1000).unref();
  setTimeout(tick, 30 * 1000);
}

/**
 * A batch download with no source chosen: look for a season pack first (one torrent for all of it is
 * faster and more reliable than one per episode). Takes the best-ranked packs for this season, checks
 * each against the first wanted episode, and starts every wanted episode the first good one has.
 * Returns the episodes it started; the caller finds the rest one by one.
 */
export async function autoSeasonPack(tmdbId: number, season: number, episodes: number[]): Promise<number[]> {
  if (!episodes.length) return [];
  const d = await tmdb.details('tv', tmdbId);
  const found = await searchReleases({ mediaType: 'tv', title: d.title, year: d.year, season, runtime: d.runtime });
  const packs = preferenceOrder(found.releases.filter((r) => r.info.pack && (r.info.season == null || r.info.season === season))).slice(0, 2);
  for (const r of packs) {
    const source: SavedSource = { magnet: r.magnet, downloadUrl: r.downloadUrl, infoHash: r.infoHash, releaseTitle: r.title };
    try {
      const v = await deepCheck({ source, mediaType: 'tv', tmdbId, season, episode: episodes[0], release: { size: r.size, seeders: r.seeders, indexer: r.indexer } });
      if (v.outcome !== 'verified') continue;
      const chosen = { ...source, infoHash: v.infoHash };
      const t = await addSource(chosen, { mediaType: 'tv', tmdbId, title: d.year ? `${d.title} (${d.year})` : d.title });
      const started: number[] = [];
      for (const e of episodes) {
        const idx = episodeFile(t, season, e, true);
        if (idx == null) continue;
        startDownload(t, idx, { season, episode: e });
        rememberSource('tv', tmdbId, chosen, { season, episode: e, seasonPack: true });
        started.push(e);
      }
      save();
      if (!started.length) continue;
      console.log(`[watch] ${d.title}: season ${season} pack ${r.title} — downloading episodes ${started.join(', ')}`);
      return started;
    } catch (e) {
      console.error(`[watch] ${d.title}: couldn't use season pack ${r.title}:`, (e as Error).message);
    }
  }
  console.log(`[watch] ${d.title}: no good season ${season} pack — finding each episode instead`);
  return [];
}

/**
 * Kids' "just Play": a remembered source if it's a proper release, otherwise the best candidate
 * that passes the deep check (never a theater copy). Null when nothing suitable exists yet.
 */
export async function autoSource(type: MediaType, tmdbId: number, season?: number, episode?: number): Promise<SavedSource | null> {
  let saved = sourceFor(type, tmdbId, season, episode);
  // A season's remembered single-episode torrent can't serve this episode.
  if (saved && type === 'tv' && season != null && episode != null && !db.sources[episodeSourceKey(tmdbId, season, episode)] && !parseRelease(saved.releaseTitle).pack) saved = undefined;
  if (saved?.infoHash) {
    const v = verdictForHash(saved.infoHash);
    if (!parseRelease(saved.releaseTitle).theater && v?.outcome !== 'theater' && v?.outcome !== 'rejected') return saved;
  }
  const d = await tmdb.details(type, tmdbId);
  if (type === 'movie' && d.release.state !== 'available') return null;
  const years = [...new Set([d.year, d.release.theatrical?.slice(0, 4), d.release.digital?.slice(0, 4)].filter((y): y is string => !!y))];
  const found = await searchReleases({ mediaType: type, title: d.title, year: d.year, season, episode, runtime: d.runtime, years });
  for (const r of preferenceOrder(found.releases).slice(0, MAX_CANDIDATES)) {
    const source: SavedSource = { magnet: r.magnet, downloadUrl: r.downloadUrl, infoHash: r.infoHash, releaseTitle: r.title };
    try {
      const v = await deepCheck({ source, mediaType: type, tmdbId, season, episode, release: { size: r.size, seeders: r.seeders, indexer: r.indexer } });
      if (v.outcome !== 'verified') continue;
      const chosen = { ...source, infoHash: v.infoHash };
      rememberSource(type, tmdbId, chosen, { season, episode, seasonPack: r.info.pack });
      save();
      return chosen;
    } catch {
      /* try the next one */
    }
  }
  return null;
}
