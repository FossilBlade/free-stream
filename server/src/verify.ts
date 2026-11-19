/**
 * Deep check of one source: is it the right title, and the whole thing?
 *
 *  1. File list   - executables/archives (fakes, malware), main video only a sliver of the torrent.
 *  2. Probe       - ffprobe over our own stream URL (fetches only the pieces it needs): real runtime,
 *                   resolution, codecs, audio languages. Runtime vs TMDB runtime = "is it complete?".
 *  3. AI          - local or remote model judges the evidence (+ optional frames).
 *
 * The result is cached per file as a Verdict.
 */
import { spawn, spawnSync } from 'node:child_process';
import { extname } from 'node:path';
import { judge } from './llm.ts';
import { parseRelease } from './release.ts';
import { db, getSettings, save, type MediaType, type SavedSource, type Verdict } from './store.ts';
import * as tmdb from './tmdb.ts';
import { addSource, busyTorrents, discardPreview, folderName, isStreaming, pickFile, VIDEO_EXT } from './torrents.ts';

let selfBaseUrl = 'http://127.0.0.1:8080';
export const setSelfBaseUrl = (url: string) => (selfBaseUrl = url);

export const hasFfmpeg = (() => {
  try {
    return spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;
  } catch {
    return false;
  }
})();

const verdictKey = (infoHash: string, fileIdx: number) => `${infoHash}:${fileIdx}`;
export const getVerdict = (infoHash: string, fileIdx: number): Verdict | undefined => db.verdicts[verdictKey(infoHash, fileIdx)];
/** Any verdict for this torrent (search results don't know the file index yet). */
export const verdictForHash = (infoHash: string): Verdict | undefined => Object.values(db.verdicts).find((v) => v.infoHash === infoHash);

// --- helpers -----------------------------------------------------------------------------

