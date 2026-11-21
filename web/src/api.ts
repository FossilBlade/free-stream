export type MediaType = 'movie' | 'tv';

export interface Card {
  mediaType: MediaType;
  id: number;
  title: string;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  year: string;
  /** yyyy-mm-dd; in the future = "Coming soon". */
  releaseDate: string;
  rating: number;
  /** Original language, ISO 639-1 (e.g. "hi"). */
  language: string;
}

export interface Profile {
  id: string;
  name: string;
  color: string;
  emoji: string;
  kind: 'adult' | 'kid';
  maxAge?: 7 | 12 | 16;
  languages: string[];
  createdAt: number;
}

export interface Person {
  id: number;
  name: string;
  profilePath: string | null;
  knownFor: string;
}

export interface Row {
  id: string;
  title: string;
  items: Card[];
}

export interface ReleaseStatus {
  state: 'coming' | 'theaters' | 'available';
  theatrical: string | null;
  digital: string | null;
  expected: string | null;
  nextEpisode: { season: number; episode: number; airDate: string; name: string } | null;
}

export interface Details extends Card {
  tagline: string;
  genres: string[];
  runtime: number | null;
  imdbId: string | null;
  cast: string[];
  trailerKey: string | null;
  logoPath: string | null;
  seasons: { number: number; name: string; episodeCount: number; posterPath: string | null }[];
  release: ReleaseStatus;
}

export interface Episode {
  number: number;
  name: string;
  overview: string;
  stillPath: string | null;
  runtime: number | null;
  airDate: string | null;
  progress: number;
  download: EpisodeDownload | null;
  /** The source this episode plays from: its own choice (own) or the season pack. */
  source: { releaseTitle: string; infoHash: string | null; own: boolean } | null;
}

export interface MediaRef {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
}

export interface Progress extends MediaRef {
  season?: number;
  episode?: number;
  episodeTitle?: string;
  position: number;
  duration: number;
  infoHash: string;
  fileIdx: number;
  updatedAt: number;
}

export interface SavedSource {
  magnet?: string;
  downloadUrl?: string;
  infoHash?: string;
  releaseTitle: string;
}

export type Playability = 'good' | 'ok' | 'risky';

export interface Release {
  title: string;
  indexer: string;
  size: number;
  seeders: number;
  leechers: number;
  magnet?: string;
  downloadUrl?: string;
  infoHash?: string;
  info: {
    resolution: string | null;
    codec: string | null;
    source: string | null;
    hdr: string | null;
    audio: string | null;
    season: number | null;
    episode: number | null;
    pack: boolean;
    theater: 'cam' | 'screener' | null;
    languages: string[];
    multiAudio: boolean;
  };
  playability: Playability;
  tier: 'full' | 'theater';
  /** Unusual size for its resolution and runtime: small = likely poor quality or fake; large = slow to stream. */
  sizeFlag: 'small' | 'large' | null;
  /** From an earlier deep check of this source, if any. */
  verdict: { outcome: VerdictOutcome; label: string; summary: string | null; checkedBy: string | null } | null;
  /** The recommended source for this device, and why. */
  best?: boolean;
  pickReason?: string;
}

export type VerdictOutcome = 'verified' | 'theater' | 'suspect' | 'rejected';

export interface Verdict {
  infoHash: string;
  fileIdx: number;
  fileName: string;
  releaseTitle: string;
  checkedAt: number;
  outcome: VerdictOutcome;
  label: string;
  probe: { durationSec: number; width: number; height: number; videoCodec: string; audio: { codec: string; language: string; channels: number }[]; subtitles: string[] } | null;
  runtimeCheck: 'ok' | 'short' | 'long' | 'unknown';
  fileIssues: string[];
  ai: { provider: string; model: string; match: boolean; kind: string; isFullFeature: boolean; quality: string; audioLanguages: string[]; confidence: number; issues: string[]; summary: string; usedFrames: boolean } | null;
  aiError?: string;
}

