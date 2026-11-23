import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import parseTorrent from 'parse-torrent';
import WebTorrent, { type Torrent, type TorrentFile, type Wire } from 'webtorrent';
import { DATA_DIR, db, getSettings, save, type CachedDownload, type DownloadItem, type MediaType } from './store.ts';

export const VIDEO_EXT = new Set(['.mp4', '.mkv', '.m4v', '.webm', '.mov', '.avi', '.ts', '.wmv']);
export const SUB_EXT = new Set(['.srt', '.vtt']);

/** How long a torrent with no viewers keeps running before it is stopped (files stay cached on disk). */
const IDLE_MS = 15 * 60 * 1000;
const METADATA_TIMEOUT_MS = 90 * 1000;

/** Extra public trackers help magnet links with few or dead trackers find peers. */
const EXTRA_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://opentracker.io:6969/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'udp://retracker01-msk-virt.corbina.net:80/announce',
  'https://tracker.tamersunion.org:443/announce',
  'https://tracker.gbitt.info:443/announce',
  'http://tracker.files.fm:6969/announce',
];

export class TorrentError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export interface SourceInput {
  magnet?: string;
  downloadUrl?: string;
  infoHash?: string;
}

// A fixed port (TORRENT_PORT) lets peers connect in; needed when running in Docker with the port published.
const client = new WebTorrent({ maxConns: 80, torrentPort: Number(process.env.TORRENT_PORT) || 0 });
client.on('error', (err) => console.error('[torrent] client error:', (err as Error).message));

/** Open HTTP streams per infoHash; a torrent is never stopped while someone is watching. */
const activeStreams = new Map<string, number>();
const lastAccess = new Map<string, number>();

export function touch(infoHash: string): void {
  lastAccess.set(infoHash, Date.now());
  const d = db.downloads[infoHash];
  if (d) d.lastAccess = Date.now();
}

/** Piece data actually sent to other peers, per torrent, since it was started. */
const dataShared = new Map<string, number>();

/** Torrents a deep check is using right now (a preview close must not delete them mid-check). */
export const busyTorrents = new Set<string>();
export const isStreaming = (infoHash: string) => (activeStreams.get(infoHash) || 0) > 0;

export function streamOpened(infoHash: string): void {
  activeStreams.set(infoHash, (activeStreams.get(infoHash) || 0) + 1);
  touch(infoHash);
}

export function streamClosed(infoHash: string): void {
  activeStreams.set(infoHash, Math.max(0, (activeStreams.get(infoHash) || 1) - 1));
  touch(infoHash);
}

/** Prowlarr/Jackett download links either redirect to a magnet or return a .torrent file. */
async function resolveDownloadUrl(url: string): Promise<string | Buffer> {
  for (let hop = 0; hop < 5; hop++) {
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new TorrentError(`Could not fetch the torrent from the indexer: ${(e as Error).message}`);
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      if (loc.startsWith('magnet:')) return loc;
      url = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) throw new TorrentError(`Indexer returned ${res.status} for the torrent download.`);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.subarray(0, 8).toString();
    if (text.startsWith('magnet:')) return buf.toString().trim();
    return buf;
  }
  throw new TorrentError('Too many redirects fetching the torrent.');
}

function waitForMetadata(t: Torrent): Promise<Torrent> {
  if (t.ready || t.files.length) return Promise.resolve(t);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new TorrentError('Could not find any peers for this torrent. Try another source with more seeders.', 504));
      client.remove(t, { destroyStore: false }).catch(() => {});
    }, METADATA_TIMEOUT_MS);
    const onMeta = () => {
      cleanup();
      resolve(t);
    };
    const onErr = (e: Error) => {
      cleanup();
      reject(new TorrentError(e.message));
    };
    const cleanup = () => {
      clearTimeout(timer);
      t.off('metadata', onMeta);
      t.off('ready', onMeta);
      t.off('error', onErr);
    };
    t.once('metadata', onMeta);
    t.once('ready', onMeta);
    t.once('error', onErr);
  });
}

