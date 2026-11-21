import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Card } from './tmdb.ts';

export type MediaType = 'movie' | 'tv';

export type AiMode = 'off' | 'local' | 'remote' | 'local+remote';
export type RemoteProvider = 'google' | 'anthropic' | 'openai' | 'xai' | 'openrouter' | 'custom';

export interface Settings {
  tmdbApiKey: string;
  indexerType: 'prowlarr' | 'jackett';
  indexerUrl: string;
  indexerApiKey: string;
  downloadDir: string;
  cacheLimitGb: number;
  /** AI source check: off, local model (Ollama), a remote API, or local first then remote when unsure. */
  aiMode: AiMode;
  /** Also send 3 video frames to the model (helps spot camera recordings). */
  aiFrames: boolean;
  aiLocalUrl: string;
  aiLocalModel: string;
  aiRemoteProvider: RemoteProvider;
  aiRemoteApiKey: string;
  /** Empty = the provider's default model. */
  aiRemoteModel: string;
  /** Only for 'custom' (any OpenAI-compatible server). */
  aiRemoteBaseUrl: string;
  /** When a watched title becomes available: download the best verified source automatically. */
  watchAutoDownload: boolean;
  watchResolution: '2160p' | '1080p' | '720p' | 'any';
  watchMaxSizeGb: number;
  /** Upload to other peers (seed). Off = download-only: peers can't fetch anything from us. */
  shareUploads: boolean;
  /** Nightly suggestions: let the AI pick, explain and group them (scoring alone when off or unavailable). */
  suggestAi: boolean;
}

/** A family member. Kids' profiles have an age limit and a simplified, filtered app. */
export interface Profile {
  id: string;
  name: string;
  /** Avatar colour (CSS colour) and emoji/initial shown on the "Who's watching?" screen. */
  color: string;
  emoji: string;
  kind: 'adult' | 'kid';
  /** Kids only: highest age rating allowed (7, 12 or 16). */
  maxAge?: 7 | 12 | 16;
  /** ISO 639-1 codes in order of preference, e.g. ["en", "hi"]. */
  languages: string[];
  createdAt: number;
}

/** Per-profile lists and history (history also feeds future suggestions). */
export interface ProfileData {
  myList: (MediaRef & { addedAt: number })[];
  /** key: progressKey() */
  progress: Record<string, Progress>;
  /** "Not interested" on a suggestion: `${mediaType}:${tmdbId}` keys, never suggested again. */
  notInterested?: string[];
}

/** One profile's suggestions, rebuilt nightly. */
export interface SuggestionSet {
  builtAt: number;
  rows: { id: string; title: string; items: Card[] }[];
  /** `${mediaType}:${tmdbId}` -> one-line reason shown on the title page. */
  reasons: Record<string, string>;
  /** Which AI ranked them (null = scoring only). */
  ai: { provider: string; model: string; ms: number } | null;
  aiError?: string;
  /** How many watched titles it was based on. */
  basedOn: number;
}

/** What the deep check concluded about one video file. */
export interface Verdict {
  infoHash: string;
  fileIdx: number;
  fileName: string;
  releaseTitle: string;
  checkedAt: number;
  /** verified = right title, complete; theater = camera/screener copy; suspect = doubts; rejected = wrong/fake. */
  outcome: 'verified' | 'theater' | 'suspect' | 'rejected';
  /** One-line human summary, e.g. "Full movie · WEB-DL 1080p · English, Hindi". */
  label: string;
  probe: {
    durationSec: number;
    width: number;
    height: number;
    videoCodec: string;
    audio: { codec: string; language: string; channels: number; title?: string; default?: boolean }[];
    subtitles: string[];
    /** Interlaced video (TV broadcast captures); browsers can't decode interlaced H.264 repackaged as MP4. */
    interlaced?: boolean;
    /** Seconds the video is held back by B-frame reordering when copied into MP4 (frames of delay ÷ frame rate). */
    videoDelaySec?: number;
  } | null;
  runtimeCheck: 'ok' | 'short' | 'long' | 'unknown';
  fileIssues: string[];
  ai: {
    provider: string;
    model: string;
    match: boolean;
    kind: string;
    isFullFeature: boolean;
    quality: string;
    audioLanguages: string[];
    confidence: number;
    issues: string[];
    summary: string;
    usedFrames: boolean;
  } | null;
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
  /** release = waiting for it to come out; upgrade = have a theater/low copy, want a proper one. */
  reason: 'release' | 'upgrade';
  /** For upgrades: the copy we already have (excluded from results). */
  currentInfoHash?: string;
  createdAt: number;
  lastChecked?: number;
  nextCheck: number;
  checks: number;
  status: 'waiting' | 'found' | 'gave-up';
  /** Human status line, e.g. "Digital release expected 12 Dec". */
  note: string;
  found?: { source: SavedSource; label: string; outcome: Verdict['outcome']; resolution: string | null; size: number; foundAt: number };
  /** False until the user has seen the "found" result. */
  seen?: boolean;
  downloaded?: boolean;
}

