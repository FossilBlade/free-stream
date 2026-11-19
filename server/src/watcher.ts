/**
 * Watches titles in the background:
 *  - "release": not out yet (or only in theaters) -> find a proper release once it's out.
 *  - "upgrade": you're on a theater/low copy -> find a proper one.
 * Candidates go through the deep check; only "verified" ones count as found.
 */
import { searchReleases, type Release } from './indexers.ts';
import { parseRelease } from './release.ts';
import { db, getSettings, save, sourceKey, type MediaType, type SavedSource, type Watch } from './store.ts';
import * as tmdb from './tmdb.ts';
import { addSource, pickFile, startDownload } from './torrents.ts';
import { deepCheck, verdictForHash } from './verify.ts';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const GIVE_UP_AFTER = 60 * DAY;
const MAX_CANDIDATES = 3;
const PLAY_RANK = { good: 0, ok: 1, risky: 2 } as const;

export const watchKey = (mediaType: MediaType, tmdbId: number, season?: number, episode?: number) =>
  mediaType === 'tv' && season != null && episode != null ? `tv:${tmdbId}:s${season}e${episode}` : `${mediaType}:${tmdbId}`;

export function getWatch(mediaType: MediaType, tmdbId: number, season?: number, episode?: number): Watch | undefined {
  return db.watches[watchKey(mediaType, tmdbId, season, episode)];
}

export async function addWatch(p: { mediaType: MediaType; tmdbId: number; season?: number; episode?: number; reason: Watch['reason']; currentInfoHash?: string }): Promise<Watch> {
  const key = watchKey(p.mediaType, p.tmdbId, p.season, p.episode);
  const existing = db.watches[key];
  if (existing && existing.status !== 'gave-up' && existing.reason === p.reason) return existing;
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
    createdAt: Date.now(),
    nextCheck: Date.now(), // check soon
    checks: 0,
    status: 'waiting',
    note: p.reason === 'upgrade' ? 'Looking for a better version…' : 'Waiting for release…',
  };
  db.watches[key] = w;
  save();
  setTimeout(tick, 2000); // don't wait for the next interval
  return w;
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

async function process(w: Watch): Promise<void> {
  w.lastChecked = Date.now();
  w.checks++;
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
      if (getSettings().watchAutoDownload) {
        const t = await addSource(w.found.source, { mediaType: w.mediaType, tmdbId: w.tmdbId, title: d.year ? `${d.title} (${d.year})` : d.title });
        startDownload(t, pickFile(t, w.season, w.episode), { season: w.season, episode: w.episode });
        db.sources[sourceKey(w.mediaType, w.tmdbId, w.season)] = w.found.source;
        w.downloaded = true;
        w.note = `Found and downloading: ${v.label}`;
      }
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

let running = false;
async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const due = Object.values(db.watches).filter((w) => w.status === 'waiting' && w.nextCheck <= Date.now());
    for (const w of due) {
      try {
        await process(w);
      } catch (e) {
        console.error(`[watch] ${w.title}:`, (e as Error).message);
        schedule(w, 6 * HOUR, 'Check failed — will retry');
      }
      save();
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
 * Kids' "just Play": a remembered source if it's a proper release, otherwise the best candidate
 * that passes the deep check (never a theater copy). Null when nothing suitable exists yet.
 */
export async function autoSource(type: MediaType, tmdbId: number, season?: number, episode?: number): Promise<SavedSource | null> {
  const key = sourceKey(type, tmdbId, season);
  const saved = db.sources[key];
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
      db.sources[key] = chosen;
      save();
      return chosen;
    } catch {
      /* try the next one */
    }
  }
  return null;
}