/** Adds (or finds) a torrent and waits until its file list is known. */
/** "The Odyssey: Part 1" + "2026" -> "The Odyssey - Part 1 (2026)", safe on macOS/Linux/Windows. */
export function folderName(title: string, year?: string): string {
  const clean = title
    .replace(/[\\/:*?"<>|]+/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .slice(0, 120);
  return clean ? (year ? `${clean} (${year})` : clean) : '';
}

const folderOf = (d: CachedDownload) => d.folder || d.infoHash;
const downloadsRoot = () => getSettings().downloadDir;
/** Where this torrent's content lives: a file (single-file torrent) or a folder. */
const contentPath = (d: CachedDownload) => join(downloadsRoot(), folderOf(d), d.name);

export async function addSource(
  src: SourceInput,
  opts: { preview?: boolean; folder?: string; title?: string; mediaType?: MediaType; tmdbId?: number } = {},
): Promise<Torrent> {
  if (src.infoHash) {
    const existing = await client.get(src.infoHash);
    if (existing) return waitForMetadata(existing);
  }

  // Reopening a torrent we've seen: load its saved .torrent file instead of re-fetching metadata from peers.
  const cachedMeta = src.infoHash ? readTorrentFile(src.infoHash) : undefined;
  let id: string | Buffer | undefined = cachedMeta || src.magnet;
  if (!id && src.downloadUrl) id = await resolveDownloadUrl(src.downloadUrl);
  if (!id && src.infoHash) id = db.downloads[src.infoHash]?.magnet || `magnet:?xt=urn:btih:${src.infoHash}`;
  if (!id) throw new TorrentError('No magnet link or torrent file given.', 400);

  let infoHash: string;
  try {
    infoHash = (await parseTorrent(id)).infoHash;
  } catch {
    throw new TorrentError('That does not look like a valid magnet link or torrent file.', 400);
  }

  const existing = await client.get(infoHash);
  if (existing) return waitForMetadata(existing);

  const known = db.downloads[infoHash];
  const folder = known ? folderOf(known) : opts.folder || infoHash;
  const dir = join(downloadsRoot(), folder);
  // A saved bitfield tells WebTorrent which pieces are already on disk, so restarting a played or
  // downloaded torrent is instant instead of re-hashing gigabytes (and re-requesting them from peers meanwhile).
  const bitfield = known?.bitfield ? new Uint8Array(Buffer.from(known.bitfield, 'base64')) : undefined;
  const share = getSettings().shareUploads;
  const t = client.add(id, { path: dir, deselect: true, strategy: 'sequential', announce: EXTRA_TRACKERS, bitfield, ...(share ? {} : { uploads: 0 }) });
  t.on('error', (e) => console.error(`[torrent] ${infoHash}:`, (e as Error).message));
  if (!share) t.on('wire', leechOnly);
  // Count actual movie data sent to peers (WebTorrent's own `uploaded` also counts protocol chatter).
  t.on('wire', (wire: Wire) => wire.on('upload', (n) => dataShared.set(infoHash, (dataShared.get(infoHash) || 0) + n)));
  touch(infoHash);
  console.log(`[torrent] added ${infoHash}`);

  const ready = await waitForMetadata(t);
  saveTorrentFile(ready);
  db.downloads[infoHash] = {
    ...known,
    infoHash,
    name: ready.name,
    magnet: typeof id === 'string' ? id : ready.magnetURI,
    lastAccess: Date.now(),
    folder,
    title: known?.title || opts.title,
    mediaType: known?.mediaType || opts.mediaType,
    tmdbId: known?.tmdbId || opts.tmdbId,
    previewOnly: known ? known.previewOnly : opts.preview || undefined,
  };
  save();
  return ready;
}

const TORRENT_DIR = join(DATA_DIR, 'torrents');

function readTorrentFile(infoHash: string): Buffer | undefined {
  try {
    return readFileSync(join(TORRENT_DIR, `${infoHash}.torrent`));
  } catch {
    return undefined;
  }
}

function saveTorrentFile(t: Torrent): void {
  try {
    const file = join(TORRENT_DIR, `${t.infoHash}.torrent`);
    if (!t.torrentFile || existsSync(file)) return;
    mkdirSync(TORRENT_DIR, { recursive: true });
    writeFileSync(file, t.torrentFile);
  } catch (e) {
    console.error('[torrent] could not cache metadata:', (e as Error).message);
  }
}

/**
 * Download-only mode: keep every peer connection choked. A choked peer's piece requests are refused by
 * the protocol, so nothing is ever uploaded. (WebTorrent would otherwise unchoke any interested peer.)
 * We still download normally: being choked by *them* is what limits downloads, not us choking them.
 */
function leechOnly(wire: Wire): void {
  wire.unchoke = () => {};
  if (!wire.amChoking) wire.choke();
}

/** Remembers which pieces a running torrent has (see the bitfield note in addSource). */
function saveBitfield(t: Torrent): void {
  const d = db.downloads[t.infoHash];
  if (d && t.bitfield && t.files.length) d.bitfield = Buffer.from(t.bitfield.buffer).toString('base64');
}

export function saveAllBitfields(): void {
  for (const t of client.torrents) saveBitfield(t);
}

/** Fetch the start and end of a video first: players read the header, and MP4/MKV keep their index at the end. */
export function prioritizeEdges(t: Torrent, fileIdx: number): void {
  const f = t.files[fileIdx];
  if (!f || !t.pieceLength) return;
  const first = Math.floor(f.offset / t.pieceLength);
  const last = Math.floor((f.offset + f.length - 1) / t.pieceLength);
  const head = Math.min(last, first + Math.ceil((8 * 1024 * 1024) / t.pieceLength));
  const tail = Math.max(first, last - Math.ceil((2 * 1024 * 1024) / t.pieceLength));
  t.critical(first, head);
  t.critical(tail, last);
}

/** Opens a title's remembered source in the background so peers are connected before Play is pressed. */
export function prewarm(src: SourceInput, opts: Parameters<typeof addSource>[1]): void {
  addSource(src, opts).catch(() => {});
}

export async function getTorrent(infoHash: string): Promise<Torrent> {
  const t = await client.get(infoHash);
  if (t) return waitForMetadata(t);
  // Stopped for being idle (or the server restarted): bring it back from the cache.
  if (db.downloads[infoHash]) return addSource({ infoHash });
  throw new TorrentError('Unknown torrent.', 404);
}

// --- file selection --------------------------------------------------------

const isVideo = (f: TorrentFile) => VIDEO_EXT.has(extname(f.name).toLowerCase()) && !/\bsample\b/i.test(f.path);

export function episodeOf(path: string): { s: number; e: number } | null {
  const p = path.replace(/[._]/g, ' ');
  const m = p.match(/S(\d{1,2})\s?E(\d{1,3})/i) || p.match(/\b(\d{1,2})x(\d{2,3})\b/) || p.match(/Season\s?(\d{1,2}).*?Episode\s?(\d{1,3})/i);
  return m ? { s: Number(m[1]), e: Number(m[2]) } : null;
}

/** True when the torrent holds several episodes (a season pack), so it can serve the whole season. */
export function isSeasonPack(t: Torrent): boolean {
  const eps = new Set(t.files.filter((f) => isVideo(f)).map((f) => episodeOf(f.path)?.e).filter((e) => e != null));
  return eps.size > 1;
}

/** Picks the video for a movie (largest) or for one episode (by SxxEyy in the file path). */
export function pickFile(t: Torrent, season?: number, episode?: number): number {
  const videos = t.files.map((f, idx) => ({ f, idx })).filter(({ f }) => isVideo(f));
  if (!videos.length) throw new TorrentError('This torrent has no playable video files.', 422);

  if (episode != null) {
    const match = videos.filter(({ f }) => {
      const ep = episodeOf(f.path);
      return ep && ep.e === episode && (season == null || ep.s === season);
    });
    if (match.length) return match.sort((a, b) => b.f.length - a.f.length)[0].idx;
    // A single video named as another episode (e.g. a season's remembered single-episode torrent) is the wrong file.
    const named = videos.length === 1 ? episodeOf(videos[0].f.path) : null;
    if (videos.length > 1 || (named && (named.e !== episode || (season != null && named.s !== season))))
      throw new TorrentError(`Couldn't find season ${season} episode ${episode} in this torrent.`, 422);
  }
  return videos.sort((a, b) => b.f.length - a.f.length)[0].idx;
}

export interface SubtitleTrack {
  idx: number;
  label: string;
  lang: string;
}

const LANGS: Record<string, string> = {
  en: 'English', eng: 'English', english: 'English',
  es: 'Spanish', spa: 'Spanish', spanish: 'Spanish',
  fr: 'French', fre: 'French', fra: 'French', french: 'French',
  de: 'German', ger: 'German', deu: 'German', german: 'German',
  it: 'Italian', ita: 'Italian', italian: 'Italian',
  pt: 'Portuguese', por: 'Portuguese', portuguese: 'Portuguese',
  hi: 'Hindi', hin: 'Hindi', hindi: 'Hindi',
  nl: 'Dutch', dut: 'Dutch', dutch: 'Dutch',
  ru: 'Russian', rus: 'Russian', russian: 'Russian',
  ar: 'Arabic', ara: 'Arabic', arabic: 'Arabic',
  ja: 'Japanese', jpn: 'Japanese', japanese: 'Japanese',
  ko: 'Korean', kor: 'Korean', korean: 'Korean',
  zh: 'Chinese', chi: 'Chinese', chinese: 'Chinese',
  pl: 'Polish', pol: 'Polish', polish: 'Polish',
};

/** Subtitle files that belong to the chosen video, English first. */
export function subtitlesFor(t: Torrent, fileIdx: number): SubtitleTrack[] {
  const video = t.files[fileIdx];
  const videoBase = basename(video.name, extname(video.name)).toLowerCase();
  const ep = episodeOf(video.path);
  const subs = t.files
    .map((f, idx) => ({ f, idx }))
    .filter(({ f }) => SUB_EXT.has(extname(f.name).toLowerCase()))
    .filter(({ f }) => {
      const p = f.path.toLowerCase();
      if (p.includes(videoBase)) return true;
      if (!ep) return true;
      const sep = episodeOf(f.path);
      return !sep || (sep.s === ep.s && sep.e === ep.e);
    });

  const tracks = subs.map(({ f, idx }) => {
    const words = basename(f.name, extname(f.name)).toLowerCase().split(/[^a-z]+/).reverse();
    const word = words.find((w) => LANGS[w]);
    const lang = word ? LANGS[word] : 'Unknown';
    const sdh = /sdh|hi\b|forced/i.test(f.name) ? ` (${/forced/i.test(f.name) ? 'Forced' : 'SDH'})` : '';
    return { idx, lang, label: lang + sdh };
  });
  return tracks.sort((a, b) => Number(b.lang === 'English') - Number(a.lang === 'English')).slice(0, 20);
}

export async function readFileText(t: Torrent, fileIdx: number): Promise<string> {
  const f = t.files[fileIdx];
  if (!f) throw new TorrentError('No such file.', 404);
  const chunks: Buffer[] = [];
  for await (const c of f.createReadStream()) chunks.push(c as Buffer);
  const buf = Buffer.concat(chunks);
  const utf8 = new TextDecoder('utf-8').decode(buf);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8;
}

// --- status / downloads ----------------------------------------------------------

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
  /** Bytes this torrent has sent to other peers since it was started. */
  uploaded: number;
}

/** Live status of a running torrent (player buffering overlay, preview). */
export async function statusOf(infoHash: string, fileIdx?: number): Promise<TorrentStatus | null> {
  const t = await client.get(infoHash);
  const d = db.downloads[infoHash];
  if (!t && !d) return null;
  const f = t && fileIdx != null ? t.files[fileIdx] : t?.files.filter((x) => x.downloaded > 0).sort((a, b) => b.length - a.length)[0];
  const item = fileIdx != null ? d?.items?.[fileIdx] : undefined;
  return {
    infoHash,
    name: t?.name || d?.name || infoHash,
    active: !!t,
    progress: f ? f.progress : item?.progress || 0,
    downloadSpeed: t?.downloadSpeed || 0,
    uploadSpeed: t?.uploadSpeed || 0,
    peers: t?.numPeers || 0,
    size: f ? f.length : item?.size || 0,
    watching: activeStreams.get(infoHash) || 0,
    uploaded: dataShared.get(infoHash) || 0,
  };
}

/** Real disk use of a file or folder (torrent files are sparse until fully downloaded). */
async function diskUsage(path: string): Promise<number> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.blocks * 512;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const e of await readdir(path)) total += await diskUsage(join(path, e));
  return total;
}

