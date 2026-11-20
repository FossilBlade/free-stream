/**
 * Live conversion with ffmpeg, for files a device can't play directly (most often AC3/E-AC3/DTS
 * audio in Chrome, or HEVC/AV1 video where there's no decoder).
 *
 * ffmpeg reads our own range-capable stream URL (so it pulls torrent pieces like a player would) and
 * writes fragmented MP4 to the response as it goes:
 *  - audio: always AAC stereo (cheap);
 *  - video: copied as-is when the device can decode it, otherwise re-encoded to H.264 (CPU heavy).
 * The output can't be seeked by byte ranges, so seeking restarts ffmpeg at `start` seconds and the
 * player adds that offset to its clock.
 *
 * Copied video can only start on a keyframe (often every 2–10 s), while converted audio would start at
 * the exact time, putting sound ahead of picture by the gap. So copy-mode conversions always start at
 * the keyframe at or before the requested time (keyframeAt), and the player uses that as its offset.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Request, Response } from 'express';
import type { Verdict } from './store.ts';
import { probe, run } from './verify.ts';

let selfBaseUrl = 'http://127.0.0.1:8080';
export const setTranscodeBaseUrl = (url: string) => (selfBaseUrl = url);

export interface MediaInfo {
  durationSec: number;
  videoCodec: string;
  width: number;
  height: number;
  audio: { codec: string; language: string; channels: number }[];
  container: string;
  interlaced: boolean;
}

const probes = new Map<string, Promise<NonNullable<Verdict['probe']>>>();

/** Our own stream URL for a file. `preview` fetches only the ranges read instead of the whole file. */
const inputUrl = (infoHash: string, fileIdx: number, preview: boolean) => `${selfBaseUrl}/api/stream/${infoHash}/${fileIdx}${preview ? '?preview' : ''}`;

/** Codecs and duration of a file (cached per torrent file; a failed probe is retried next time). */
export async function mediaInfo(infoHash: string, fileIdx: number, fileName: string, preview = false): Promise<MediaInfo> {
  const key = `${infoHash}:${fileIdx}`;
  let p = probes.get(key);
  if (!p) {
    p = probe(inputUrl(infoHash, fileIdx, preview)).then((r) => {
      if (!r) throw new Error('probe returned nothing');
      return r;
    });
    probes.set(key, p);
    p.catch(() => probes.delete(key));
  }
  const r = await p;
  return {
    durationSec: r.durationSec,
    videoCodec: r.videoCodec,
    width: r.width,
    height: r.height,
    audio: r.audio,
    container: (fileName.split('.').pop() || '').toLowerCase(),
    interlaced: !!r.interlaced,
  };
}

const keyframes = new Map<string, number>();

/** Time of the video keyframe at or before `at` seconds (where a copied-video conversion can start in sync). */
export async function keyframeAt(infoHash: string, fileIdx: number, at: number, preview = false): Promise<number> {
  if (at <= 0) return 0;
  const key = `${infoHash}:${fileIdx}:${at.toFixed(1)}`;
  const hit = keyframes.get(key);
  if (hit != null) return hit;
  try {
    const out = await run(
      'ffprobe',
      ['-v', 'error', '-rw_timeout', '30000000', '-read_intervals', `${at.toFixed(2)}%+#1`, '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', inputUrl(infoHash, fileIdx, preview)],
      30000,
    );
    const t = Number(out.toString().trim().split('\n')[0].replace(/,$/, ''));
    // Demuxers land on the keyframe before the target; anything odd falls back to the exact time.
    const k = isFinite(t) && t <= at + 0.05 && t > at - 30 ? Math.max(0, t) : at;
    if (keyframes.size > 2000) keyframes.clear();
    keyframes.set(key, k);
    return k;
  } catch {
    return at;
  }
}

/** One conversion per file: a seek replaces the previous ffmpeg instead of running two. */
const running = new Map<string, ChildProcess>();
const MAX_RUNNING = 3;

export async function transcode(
  req: Request,
  res: Response,
  p: { infoHash: string; fileIdx: number; start: number; video: 'copy' | 'h264'; audioTrack: number; videoCodec: string; interlaced: boolean; preview: boolean },
): Promise<void> {
  const key = `${p.infoHash}:${p.fileIdx}`;
  // Copied video starts on a keyframe; start the audio there too so they stay in sync.
  if (p.video === 'copy' && p.start > 0) p.start = await keyframeAt(p.infoHash, p.fileIdx, p.start, p.preview);
  if (req.destroyed) return;
  running.get(key)?.kill('SIGKILL');
  running.delete(key);
  if (running.size >= MAX_RUNNING) {
    // Free the oldest (Map keeps insertion order); a household rarely converts more than a couple at once.
    const [oldKey, oldProc] = running.entries().next().value as [string, ChildProcess];
    oldProc.kill('SIGKILL');
    running.delete(oldKey);
  }

  const input = inputUrl(p.infoHash, p.fileIdx, p.preview);
  const videoArgs =
    p.video === 'copy'
      ? ['-c:v', 'copy', ...(p.videoCodec === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
      : // Re-encode (≈2–3× real time for 1080p on an 8-core M1); broadcast captures are deinterlaced too.
        ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-vf', `${p.interlaced ? 'yadif,' : ''}scale=-2:'min(1080,ih)'`, '-g', '96'];
  const args = [
    '-v', 'error',
    '-rw_timeout', '60000000',
    ...(p.start > 0 ? ['-ss', p.start.toFixed(3)] : []),
    '-i', input,
    '-map', '0:v:0',
    '-map', `0:a:${p.audioTrack}?`,
    ...videoArgs,
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-sn', '-dn',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(key, ff);
  let err = '';
  ff.stderr.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-2000)));

  res.status(200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('X-Start', p.start.toFixed(3));
  const started = Date.now();
  let sent = 0;
  ff.stdout.on('data', (c: Buffer) => (sent += c.length));
  ff.stdout.pipe(res);

  const stop = () => {
    if (ff.exitCode == null) ff.kill('SIGKILL');
  };
  req.on('close', stop);
  res.on('close', stop);
  ff.on('close', (code, signal) => {
    if (running.get(key) === ff) running.delete(key);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    if (code && !signal) console.error(`[convert] ${key} from ${p.start.toFixed(0)}s failed after ${secs}s: ${err.trim().split('\n').pop()}`);
    else console.log(`[convert] ${key} (${p.video === 'copy' ? 'audio only' : 'video + audio'}) from ${p.start.toFixed(0)}s: ${(sent / 1048576).toFixed(1)}MB in ${secs}s`);
    if (!res.writableEnded) res.end();
  });
}