/** A playable source remembered for a movie, or for one season of a show (season packs). */
export interface SavedSource {
  magnet?: string;
  downloadUrl?: string;
  infoHash?: string;
  releaseTitle: string;
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

/** One video file inside a torrent: a movie, or one episode of a season pack. */
export interface DownloadItem {
  fileIdx: number;
  /** Path inside the torrent (torrent.files[i].path). */
  path: string;
  size: number;
  /** Last known progress, 0..1 (kept while the torrent is stopped). */
  progress: number;
  season?: number;
  episode?: number;
  /** The Download button was pressed for this file. */
  requested?: boolean;
  /** Keep fetching (even across restarts) until complete. */
  downloading?: boolean;
  updatedAt: number;
}

export interface CachedDownload {
  infoHash: string;
  name: string;
  magnet?: string;
  lastAccess: number;
  /** Added only to preview; deleted when the preview closes (or after an hour) unless it gets played. */
  previewOnly?: boolean;
  /** Folder under the download dir, e.g. "The Odyssey (2026)". Older entries used the infoHash. */
  folder?: string;
  /** Human title for the Downloads page, e.g. "The Odyssey (2026)". */
  title?: string;
  /** Which catalog title this belongs to. */
  mediaType?: MediaType;
  tmdbId?: number;
  /** Video files played or downloaded from this torrent, keyed by file index. */
  items?: Record<string, DownloadItem>;
  /** Never removed by cache cleanup. Set by the Download button, toggled on the Downloads page. */
  kept?: boolean;
  /** Base64 piece bitfield saved when the torrent stops, so restarting it doesn't re-check every byte on disk. */
  bitfield?: string;
  /** @deprecated single-file fields from older versions; migrated into `items` on load. */
  fileIdx?: number;
  filePath?: string;
  fileSize?: number;
  progress?: number;
  downloading?: boolean;
}

interface Db {
  settings: Partial<Settings> & { parentPinHash?: string; parentPinSalt?: string };
  profiles: Record<string, Profile>;
  profileData: Record<string, ProfileData>;
  /** @deprecated single-user data from before profiles; migrated into profileData on load. */
  myList?: (MediaRef & { addedAt: number })[];
  /** @deprecated see myList */
  progress?: Record<string, Progress>;
  /** key: sourceKey() */
  sources: Record<string, SavedSource>;
  downloads: Record<string, CachedDownload>;
  /** key: `${infoHash}:${fileIdx}` */
  verdicts: Record<string, Verdict>;
  watches: Record<string, Watch>;
  /** Age-rating cache: key `${type}:${id}` -> strictest age (null = unrated). */
  ratings: Record<string, { age: number | null; at: number }>;
  /** Per profile id. */
  suggestions: Record<string, SuggestionSet>;
  /** Recent search results per indexer (for the health check): 1 = answered, 0 = failed/timed out, newest last. */
  indexerHealth?: Record<string, { recent: number[]; lastError?: string; lastAt: number }>;
  /** Last health check (shown in Settings; a failure puts a red dot on the Settings icon). */
  health?: HealthReport;
}

export interface HealthCheck {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /** What to do about it (warn/fail only). */
  fix?: string;
}

export interface HealthReport {
  at: number;
  status: 'ok' | 'warn' | 'fail';
  checks: HealthCheck[];
}

export const DATA_DIR = resolve(process.env.DATA_DIR || join(import.meta.dirname, '../../data'));
const DB_FILE = join(DATA_DIR, 'db.json');

function load(): Db {
  const empty: Db = { settings: {}, profiles: {}, profileData: {}, sources: {}, downloads: {}, verdicts: {}, watches: {}, ratings: {}, suggestions: {} };
  let data: Db;
  try {
    data = { ...empty, ...JSON.parse(readFileSync(DB_FILE, 'utf8')) };
  } catch {
    data = empty;
  }
  data.profiles ||= {};
  data.ratings ||= {};
  data.suggestions ||= {};
  data.profileData ||= {};
  // First run with profiles: the existing list and history become the "Main" profile.
  if (!Object.keys(data.profiles).length) {
    data.profiles.main = { id: 'main', name: 'Main', color: '#2ec4b6', emoji: '', kind: 'adult', languages: ['en', 'hi'], createdAt: Date.now() };
    data.profileData.main = { myList: data.myList || [], progress: data.progress || {} };
  }
  delete data.myList;
  delete data.progress;
  // Older versions tracked a single file per torrent; move it into `items`.
  for (const d of Object.values(data.downloads)) {
    if (!d.items && d.fileIdx != null && d.filePath) {
      d.items = {
        [d.fileIdx]: { fileIdx: d.fileIdx, path: d.filePath, size: d.fileSize || 0, progress: d.progress || 0, downloading: d.downloading, requested: d.downloading || undefined, updatedAt: d.lastAccess },
      };
    }
    delete d.fileIdx;
    delete d.filePath;
    delete d.fileSize;
    delete d.progress;
    delete d.downloading;
  }
  return data;
}

export const db: Db = load();

let saveTimer: NodeJS.Timeout | null = null;
/** Debounced, atomic write of the whole db to disk. */
export function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 500);
}