/** One row on the Downloads page / one entry in a title's downloads: a single video file. */
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
  /** The Download button was used (vs. just cached from watching). */
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

/** Live progress of an item: from the running torrent if it's active, else the last recorded value. */
function itemProgress(t: Torrent | null, item: DownloadItem): number {
  const f = t?.files[item.fileIdx];
  return f ? f.progress : item.progress;
}

export async function listDownloads(filter?: { mediaType: MediaType; tmdbId: number }): Promise<DownloadRow[]> {
  const rows: DownloadRow[] = [];
  for (const d of Object.values(db.downloads)) {
    if (d.previewOnly) continue;
    if (filter && (d.mediaType !== filter.mediaType || d.tmdbId !== filter.tmdbId)) continue;
    const t = await client.get(d.infoHash);
    const base = {
      infoHash: d.infoHash,
      releaseName: d.name,
      title: d.title || null,
      mediaType: d.mediaType || null,
      tmdbId: d.tmdbId ?? null,
      kept: !!d.kept,
      active: !!t,
      watching: activeStreams.get(d.infoHash) || 0,
      peers: t?.numPeers || 0,
      downloadSpeed: t?.downloadSpeed || 0,
      uploaded: dataShared.get(d.infoHash) || 0,
      lastAccess: lastAccess.get(d.infoHash) || d.lastAccess || 0,
    };
    const items = Object.values(d.items || {});
    if (!items.length) {
      // Cached from an older version: we don't know which file yet (learned on next play).
      rows.push({ ...base, fileIdx: null, fileName: null, season: null, episode: null, size: 0, diskBytes: await diskUsage(contentPath(d)), progress: 0, complete: false, requested: false, downloading: false });
      continue;
    }
    for (const it of items) {
      const progress = itemProgress(t, it);
      rows.push({
        ...base,
        fileIdx: it.fileIdx,
        fileName: basename(it.path),
        season: it.season ?? null,
        episode: it.episode ?? null,
        size: it.size,
        diskBytes: await diskUsage(join(downloadsRoot(), folderOf(d), it.path)),
        progress,
        complete: progress >= 1,
        requested: !!it.requested,
        downloading: !!it.downloading && progress < 1,
        lastAccess: Math.max(base.lastAccess, it.updatedAt || 0),
      });
    }
  }
  return rows.sort((a, b) => b.lastAccess - a.lastAccess);
}