function run(cmd: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.stderr.on('data', (c: Buffer) => (err += c.toString()));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} failed: ${err.trim().split('\n').pop() || code}`));
    });
  });
}

async function probe(url: string): Promise<Verdict['probe']> {
  const out = await run('ffprobe', ['-v', 'error', '-rw_timeout', '60000000', '-print_format', 'json', '-show_format', '-show_streams', url], 120000);
  const j = JSON.parse(out.toString()) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; channels?: number; tags?: { language?: string; title?: string } }[];
  };
  const streams = j.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  return {
    durationSec: Number(j.format?.duration) || 0,
    width: video?.width || 0,
    height: video?.height || 0,
    videoCodec: video?.codec_name || '',
    audio: streams.filter((s) => s.codec_type === 'audio').map((s) => ({ codec: s.codec_name || '', language: s.tags?.language || 'und', channels: s.channels || 0 })),
    subtitles: streams.filter((s) => s.codec_type === 'subtitle').map((s) => s.tags?.language || s.tags?.title || 'und'),
  };
}

function frame(url: string, atSec: number): Promise<Buffer> {
  return run(
    'ffmpeg',
    ['-v', 'error', '-rw_timeout', '60000000', '-ss', String(Math.floor(atSec)), '-i', url, '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '6', 'pipe:1'],
    90000,
  );
}

const DANGEROUS = new Set(['.exe', '.scr', '.bat', '.cmd', '.lnk', '.msi', '.com', '.vbs', '.ps1', '.apk', '.dmg', '.pkg']);
const ARCHIVE = new Set(['.rar', '.zip', '.7z']);

const fmtRuntime = (sec: number) => {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

const KIND_LABEL: Record<string, string> = {
  theater_cam: 'Theater recording (camera)',
  theater_screener: 'Screener copy',
  tv_recording: 'TV recording',
  trailer_or_sample: 'Trailer or sample',
  fake_or_malware: 'Fake or unsafe',
  wrong_title: 'Wrong title',
};

const LANG: Record<string, string> = { eng: 'English', hin: 'Hindi', spa: 'Spanish', fre: 'French', fra: 'French', ger: 'German', deu: 'German', ita: 'Italian', jpn: 'Japanese', kor: 'Korean', tam: 'Tamil', tel: 'Telugu', mal: 'Malayalam', rus: 'Russian', por: 'Portuguese', chi: 'Chinese', zho: 'Chinese' };

/**
 * The final call from all the evidence. The AI only counts when it's confident: an unsure model never
 * overrides the measurements. (Shared with scripts/ai-bench.ts so the benchmark scores real decisions.)
 */
export function decideOutcome(e: {
  dangerous: boolean;
  nameTheater: boolean;
  runtimeCheck: Verdict['runtimeCheck'];
  fileIssueCount: number;
  ai: { match: boolean; kind: string; isFullFeature: boolean; confidence: number } | null;
}): Verdict['outcome'] {
  const ai = e.ai && e.ai.confidence >= 0.6 && e.ai.kind !== 'unknown' ? e.ai : null;
  if (e.dangerous || (ai && (!ai.match || ['wrong_title', 'fake_or_malware', 'trailer_or_sample'].includes(ai.kind)))) return 'rejected';
  if (e.nameTheater || (ai && (ai.kind === 'theater_cam' || ai.kind === 'theater_screener'))) return 'theater';
  if (e.runtimeCheck === 'short' || e.fileIssueCount || (ai && !ai.isFullFeature)) return 'suspect';
  if (e.runtimeCheck === 'ok' || (ai && ai.kind === 'full_release')) return 'verified';
  return 'suspect';
}

// --- the check -----------------------------------------------------------------------------

export interface CheckRequest {
  source: SavedSource;
  mediaType: MediaType;
  tmdbId: number;
  season?: number;
  episode?: number;
  /** Extra facts from the search result, if known. */
  release?: { size?: number; seeders?: number; indexer?: string };
  /** Re-run even if a cached verdict exists. */
  force?: boolean;
}

let queue: Promise<unknown> = Promise.resolve();
const inflight = new Map<string, Promise<Verdict>>();

/** Deep-checks a source (queued: one at a time). Cached per file unless `force`. */
export function deepCheck(req: CheckRequest): Promise<Verdict> {
  const dedupe = `${req.source.infoHash || req.source.magnet || req.source.downloadUrl}:${req.season}:${req.episode}`;
  const existing = inflight.get(dedupe);
  if (existing) return existing;
  const p = (queue = queue.catch(() => {}).then(() => runCheck(req))) as Promise<Verdict>;
  inflight.set(dedupe, p);
  p.finally(() => inflight.delete(dedupe)).catch(() => {});
  return p;
}

async function runCheck(req: CheckRequest): Promise<Verdict> {
  const details = await tmdb.details(req.mediaType, req.tmdbId);
  const folder = folderName(details.title, details.year);
  const t = await addSource(req.source, { preview: true, mediaType: req.mediaType, tmdbId: req.tmdbId, folder: folder || undefined, title: folder || details.title });
  const fileIdx = pickFile(t, req.season, req.episode);
  const cached = getVerdict(t.infoHash, fileIdx);
  if (cached && !req.force) return cached;

  busyTorrents.add(t.infoHash);
  try {
    const file = t.files[fileIdx];
    const releaseTitle = req.source.releaseTitle || t.name;
    const info = parseRelease(releaseTitle);

    // 1. File list
    const fileIssues: string[] = [];
    const total = t.files.reduce((a, f) => a + f.length, 0);
    for (const f of t.files) {
      const ext = extname(f.name).toLowerCase();
      if (DANGEROUS.has(ext)) fileIssues.push(`Contains a program file (${f.name}) — typical of fake or unsafe torrents`);
      else if (ARCHIVE.has(ext) && f.length > total * 0.3) fileIssues.push(`Video is inside an archive (${f.name})`);
    }
    if (/password/i.test(t.files.map((f) => f.name).join(' '))) fileIssues.push('Mentions a password — typical of fake torrents');
    const videos = t.files.filter((f) => VIDEO_EXT.has(extname(f.name).toLowerCase()));
    if (!info.pack && videos.length === 1 && file.length < total * 0.6) fileIssues.push(`The video is only ${Math.round((file.length / total) * 100)}% of the download`);
    if (/\bsample\b/i.test(file.path)) fileIssues.push('Picked file looks like a sample');

    // Expected runtime (minutes)
    let expectedMin = details.runtime || 0;
    let episodeName: string | undefined;
    if (req.mediaType === 'tv' && req.season != null && req.episode != null) {
      const eps = await tmdb.season(req.tmdbId, req.season).catch(() => []);
      const ep = eps.find((e) => e.number === req.episode);
      expectedMin = ep?.runtime || expectedMin;
      episodeName = ep?.name;
    }

    // 2. Probe (+ frames for the AI)
    const url = `${selfBaseUrl}/api/stream/${t.infoHash}/${fileIdx}?preview`;
    let probeResult: Verdict['probe'] = null;
    let probeError: string | undefined;
    if (hasFfmpeg) {
      try {
        probeResult = await probe(url);
      } catch (e) {
        probeError = (e as Error).message;
      }
    }
    let runtimeCheck: Verdict['runtimeCheck'] = 'unknown';
    if (probeResult?.durationSec && expectedMin) {
      const ratio = probeResult.durationSec / 60 / expectedMin;
      runtimeCheck = ratio < 0.85 ? 'short' : ratio > 1.4 ? 'long' : 'ok';
    }

    // 3. AI judge
    const s = getSettings();
    let ai: Verdict['ai'] = null;
    let aiError: string | undefined;
    if (s.aiMode !== 'off') {
      const frames: Buffer[] = [];
      if (s.aiFrames && hasFfmpeg && probeResult?.durationSec) {
        for (const pct of [0.2, 0.5, 0.8]) {
          try {
            frames.push(await frame(url, probeResult.durationSec * pct));
          } catch {
            /* a missing frame is fine */
          }
        }
      }
      try {
        const r = await judge({
          frames,
          evidence: {
            requested: {
              type: req.mediaType,
              title: details.title,
              year: details.year,
              ...(req.mediaType === 'tv' ? { season: req.season, episode: req.episode, episodeTitle: episodeName } : {}),
              expectedRuntimeMinutes: expectedMin || 'unknown',
              releaseState: details.release.state,
            },
            release: {
              name: releaseTitle,
              sizeMB: req.release?.size ? Math.round(req.release.size / 1e6) : undefined,
              seeders: req.release?.seeders,
              indexer: req.release?.indexer,
              filesInTorrent: t.files.slice(0, 25).map((f) => `${f.path} (${Math.round(f.length / 1e6)} MB)`),
            },
            file: {
              name: file.name,
              sizeMB: Math.round(file.length / 1e6),
              measuredRuntimeMinutes: probeResult?.durationSec ? Math.round(probeResult.durationSec / 6) / 10 : 'unknown',
              resolution: probeResult?.width ? `${probeResult.width}x${probeResult.height}` : 'unknown',
              videoCodec: probeResult?.videoCodec || 'unknown',
              audioTracks: probeResult?.audio.map((a) => `${a.codec} (${a.language}, ${a.channels}ch)`) || 'unknown',
              subtitleTracks: probeResult?.subtitles || [],
            },
            automatedChecks: { runtimeCheck, fileIssues, nameSuggestsTheaterCopy: info.theater },
          },
        });
        if (r) {
          const v = r.verdict;
          ai = {
            provider: r.provider,
            model: r.model,
            match: v.match,
            kind: v.kind,
            isFullFeature: v.is_full_feature,
            quality: v.quality,
            audioLanguages: v.audio_languages,
            confidence: v.confidence,
            issues: v.issues,
            summary: v.summary,
            usedFrames: r.usedFrames,
          };
        }
      } catch (e) {
        aiError = (e as Error).message;
      }
    }

    const dangerous = fileIssues.some((i) => i.startsWith('Contains a program') || i.startsWith('Mentions a password'));
    const aiSure = !!ai && ai.confidence >= 0.6 && ai.kind !== 'unknown';
    const outcome = decideOutcome({ dangerous, nameTheater: !!info.theater, runtimeCheck, fileIssueCount: fileIssues.length, ai });

    // Label: measured facts first (resolution, runtime, languages), named source from the release.
    const kindText =
      outcome === 'rejected'
        ? KIND_LABEL[aiSure ? ai!.kind : ''] || (dangerous ? 'Fake or unsafe' : 'Not this title')
        : outcome === 'theater'
          ? KIND_LABEL[(aiSure && ai!.kind === 'theater_screener') || info.theater === 'screener' ? 'theater_screener' : 'theater_cam']
          : outcome === 'suspect'
            ? runtimeCheck === 'short'
              ? 'Possibly incomplete'
              : 'Unconfirmed'
            : req.mediaType === 'tv'
              ? 'Full episode'
              : 'Full movie';
    const res = probeResult?.height ? (probeResult.width >= 3200 ? '4K' : probeResult.width >= 1800 ? '1080p' : probeResult.width >= 1200 ? '720p' : 'SD') : info.resolution || '';
    const quality = [res, outcome === 'theater' ? '' : info.source || ''].filter(Boolean).join(' ');
    const probeLangs = [...new Set((probeResult?.audio || []).map((a) => LANG[a.language] || '').filter(Boolean))];
    const aiLangs = aiSure ? ai!.audioLanguages.filter((l) => l && !/unknown|und/i.test(l)) : [];
    // Release names are more reliable than track tags (groups often tag Hindi audio as "eng").
    const nameLangs = (releaseTitle.match(/\b(Hindi|Tamil|Telugu|Malayalam|Kannada|Bengali|Marathi|Punjabi|Korean|Japanese|Spanish|French|German|Italian|Russian)\b/gi) || []).map(
      (l) => l[0].toUpperCase() + l.slice(1).toLowerCase(),
    );
    const langs = nameLangs.length && !/dual|multi/i.test(releaseTitle) ? [...new Set(nameLangs)] : probeLangs.length ? probeLangs : aiLangs;
    const label = [kindText, quality, probeResult?.durationSec ? fmtRuntime(probeResult.durationSec) : '', langs.join(', ')].filter(Boolean).join(' · ');

    const verdict: Verdict = {
      infoHash: t.infoHash,
      fileIdx,
      fileName: file.name,
      releaseTitle,
      checkedAt: Date.now(),
      outcome,
      label,
      probe: probeResult,
      runtimeCheck,
      fileIssues,
      ai,
      aiError: aiError || (probeError && !probeResult ? `Couldn't read the video: ${probeError}` : undefined),
    };
    db.verdicts[verdictKey(t.infoHash, fileIdx)] = verdict;
    save();
    console.log(`[check] ${details.title}: ${releaseTitle} -> ${outcome} (${label})${ai ? ` [${ai.provider} ${ai.model}]` : ''}${aiError ? ` [AI error: ${aiError}]` : ''}`);
    return verdict;
  } finally {
    busyTorrents.delete(t.infoHash);
    // Checked but never played: don't leave it in the cache (unless someone is previewing it right now).
    if (db.downloads[t.infoHash]?.previewOnly && !isStreaming(t.infoHash)) discardPreview(t.infoHash).catch(() => {});
  }
}
