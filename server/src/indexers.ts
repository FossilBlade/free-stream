import { parseRelease, playability, stripSiteTag, type Playability, type ReleaseInfo } from './release.ts';
import { db, getSettings, save, type MediaType } from './store.ts';

export interface Release {
  title: string;
  indexer: string;
  size: number;
  seeders: number;
  leechers: number;
  magnet?: string;
  downloadUrl?: string;
  infoHash?: string;
  publishDate?: string;
  info: ReleaseInfo;
  playability: Playability;
  /** full = proper release; theater = camera/screener copy (shown separately). */
  tier: 'full' | 'theater';
  /** Size for its resolution and runtime: small = probably a poor re-encode or fake; large = slow to stream. */
  sizeFlag: 'small' | 'large' | null;
}

export interface SearchRequest {
  mediaType: MediaType;
  title: string;
  year?: string;
  season?: number;
  episode?: number;
  /** Runtime in minutes (TMDB), to spot files far too small to be the whole thing. */
  runtime?: number | null;
  /** All plausible release years (festival premiere, theatrical, digital). Releases may use any of them. */
  years?: string[];
  /** Other names to try when the main title finds nothing (original-language title, alternative titles). */
  altTitles?: string[];
  /** Preferred audio languages by name, e.g. ["English", "Hindi"]. */
  preferLanguages?: string[];
  /** Vertical resolution of the screen it'll be watched on (2160, 1080, 720). Bigger files than that are wasted bandwidth. */
  screen?: number;
  /** False when the device can't decode Dolby (AC3/E-AC3) audio, e.g. Chrome on a computer. */
  dolby?: boolean;
  /** ffmpeg is available: audio the device can't decode gets converted on the fly. */
  canConvert?: boolean;
}

export class IndexerError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