function upsertItem(t: Torrent, fileIdx: number, ep?: { season?: number; episode?: number }): DownloadItem | undefined {
  const d = db.downloads[t.infoHash];
  const f = t.files[fileIdx];
  if (!d || !f) return undefined;
  d.items ||= {};
  const fromPath = episodeOf(f.path);
  const prev = d.items[fileIdx];
  const item: DownloadItem = {
    ...prev,
    fileIdx,
    path: f.path,
    size: f.length,
    progress: f.progress,
    season: ep?.season ?? prev?.season ?? fromPath?.s,
    episode: ep?.episode ?? prev?.episode ?? fromPath?.e,
    updatedAt: Date.now(),
  };
  d.items[fileIdx] = item;
  return item;
}

/** Records that a file was played, so it shows on the Downloads page and its title page. */
export function rememberFile(t: Torrent, fileIdx: number, ep?: { season?: number; episode?: number }): void {
  if (upsertItem(t, fileIdx, ep)) save();
}

/** True when an episode is on the Mac or on its way (from any source); partly watched files don't count. */
export function hasEpisodeDownload(tmdbId: number, season: number, episode: number): boolean {
  return Object.values(db.downloads).some(
    (d) => d.mediaType === 'tv' && d.tmdbId === tmdbId && Object.values(d.items || {}).some((it) => it.season === season && it.episode === episode && (it.progress >= 1 || it.downloading)),
  );
}