export interface Watch {
  key: string;
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year: string;
  posterPath: string | null;
  backdropPath: string | null;
  season?: number;
  episode?: number;
  reason: 'release' | 'upgrade';
  createdAt: number;
  lastChecked?: number;
  nextCheck: number;
  status: 'waiting' | 'found' | 'gave-up';
  note: string;
  found?: { source: SavedSource; label: string; outcome: VerdictOutcome; resolution: string | null; size: number; foundAt: number };
  seen?: boolean;
  downloaded?: boolean;
}

export interface PlayInfo {
  infoHash: string;
  fileIdx: number;
  fileName: string;
  subtitles: { idx: number; label: string; lang: string }[];
  resumeAt: number;
}

/** Real codecs of a file (ffprobe), to decide between direct play and conversion. */
export interface MediaInfo {
  durationSec: number;
  videoCodec: string;
  width: number;
  height: number;
  audio: { codec: string; language: string; channels: number; title?: string; default?: boolean }[];
  container: string;
  /** Interlaced (TV broadcast) video: must be re-encoded when converting for a browser. */
  interlaced: boolean;
}

/** Live status of a running torrent (player buffering, preview). */
export interface TorrentStatus {
  infoHash: string;
  name: string;
  active: boolean;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  size: number;
  watching: number;
}

/** One downloaded (or cached) video file: a movie, or one episode. */
export interface DownloadRow {
  infoHash: string;
  fileIdx: number | null;
  releaseName: string;
  fileName: string | null;
  title: string | null;
  mediaType: MediaType | null;
  tmdbId: number | null;
  season: number | null;
  episode: number | null;
  size: number;
  diskBytes: number;
  progress: number;
  complete: boolean;
  requested: boolean;
  downloading: boolean;
  kept: boolean;
  active: boolean;
  watching: number;
  peers: number;
  downloadSpeed: number;
  uploaded: number;
  lastAccess: number;
}

export interface EpisodeDownload {
  infoHash: string;
  fileIdx: number | null;
  progress: number;
  complete: boolean;
  downloading: boolean;
}

export type AiMode = 'off' | 'local' | 'remote' | 'local+remote';
export type RemoteProvider = 'google' | 'anthropic' | 'openai' | 'xai' | 'openrouter' | 'custom';

export interface Settings {
  tmdbApiKey: string;
  indexerType: 'prowlarr' | 'jackett';
  indexerUrl: string;
  indexerApiKey: string;
  downloadDir: string;
  cacheLimitGb: number;
  aiMode: AiMode;
  aiFrames: boolean;
  aiLocalUrl: string;
  aiLocalModel: string;
  aiRemoteProvider: RemoteProvider;
  aiRemoteApiKey: string;
  aiRemoteModel: string;
  aiRemoteBaseUrl: string;
  watchAutoDownload: boolean;
  watchResolution: '2160p' | '1080p' | '720p' | 'any';
  watchMaxSizeGb: number;
  shareUploads: boolean;
  suggestAi: boolean;
  /** Read-only extras from the server. */
  aiProviders?: Record<RemoteProvider, { name: string; defaultModel: string; baseUrl: string }>;
  hasFfmpeg?: boolean;
}

export interface HealthCheck {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

export interface HealthReport {
  at: number;
  status: 'ok' | 'warn' | 'fail';
  checks: HealthCheck[];
}

export interface SuggestionStatus {
  profileId: string;
  name: string;
  builtAt: number | null;
  rows: number;
  basedOn: number;
  ai: { provider: string; model: string; ms: number } | null;
  aiError: string | null;
  building: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Server reason code, e.g. "pin" (parent PIN needed), "kids", "age". */
    readonly code?: string,
  ) {
    super(message);
  }
}

// --- who is asking: the chosen profile (per device) and an unlocked parent session (per tab) ---