const cleanTitle = (t: string) => t.replace(/[:'’!?,.]/g, '').replace(/&/g, 'and').replace(/\s+/g, ' ').trim();

/** Queries to run, most specific first. Results are merged and de-duplicated. */
function queries(req: SearchRequest): string[] {
  const clean = cleanTitle(req.title);
  // Every known release year at once (festival premiere vs wide release often differ for Indian films).
  if (req.mediaType === 'movie') return req.year ? [...new Set([req.year, ...(req.years || [])])].map((y) => `${clean} ${y}`) : [clean];
  if (req.season != null && req.episode != null) return [`${clean} S${pad(req.season)}E${pad(req.episode)}`, `${clean} S${pad(req.season)}`];
  if (req.season != null) return [`${clean} S${pad(req.season)}`];
  return [clean];
}

/** Second round when the first finds nothing: no year (Indian releases often use a different one), then other titles. */
function fallbackQueries(req: SearchRequest): string[] {
  const out = new Set<string>();
  const add = (t: string) => {
    const c = cleanTitle(t);
    if (!c) return;
    if (req.mediaType === 'movie') out.add(c);
    else if (req.season != null) out.add(`${c} S${pad(req.season)}`);
    else out.add(c);
  };
  if (req.mediaType === 'movie') {
    if (req.year) add(req.title); // no year at all
  }
  for (const t of req.altTitles || []) add(t);
  for (const q of queries(req)) out.delete(q);
  return [...out].slice(0, 3);
}

/** Newznab category ids: 2000 = Movies, 5000 = TV. */
const categoryFor = (t: MediaType) => (t === 'movie' ? 2000 : 5000);

interface RawResult {
  title: string;
  indexer: string;
  size: number;
  seeders: number;
  leechers: number;
  magnet?: string;
  downloadUrl?: string;
  infoHash?: string;
  publishDate?: string;
}

async function getJson<T>(url: URL, headers: Record<string, string> = {}, timeoutMs = 45000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const s = getSettings();
    const name = (e as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new IndexerError(`timed out after ${Math.round(timeoutMs / 1000)}s`, 504);
    throw new IndexerError(`Could not reach ${s.indexerType} at ${s.indexerUrl}. Is it running? (${(e as Error).message})`);
  }
  if (res.status === 401 || res.status === 403) throw new IndexerError('Indexer rejected the API key. Check it on the Settings page.', 412);
  if (!res.ok) throw new IndexerError(`Indexer error ${res.status}`);
  return (await res.json()) as T;
}

/** Each indexer gets this long; slow ones are skipped so they can't hold up the rest. */
const PER_INDEXER_TIMEOUT_MS = 25000;

let indexerCache: { at: number; list: { id: number; name: string }[] } | null = null;

async function prowlarrIndexers(): Promise<{ id: number; name: string }[]> {
  if (indexerCache && Date.now() - indexerCache.at < 60000) return indexerCache.list;
  const s = getSettings();
  const all = await getJson<{ id: number; name: string; enable: boolean; protocol: string }[]>(new URL(`${s.indexerUrl}/api/v1/indexer`), { 'X-Api-Key': s.indexerApiKey }, 15000);
  const list = all.filter((i) => i.enable && i.protocol !== 'usenet').map((i) => ({ id: i.id, name: i.name }));
  indexerCache = { at: Date.now(), list };
  return list;
}

async function prowlarrOne(indexerId: number, query: string, type: MediaType): Promise<RawResult[]> {
  const s = getSettings();
  const url = new URL(`${s.indexerUrl}/api/v1/search`);
  url.searchParams.set('query', query);
  url.searchParams.set('type', 'search');
  url.searchParams.append('categories', String(categoryFor(type)));
  url.searchParams.append('indexerIds', String(indexerId));
  url.searchParams.set('limit', '100');
  const data = await getJson<
    { title: string; indexer: string; size: number; seeders?: number; leechers?: number; magnetUrl?: string; downloadUrl?: string; infoHash?: string; publishDate?: string; protocol?: string }[]
  >(url, { 'X-Api-Key': s.indexerApiKey }, PER_INDEXER_TIMEOUT_MS);
  return data
    .filter((r) => r.protocol !== 'usenet')
    .map((r) => ({
      title: r.title,
      indexer: r.indexer,
      size: r.size,
      seeders: r.seeders ?? 0,
      leechers: r.leechers ?? 0,
      magnet: r.magnetUrl?.startsWith('magnet:') ? r.magnetUrl : undefined,
      downloadUrl: r.downloadUrl || (r.magnetUrl && !r.magnetUrl.startsWith('magnet:') ? r.magnetUrl : undefined),
      infoHash: r.infoHash?.toLowerCase(),
      publishDate: r.publishDate,
    }));
}

async function jackett(query: string, type: MediaType): Promise<RawResult[]> {
  const s = getSettings();
  const url = new URL(`${s.indexerUrl}/api/v2.0/indexers/all/results`);
  url.searchParams.set('apikey', s.indexerApiKey);
  url.searchParams.set('Query', query);
  url.searchParams.append('Category[]', String(categoryFor(type)));
  const data = await getJson<{
    Results: { Title: string; Tracker: string; Size: number; Seeders?: number; Peers?: number; MagnetUri?: string | null; Link?: string | null; InfoHash?: string | null; PublishDate?: string }[];
  }>(url, {}, 60000);
  return data.Results.map((r) => ({
    title: r.Title,
    indexer: r.Tracker,
    size: r.Size,
    seeders: r.Seeders ?? 0,
    leechers: Math.max(0, (r.Peers ?? 0) - (r.Seeders ?? 0)),
    magnet: r.MagnetUri || undefined,
    downloadUrl: r.Link || undefined,
    infoHash: r.InfoHash?.toLowerCase() || undefined,
    publishDate: r.PublishDate,
  }));
}

const titleWords = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Words that can directly follow a title in a release name (year, episode, quality, language, source…). */
const AFTER_TITLE =
  /^((19|20)\d{2}|s\d{1,2}(e\d{1,3})?|\d{3,4}p|4k|uhd|hdr|hdr10|dv|hindi|english|tamil|telugu|malayalam|kannada|bengali|marathi|punjabi|korean|japanese|dual|multi|web|webrip|webdl|dl|bluray|blu|brrip|bdrip|hdrip|dvdrip|dvdscr|scr|hdtv|hdcam|cam|camrip|ts|tc|hdts|hdtc|pre|predvd|hq|complete|season|extended|unrated|remastered|directors|imax|proper|repack|limited|x264|x265|h264|h265|hevc|avc|aac|ac3|ddp|dd5|eac3|esub|esubs|msubs|org|original|true|uncut|theatrical|amzn|nf|zee5|hotstar|jiohotstar|sonyliv|jc|10bit|8bit|series|episode|e\d{1,3}|ep\d{1,3}|vol|volume|mini|miniseries)$/;

/** Drops results that don't match the requested title/episode, so "Mrs" doesn't match "Mrs Doubtfire". */
function matches(r: Release, req: SearchRequest, titles: string[]): boolean {
  // The release name must START with the title (after any site tag), so "Mrs" never matches "And Mrs".
  const got = titleWords(stripSiteTag(r.title));
  const ok = titles.some((t) => {
    const want = titleWords(t);
    if (!want || !(got === want || got.startsWith(want + ' '))) return false;
    const next = got.slice(want.length).trim().split(' ')[0] || '';
    return next === '' || AFTER_TITLE.test(next);
  });
  if (!ok) return false;
  if (r.info.extra) return false;
  if (tooSmall(r, req)) return false;
  if (req.mediaType === 'movie') {
    if (r.info.season != null) return false;
    const years = (req.years?.length ? req.years : req.year ? [req.year] : []).map(Number);
    const named = (r.title.match(/\b(19|20)\d{2}\b/g) || []).map(Number);
    if (years.length && named.length && !named.some((x) => years.some((y) => Math.abs(x - y) <= 1))) return false;
    return true;
  }
  if (req.season == null) return true;
  if (r.info.season != null && r.info.season !== req.season && !r.info.pack) return false;
  if (req.episode != null && r.info.episode != null && r.info.episode !== req.episode) return false;
  return true;
}

/**
 * A 2-hour film is ~1.5-15 GB at 1080p. Anything under ~1.5 MB per minute of runtime is a fake,
 * a sample, or a junk re-encode. Season packs are skipped (their size covers many episodes).
 */
function tooSmall(r: Release, req: SearchRequest): boolean {
  if (!req.runtime || r.info.pack || !r.size) return false;
  return r.size < req.runtime * 1.5 * 1024 * 1024;
}

const RES_HEIGHT: Record<string, number> = { '2160p': 2160, '1080p': 1080, '720p': 720, '480p': 480 };
const RES_SCORE: Record<string, number> = { '2160p': 3, '1080p': 4, '720p': 2, '480p': 1 };
const PLAY_SCORE: Record<Playability, number> = { good: 3, ok: 2, risky: 0 };

/** 0-5: how well the resolution suits the screen. Above the screen's resolution is extra data you can't see. */
export function resolutionFit(res: string | null, screen?: number): number {
  const h = RES_HEIGHT[res || ''];
  if (!h) return 0;
  if (!screen) return RES_SCORE[res!] || 0;
  if (h === screen) return 5;
  if (h > screen) return 2;
  return h >= screen / 2 ? 3 : 1; // 1080p on a 4K screen, 720p on a 1080p one
}

/** True when only the audio stops this release playing directly on the device (fixable by converting the audio). */
export function audioNeedsConversion(r: Pick<Release, 'info'>, dolby?: boolean): boolean {
  const videoOk = r.info.codec !== 'AV1' && r.info.codec !== 'XviD' && r.info.source !== 'Remux';
  const dts = r.info.audio === 'DTS' || r.info.audio === 'TrueHD';
  const dolbyHere = dolby === false && (r.info.audio === 'AC3' || r.info.audio === 'EAC3');
  return videoOk && (dts || dolbyHere);
}

/** Playability on this device: audio it can't decode fails, unless the server can convert it. */
export function devicePlayability(r: Pick<Release, 'playability' | 'info'>, dolby?: boolean, canConvert?: boolean): Playability {
  if (audioNeedsConversion(r, dolby)) return canConvert ? 'ok' : 'risky';
  return r.playability;
}

/** Normal megabytes per minute of runtime for each resolution (H.264 or HEVC, WEB or BluRay; remuxes count as large). */
const SIZE_RANGE: Record<string, [number, number]> = { '2160p': [25, 300], '1080p': [7, 160], '720p': [3.5, 60], '480p': [2, 30] };

export function sizeFlag(r: { size: number; info: ReleaseInfo }, runtime?: number | null): Release['sizeFlag'] {
  const range = SIZE_RANGE[r.info.resolution || ''];
  if (!range || !runtime || !r.size || r.info.pack) return null;
  const mbPerMin = r.size / 1024 / 1024 / runtime;
  return mbPerMin < range[0] ? 'small' : mbPerMin > range[1] ? 'large' : null;
}

/** Seeders dominate (streaming needs peers), nudged by playability on this device, resolution for this screen, size and language. */
export function score(r: Release, req: SearchRequest): number {
  const seeds = Math.log2(1 + r.seeders) * 10;
  const exactEpisode = req.episode != null && r.info.episode === req.episode ? 8 : 0;
  // Audio in a language you watch beats unknown/other dubs.
  const langBonus = req.preferLanguages?.length && r.info.languages.some((l) => req.preferLanguages!.includes(l)) ? 8 : 0;
  const theaterPenalty = r.tier === 'theater' ? 100 : 0; // full releases always rank above theater copies
  const sizePenalty = r.sizeFlag === 'small' ? 12 : r.sizeFlag === 'large' ? 6 : 0;
  return seeds + PLAY_SCORE[devicePlayability(r, req.dolby, req.canConvert)] * 6 + resolutionFit(r.info.resolution, req.screen) * 3 + exactEpisode + langBonus - sizePenalty - theaterPenalty;
}

/** Remembers whether each indexer answered (one entry per search, last 10 kept) for the health check. */
function recordIndexerHealth(results: { label: string; result: PromiseSettledResult<unknown> }[]): void {
  const byIndexer = new Map<string, { ok: boolean; error?: string }>();
  for (const { label, result } of results) {
    const cur = byIndexer.get(label) || { ok: false };
    if (result.status === 'fulfilled') cur.ok = true;
    else cur.error ||= (result.reason as Error).message;
    byIndexer.set(label, cur);
  }
  const health = (db.indexerHealth ||= {});
  for (const [name, r] of byIndexer) {
    const h = (health[name] ||= { recent: [], lastAt: 0 });
    h.recent = [...h.recent, r.ok ? 1 : 0].slice(-10);
    h.lastAt = Date.now();
    if (!r.ok) h.lastError = r.error;
  }
  save();
}

export interface SearchResult {
  releases: Release[];
  /** Indexers that failed or were too slow, e.g. "Internet Archive (timed out after 25s)". */
  skipped: string[];
}

export async function searchReleases(req: SearchRequest): Promise<SearchResult> {
  const s = getSettings();
  if (!s.indexerApiKey) throw new IndexerError(`Set your ${s.indexerType} URL and API key on the Settings page to search for sources.`, 412);

  const titles = [req.title, ...(req.altTitles || [])];
  const run = async (qs: string[]) => {
    // One request per (indexer, query) so a slow or broken indexer can't block the others.
    const jobs: { label: string; run: () => Promise<RawResult[]> }[] = [];
    if (s.indexerType === 'jackett') {
      for (const q of qs) jobs.push({ label: 'Jackett', run: () => jackett(q, req.mediaType) });
    } else {
      const indexers = await prowlarrIndexers();
      if (!indexers.length) throw new IndexerError('No indexers are enabled in Prowlarr. Add some under Indexers → Add Indexer.', 412);
      for (const ix of indexers) for (const q of qs) jobs.push({ label: ix.name, run: () => prowlarrOne(ix.id, q, req.mediaType) });
    }
    const settledResults = await Promise.allSettled(jobs.map((j) => j.run()));
    recordIndexerHealth(jobs.map((j, i) => ({ label: j.label, result: settledResults[i] })));
    const skipped = new Set<string>();
    settledResults.forEach((r, i) => {
      if (r.status === 'rejected') skipped.add(`${jobs[i].label} (${(r.reason as Error).message})`);
    });
    const failures = settledResults.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length === settledResults.length) {
      const reason = failures[0].reason as Error;
      throw new IndexerError(`No indexer answered: ${[...skipped].join(', ') || reason.message}`);
    }
    return { raws: settledResults.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])), skipped };
  };

  const collect = (raws: RawResult[], seen: Set<string>, out: Release[]) => {
    for (const raw of raws) {
      if (!raw.magnet && !raw.downloadUrl) continue;
      const key = raw.infoHash || raw.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const info = parseRelease(raw.title);
      const rel: Release = { ...raw, info, playability: playability(info), tier: info.theater ? 'theater' : 'full', sizeFlag: sizeFlag({ size: raw.size, info }, req.runtime) };
      if (rel.seeders > 0 && matches(rel, req, titles)) out.push(rel);
    }
  };

  const seen = new Set<string>();
  const out: Release[] = [];
  const first = await run(queries(req));
  collect(first.raws, seen, out);
  const skipped = first.skipped;
  if (!out.length) {
    const more = fallbackQueries(req);
    if (more.length) {
      const second = await run(more).catch(() => ({ raws: [] as RawResult[], skipped: new Set<string>() }));
      collect(second.raws, seen, out);
      second.skipped.forEach((x) => skipped.add(x));
    }
  }
  return { releases: out.sort((a, b) => score(b, req) - score(a, req)).slice(0, 60), skipped: [...skipped] };
}

export async function testIndexer(): Promise<{ ok: boolean; message: string }> {
  const s = getSettings();
  if (!s.indexerApiKey) return { ok: false, message: 'No API key set.' };
  try {
    const url =
      s.indexerType === 'jackett'
        ? new URL(`${s.indexerUrl}/api/v2.0/indexers/all/results?apikey=${encodeURIComponent(s.indexerApiKey)}&Query=test`)
        : new URL(`${s.indexerUrl}/api/v1/indexer`);
    const data = await getJson<unknown>(url, s.indexerType === 'prowlarr' ? { 'X-Api-Key': s.indexerApiKey } : {});
    if (s.indexerType === 'prowlarr' && Array.isArray(data)) {
      const enabled = data.filter((i: { enable?: boolean }) => i.enable).length;
      return enabled
        ? { ok: true, message: `Connected to Prowlarr: ${enabled} indexer(s) enabled.` }
        : { ok: false, message: 'Connected to Prowlarr, but no indexers are enabled. Add some in Prowlarr.' };
    }
    return { ok: true, message: `Connected to ${s.indexerType}.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