export type DownloadStart = 'started' | 'already-downloading' | 'already-complete';

/** Download button: fetch the whole file without playing it, keep going until done, never auto-delete. */
export function startDownload(t: Torrent, fileIdx: number, ep?: { season?: number; episode?: number }): DownloadStart {
  const d = db.downloads[t.infoHash];
  const existing = d?.items?.[fileIdx];
  const file = t.files[fileIdx];
  if (existing && file.progress >= 1) {
    existing.requested = true;
    d!.kept = true;
    save();
    return 'already-complete';
  }
  if (existing?.downloading) return 'already-downloading';
  const item = upsertItem(t, fileIdx, ep);
  if (!d || !item) throw new TorrentError('Could not start the download.', 500);
  delete d.previewOnly;
  item.requested = true;
  item.downloading = true;
  d.kept = true;
  file.select();
  touch(t.infoHash);
  save();
  console.log(`[download] ${d.title || d.name}: ${file.name}`);
  return 'started';
}

export function setKept(infoHash: string, kept: boolean): void {
  const d = db.downloads[infoHash];
  if (!d) throw new TorrentError('Unknown download.', 404);
  d.kept = kept;
  save();
}

/** Absolute path of a finished video, for "Save to this device". */
export function finishedFilePath(infoHash: string, fileIdx: number): { path: string; name: string } {
  const d = db.downloads[infoHash];
  const it = d?.items?.[fileIdx];
  if (!d || !it) throw new TorrentError('Nothing to save for this download.', 404);
  if (it.progress < 1) throw new TorrentError('This file is still downloading.', 409);
  const path = join(downloadsRoot(), folderOf(d), it.path);
  if (!existsSync(path)) throw new TorrentError('The file is missing from the download folder.', 410);
  return { path, name: basename(it.path) };
}