const PROFILE_KEY = 'fs-profile';
const PARENT_KEY = 'fs-parent-token';
const safeGet = (store: Storage | undefined, k: string) => {
  try {
    return store?.getItem(k) || '';
  } catch {
    return '';
  }
};
const safeSet = (store: Storage | undefined, k: string, v: string | null) => {
  try {
    if (v == null) store?.removeItem(k);
    else store?.setItem(k, v);
  } catch {
    /* private mode etc. */
  }
};
export const currentProfileId = () => safeGet(window.localStorage, PROFILE_KEY);
export const setCurrentProfileId = (id: string | null) => safeSet(window.localStorage, PROFILE_KEY, id);
export const parentToken = () => safeGet(window.sessionStorage, PARENT_KEY);
export const setParentToken = (t: string | null) => safeSet(window.sessionStorage, PARENT_KEY, t);

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const profile = currentProfileId();
  if (profile) headers['x-profile'] = profile;
  const token = parentToken();
  if (token) headers['x-parent-token'] = token;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError('Cannot reach the FreeStream server. Is it running on the Mac?', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data as { error?: string; code?: string };
    throw new ApiError(d.error || `Request failed (${res.status})`, res.status, d.code);
  }
  return data as T;
}

const get = <T>(p: string) => request<T>('GET', p);
const qs = (o: Record<string, string | number | undefined>) =>
  Object.keys(o)
    .filter((k) => o[k] !== undefined && o[k] !== '')
    .map((k) => `${k}=${encodeURIComponent(String(o[k]))}`)
    .join('&');