export function flush(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DB_FILE);
}

export function getSettings(): Settings {
  const env = process.env;
  const s = db.settings;
  return {
    tmdbApiKey: s.tmdbApiKey || env.TMDB_API_KEY || '',
    indexerType: s.indexerType || (env.INDEXER_TYPE === 'jackett' ? 'jackett' : 'prowlarr'),
    indexerUrl: (s.indexerUrl || env.INDEXER_URL || 'http://localhost:9696').replace(/\/+$/, ''),
    indexerApiKey: s.indexerApiKey || env.INDEXER_API_KEY || '',
    downloadDir: resolve(s.downloadDir || env.DOWNLOAD_DIR || join(homedir(), 'Movies', 'FreeStream')),
    cacheLimitGb: s.cacheLimitGb || Number(env.CACHE_LIMIT_GB) || 50,
    aiMode: s.aiMode || (env.AI_MODE as AiMode) || 'local',
    aiFrames: s.aiFrames ?? true,
    aiLocalUrl: (s.aiLocalUrl || env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, ''),
    aiLocalModel: s.aiLocalModel || env.OLLAMA_MODEL || 'gemma4:e2b',
    aiRemoteProvider: s.aiRemoteProvider || (env.AI_REMOTE_PROVIDER as RemoteProvider) || 'google',
    aiRemoteApiKey: s.aiRemoteApiKey || env.AI_REMOTE_API_KEY || '',
    aiRemoteModel: s.aiRemoteModel || env.AI_REMOTE_MODEL || '',
    aiRemoteBaseUrl: (s.aiRemoteBaseUrl || env.AI_REMOTE_BASE_URL || '').replace(/\/+$/, ''),
    watchAutoDownload: s.watchAutoDownload ?? false,
    watchResolution: s.watchResolution || '1080p',
    watchMaxSizeGb: s.watchMaxSizeGb || 8,
    shareUploads: s.shareUploads ?? false,
    suggestAi: s.suggestAi ?? true,
  };
}

export function profileData(profileId: string): ProfileData {
  return (db.profileData[profileId] ||= { myList: [], progress: {} });
}

/** Every profile's progress entries (to find which title a torrent belongs to). */
export const allProgress = (): Progress[] => Object.values(db.profileData).flatMap((d) => Object.values(d.progress));

export function progressKey(mediaType: MediaType, tmdbId: number, season?: number, episode?: number): string {
  return mediaType === 'tv' && season != null && episode != null
    ? `tv:${tmdbId}:s${season}e${episode}`
    : `${mediaType}:${tmdbId}`;
}

export function sourceKey(mediaType: MediaType, tmdbId: number, season?: number): string {
  return mediaType === 'tv' && season != null ? `tv:${tmdbId}:s${season}` : `${mediaType}:${tmdbId}`;
}

/** A source chosen for one episode (single-episode torrents, or "change source" on an episode). */
export const episodeSourceKey = (tmdbId: number, season: number, episode: number) => `tv:${tmdbId}:s${season}e${episode}`;

/**
 * The source to use for a movie or an episode: the episode's own choice first, then the season's
 * (season packs are remembered for the whole season).
 */
export function sourceFor(mediaType: MediaType, tmdbId: number, season?: number, episode?: number): SavedSource | undefined {
  if (mediaType === 'tv' && season != null && episode != null) return db.sources[episodeSourceKey(tmdbId, season, episode)] || db.sources[sourceKey('tv', tmdbId, season)];
  return db.sources[sourceKey(mediaType, tmdbId, season)];
}

/** Remembers a chosen source: per episode always, and for the whole season when it's a season pack. */
export function rememberSource(mediaType: MediaType, tmdbId: number, source: SavedSource, opts: { season?: number; episode?: number; seasonPack?: boolean } = {}): void {
  if (mediaType === 'tv' && opts.season != null && opts.episode != null) {
    db.sources[episodeSourceKey(tmdbId, opts.season, opts.episode)] = source;
    if (opts.seasonPack) db.sources[sourceKey('tv', tmdbId, opts.season)] = source;
  } else db.sources[sourceKey(mediaType, tmdbId, opts.season)] = source;
}