/** Deletes a whole torrent (all its files) from disk and from the list. */
export async function deleteDownload(infoHash: string): Promise<void> {
  const t = await client.get(infoHash);
  if (t) await client.remove(t, { destroyStore: false });
  activeStreams.delete(infoHash);
  lastAccess.delete(infoHash);
  const d = db.downloads[infoHash];
  if (d) {
    // Only this torrent's files: other downloads of the same title share the folder.
    await rm(d.name ? contentPath(d) : join(downloadsRoot(), folderOf(d)), { recursive: true, force: true });
    await rmdir(join(downloadsRoot(), folderOf(d))).catch(() => {}); // removes the title folder only if now empty
  }
  delete db.downloads[infoHash];
  await rm(join(TORRENT_DIR, `${infoHash}.torrent`), { force: true });
  save();
}

/** Deletes one file (e.g. one episode of a season pack); the whole torrent if it was the last one. */
export async function deleteDownloadFile(infoHash: string, fileIdx: number): Promise<void> {
  const d = db.downloads[infoHash];
  if (!d?.items?.[fileIdx]) throw new TorrentError('Unknown download.', 404);
  if (Object.keys(d.items).length <= 1) return deleteDownload(infoHash);
  const it = d.items[fileIdx];
  const t = await client.get(infoHash);
  t?.files[fileIdx]?.deselect();
  delete d.bitfield; // no longer accurate once a file is removed
  await rm(join(downloadsRoot(), folderOf(d), it.path), { force: true });
  delete d.items[fileIdx];
  save();
}

/** Deletes a torrent that was only previewed (never played). Played torrents are left alone. */
export async function discardPreview(infoHash: string): Promise<boolean> {
  // Preview streams may still be closing; nobody is really watching a preview-only torrent
  // ("Watch this" clears the flag first), so it's safe to drop it now.
  if (!db.downloads[infoHash]?.previewOnly || busyTorrents.has(infoHash)) return false;
  await deleteDownload(infoHash);
  return true;
}

export function markPlayed(infoHash: string): void {
  const d = db.downloads[infoHash];
  if (d?.previewOnly) {
    delete d.previewOnly;
    save();
  }
}

// --- housekeeping ---------------------------------------------------------------------

/** Records progress of running torrents, finishes downloads, and stops torrents nobody needs. */
async function stopIdle(): Promise<void> {
  const now = Date.now();
  for (const d of Object.values(db.downloads)) {
    if (d.previewOnly && now - d.lastAccess > 60 * 60 * 1000) await discardPreview(d.infoHash);
  }
  for (const t of [...client.torrents]) {
    const d = db.downloads[t.infoHash];
    let fetching = false;
    for (const it of Object.values(d?.items || {})) {
      const f = t.files[it.fileIdx];
      if (!f) continue;
      it.progress = f.progress;
      if (it.downloading && f.progress >= 1) {
        it.downloading = false;
        console.log(`[download] finished ${d!.title || d!.name}: ${f.name}`);
      }
      if (it.downloading) fetching = true;
    }
    saveBitfield(t);
    if (fetching) continue; // keep going until requested downloads are complete
    const idle = now - (lastAccess.get(t.infoHash) || 0) > IDLE_MS;
    if (idle && !activeStreams.get(t.infoHash)) {
      console.log(`[torrent] stopping idle ${t.infoHash} (${t.name})`);
      await client.remove(t, { destroyStore: false }).catch(() => {});
    }
  }
  save();
}