export const api = {
  status: () => get<{ tmdbConfigured: boolean; indexerConfigured: boolean; indexerType: string; health: HealthReport['status'] | null }>('/status'),
  health: () => get<HealthReport>('/doctor'),
  runHealthCheck: () => request<HealthReport>('POST', '/doctor'),
  home: () => get<{ continueWatching: Progress[]; myList: (MediaRef & { addedAt: number })[]; suggestions: Row[]; rows: Row[] }>('/home'),
  similar: (type: MediaType, id: number) => get<{ results: Card[] }>(`/title/${type}/${id}/similar`),
  notInterested: (type: MediaType, id: number) => request('POST', '/suggestions/not-interested', { mediaType: type, tmdbId: id }),
  suggestionStatus: () => get<{ profiles: SuggestionStatus[] }>('/suggestions/status'),
  rebuildSuggestions: (profileId?: string) => request('POST', '/suggestions/rebuild', { profileId }),
  browse: (type: MediaType, lang?: string) => get<{ rows: Row[] }>(`/browse/${type}?${qs({ lang })}`),
  search: (q: string, f: Partial<DiscoverFilters> = {}, page = 1) =>
    get<{ results: Card[]; people: Person[]; hasMore: boolean }>(`/search?${qs({ q, page, ...f, type: f.type === 'all' ? undefined : f.type })}`),
  discover: (f: DiscoverFilters & { page?: number }) => get<{ results: Card[]; hasMore: boolean }>(`/discover?${qs({ ...f })}`),
  genres: () => get<{ genres: string[]; languages: Record<string, string> }>('/genres'),
  person: (id: number) => get<{ name: string; profilePath: string | null; results: Card[] }>(`/person/${id}`),
  profiles: () => get<{ profiles: Profile[]; hasPin: boolean; parentUnlocked: boolean }>('/profiles'),
  createProfile: (p: Partial<Profile>) => request<Profile>('POST', '/profiles', p),
  updateProfile: (id: string, p: Partial<Profile>) => request<Profile>('PUT', `/profiles/${id}`, p),
  deleteProfile: (id: string) => request('DELETE', `/profiles/${id}`),
  unlockParent: (pin: string) => request<{ token: string }>('POST', '/parent/unlock', { pin }),
  setParentPin: (pin: string) => request('POST', '/parent/pin', { pin }),
  title: (type: MediaType, id: number) =>
    get<{
      details: Details;
      ageRating: number | null;
      inMyList: boolean;
      lastWatched: Progress | null;
      savedSource: SavedSource | null;
      downloads: DownloadRow[];
      watch: Watch | null;
      upgrade: Watch | null;
      watches: Watch[];
      sourceVerdict: Verdict | null;
      /** Why this title is in the profile's suggestions, if it is. */
      suggestedBecause: string | null;
    }>(`/title/${type}/${id}`),
  season: (id: number, n: number) => get<{ episodes: Episode[]; savedSource: SavedSource | null; downloads: DownloadRow[] }>(`/title/tv/${id}/season/${n}`),
  sources: (p: { type: MediaType; id?: number; title: string; year?: string; season?: number; episode?: number; screen?: number; dolby?: 0 | 1 }) =>
    get<{ releases: Release[]; skipped: string[]; canConvert?: boolean }>(`/sources?${qs(p)}`),
  prewarm: (b: { mediaType: MediaType; tmdbId: number; season?: number }) => request<{ ok: boolean }>('POST', '/prewarm', b),
  forgetSource: (type: MediaType, id: number, season?: number, episode?: number) => request('DELETE', `/sources/${type}/${id}?${qs({ season, episode })}`),
  play: (b: { mediaType: MediaType; tmdbId: number; season?: number; episode?: number; source?: SavedSource }) =>
    request<PlayInfo>('POST', '/play', b),
  preview: (b: { source: SavedSource; season?: number; episode?: number; mediaType?: MediaType; tmdbId?: number }) => request<PlayInfo & { fileSize: number }>('POST', '/preview', b),
  discardPreview: (hash: string) => request<{ discarded: boolean }>('DELETE', `/preview/${hash}`),
  media: (hash: string, file: number, preview = false) => get<{ canConvert: boolean; info: MediaInfo | null; error?: string }>(`/media/${hash}/${file}${preview ? '?preview' : ''}`),
  /** Where a copied-video conversion near `at` really starts: the keyframe at or before it (keeps sound in sync). */
  convertStart: (hash: string, file: number, at: number, preview = false) =>
    get<{ start: number }>(`/convert/${hash}/${file}/start?at=${at.toFixed(2)}${preview ? '&preview' : ''}`).then((r) => r.start),
  torrentStatus: (hash: string, file?: number) => get<TorrentStatus>(`/torrents/${hash}/status?${qs({ file })}`),
  saveProgress: (p: Omit<Progress, 'updatedAt'>) => request('POST', '/progress', p),
  clearProgress: (type: MediaType, id: number) => request('DELETE', `/progress/${type}/${id}`),
  addToList: (m: MediaRef) => request('POST', '/list', m),
  removeFromList: (type: MediaType, id: number) => request('DELETE', `/list/${type}/${id}`),
  downloads: (filter?: { type: MediaType; id: number }) => get<{ downloads: DownloadRow[]; cacheLimitGb: number }>(`/downloads?${qs(filter || {})}`),
  deleteDownload: (hash: string, fileIdx?: number | null) => request('DELETE', `/downloads/${hash}?${qs({ file: fileIdx ?? undefined })}`),
  download: (b: { mediaType: MediaType; tmdbId: number; season?: number; episode?: number; source?: SavedSource }) =>
    request<{ status: 'started' | 'already-downloading' | 'already-complete'; infoHash: string; fileIdx: number; fileName: string }>('POST', '/download', b),
  keep: (hash: string, kept: boolean) => request('POST', `/downloads/${hash}/keep`, { kept }),
  settings: () => get<Settings>('/settings'),
  saveSettings: (s: Partial<Settings>) => request<Settings>('PUT', '/settings', s),
  testIndexer: () => request<{ ok: boolean; message: string }>('POST', '/settings/test-indexer'),
  testAi: (which: 'local' | 'remote') => request<{ ok: boolean; message: string; ms: number }>('POST', '/settings/test-ai', { which }),
  verify: (b: { source: SavedSource; mediaType: MediaType; tmdbId: number; season?: number; episode?: number; release?: { size?: number; seeders?: number; indexer?: string }; force?: boolean }) =>
    request<Verdict>('POST', '/verify', b),
  watching: () => get<{ watches: Watch[]; unseen: number }>('/watching'),
  watch: (b: { mediaType: MediaType; tmdbId: number; season?: number; episode?: number }) => request<Watch>('POST', '/watch', b),
  unwatch: (key: string) => request('DELETE', `/watch/${encodeURIComponent(key)}`),
  watchSeen: (key: string) => request('POST', `/watching/${encodeURIComponent(key)}/seen`),
};