/** Removes least-recently-used torrents until the cache fits the limit. Kept or downloading ones are never removed. */
async function enforceCacheLimit(): Promise<void> {
  const { downloadDir, cacheLimitGb } = getSettings();
  if (!existsSync(downloadDir)) return;
  const limit = cacheLimitGb * 1024 ** 3;
  const torrents = [];
  for (const d of Object.values(db.downloads)) {
    torrents.push({
      d,
      bytes: await diskUsage(contentPath(d)),
      protected: !!d.kept || Object.values(d.items || {}).some((i) => i.downloading) || !!activeStreams.get(d.infoHash),
    });
  }
  let total = torrents.reduce((a, x) => a + x.bytes, 0);
  for (const x of torrents.sort((a, b) => a.d.lastAccess - b.d.lastAccess)) {
    if (total <= limit) break;
    if (x.protected) continue;
    console.log(`[cache] evicting ${x.d.name} (${(x.bytes / 1024 ** 3).toFixed(1)} GB)`);
    await deleteDownload(x.d.infoHash);
    total -= x.bytes;
  }
}

/** On startup: carry on with downloads that weren't finished when the server stopped. */
export async function resumeDownloads(): Promise<void> {
  for (const d of Object.values(db.downloads)) {
    const pending = Object.values(d.items || {}).filter((i) => i.downloading && i.progress < 1);
    if (!pending.length) continue;
    try {
      const t = await addSource({ infoHash: d.infoHash });
      for (const it of pending) t.files[it.fileIdx]?.select();
      console.log(`[download] resumed ${d.title || d.name} (${pending.length} file(s))`);
    } catch (e) {
      console.error(`[download] couldn't resume ${d.title || d.name}:`, (e as Error).message);
    }
  }
}

/** Fills in which catalog title older downloads belong to, so title pages can find them. */
export async function backfillTitles(resolve: (d: CachedDownload) => Promise<{ mediaType: MediaType; tmdbId: number; title?: string } | null>): Promise<void> {
  let changed = false;
  for (const d of Object.values(db.downloads)) {
    if (d.tmdbId != null && d.mediaType) continue;
    const found = await resolve(d).catch(() => null);
    if (!found) continue;
    d.mediaType = found.mediaType;
    d.tmdbId = found.tmdbId;
    d.title ||= found.title;
    changed = true;
    console.log(`[storage] linked ${d.name} -> ${found.mediaType}/${found.tmdbId}`);
  }
  if (changed) save();
}

/**
 * Older versions stored each torrent in a folder named by its infoHash. Move those into
 * readable title folders (e.g. "The Odyssey (2026)/…") when we can work out the title.
 */
export async function migrateLegacyFolders(titleFor: (infoHash: string) => Promise<string | null>): Promise<void> {
  const root = downloadsRoot();
  for (const d of Object.values(db.downloads)) {
    if (d.folder && d.folder !== d.infoHash) continue;
    const legacy = join(root, d.infoHash);
    if (!existsSync(legacy) || (await client.get(d.infoHash))) continue;
    const title = await titleFor(d.infoHash).catch(() => null);
    const folder = title && folderName(title);
    if (!folder) continue;
    try {
      await mkdir(join(root, folder), { recursive: true });
      for (const entry of await readdir(legacy)) {
        const to = join(root, folder, entry);
        if (!existsSync(to)) await rename(join(legacy, entry), to);
      }
      await rm(legacy, { recursive: true, force: true });
      d.folder = folder;
      d.title = d.title || folder;
      console.log(`[storage] renamed ${d.infoHash} -> ${folder}`);
    } catch (e) {
      console.error(`[storage] couldn't rename ${d.infoHash}:`, (e as Error).message);
    }
  }
  save();
}

setInterval(() => {
  stopIdle()
    .then(enforceCacheLimit)
    .catch((e) => console.error('[torrent] housekeeping failed:', e));
}, 60 * 1000).unref();

export function shutdown(): Promise<void> {
  saveAllBitfields();
  return new Promise((resolve) => client.destroy(() => resolve()));
}