export const streamUrl = (p: PlayInfo, preview = false) => `/api/stream/${p.infoHash}/${p.fileIdx}${preview ? '?preview' : ''}`;
/** ffmpeg-converted stream starting at `start` seconds (fragmented MP4; seeking restarts it). */
export const convertUrl = (p: PlayInfo, start: number, video: 'copy' | 'h264', preview = false, audio = 0, acodec: 'aac' | 'ac3' = 'aac') =>
  `/api/convert/${p.infoHash}/${p.fileIdx}?start=${start.toFixed(3)}&video=${video}&audio=${audio}&acodec=${acodec}${preview ? '&preview' : ''}`;

export const releaseSource = (r: Release): SavedSource => ({ magnet: r.magnet, downloadUrl: r.downloadUrl, infoHash: r.infoHash, releaseTitle: r.title });
export const saveFileUrl = (hash: string, fileIdx: number) => `/api/downloads/${hash}/file?file=${fileIdx}`;

/** Toast text for the result of pressing Download. */
export function downloadMessage(r: { status: string; fileName: string }): string {
  if (r.status === 'already-complete') return `${r.fileName} is already downloaded.`;
  if (r.status === 'already-downloading') return `${r.fileName} is already downloading.`;
  return `Downloading ${r.fileName} — progress is on the Downloads page.`;
}

/** "S1:E3" for episodes, "" for movies. */
export const episodeLabel = (season: number | null | undefined, episode: number | null | undefined) =>
  season != null && episode != null ? `S${season}:E${episode}` : '';
export const subtitleUrl = (hash: string, idx: number, offset = 0) => `/api/subs/${hash}/${idx}.vtt${offset > 0 ? `?offset=${offset.toFixed(1)}` : ''}`;

type ImgSize = 'w185' | 'w300' | 'w342' | 'w500' | 'w780' | 'w1280' | 'original';
export const img = (path: string | null | undefined, size: ImgSize) => (path ? `https://image.tmdb.org/t/p/${size}${path}` : '');

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let u = -1;
  do {
    n /= 1024;
    u++;
  } while (n >= 1024 && u < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[u]}`;
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export const formatRuntime = (min: number | null) => (min ? (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`) : '');

export const todayIso = () => new Date().toISOString().slice(0, 10);
export const isComingSoon = (c: { releaseDate?: string }) => !!c.releaseDate && c.releaseDate > todayIso();
export const shortDate = (d: string | null | undefined) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');

export const OUTCOME_TONE: Record<VerdictOutcome, 'good' | 'ok' | 'risky' | 'plain'> = { verified: 'good', theater: 'ok', suspect: 'plain', rejected: 'risky' };

export interface DiscoverFilters {
  type: 'all' | MediaType;
  language?: string;
  genre?: string;
  decade?: 'this-year' | '2020s' | '2010s' | '2000s' | 'older';
  sort: 'popular' | 'newest' | 'top';
}

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada', bn: 'Bengali', mr: 'Marathi', pa: 'Punjabi',
  ko: 'Korean', ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', tr: 'Turkish', th: 'Thai',
};
export const languageName = (code: string) => LANGUAGE_NAMES[code] || code.toUpperCase();
