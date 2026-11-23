/**
 * Live conversion with ffmpeg, for files a device can't play directly (most often AC3/E-AC3/DTS
 * audio in Chrome, or HEVC/AV1 video where there's no decoder).
 *
 * ffmpeg reads our own range-capable stream URL (so it pulls torrent pieces like a player would) and
 * writes fragmented MP4 to the response as it goes:
 *  - audio: AAC stereo, or AC3 5.1 for devices that decode Dolby;
 *  - video: copied as-is when the device can decode it, otherwise re-encoded to H.264 (CPU heavy).
 *
 * Sync rests on one rule: every sample keeps the timestamp it has in the source file. Nothing is
 * predicted, trimmed to match or delayed to compensate:
 *  - `-copyts -start_at_zero`: output time = position in the file, so the player's clock (and subtitles)
 *    need no offset, and a seek's real start is simply where the stream begins;
 *  - `-noaccurate_seek`: audio starts where the demuxer lands (the keyframe before the target) like the
 *    copied video, instead of being cut to the exact target while the video starts seconds earlier;
 *  - `frag_discont` + `-use_editlist 0` + `make_non_negative`: each track's fragments carry its real start
 *    time. (By default the muxer rebases tracks to 0 and stretches a late track's first sample to cover
 *    the gap, and leaves the B-frame delay to an edit list that streamed MP4 players ignore: that put
 *    audio up to a whole keyframe interval ahead of the picture after every seek.)
 * Seeking outside what's been converted restarts ffmpeg at the new position.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Request, Response } from 'express';
import type { Verdict } from './store.ts';
import { probe } from './verify.ts';

let selfBaseUrl = 'http://127.0.0.1:8080';
export const setTranscodeBaseUrl = (url: string) => (selfBaseUrl = url);

export interface MediaInfo {
  durationSec: number;
  videoCodec: string;
  width: number;
  height: number;
  audio: { codec: string; language: string; channels: number; title?: string; default?: boolean }[];
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

/** One conversion per file: a seek replaces the previous ffmpeg instead of running two. */
const running = new Map<string, ChildProcess>();
const MAX_RUNNING = 3;

export async function transcode(
  req: Request,
  res: Response,
  p: { infoHash: string; fileIdx: number; start: number; video: 'copy' | 'h264'; audioTrack: number; videoCodec: string; interlaced: boolean; preview: boolean; audioCodec: 'aac' | 'ac3'; audioChannels: number },
): Promise<void> {
  const key = `${p.infoHash}:${p.fileIdx}`;
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
        ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-bf', '0', '-pix_fmt', 'yuv420p', '-vf', `${p.interlaced ? 'yadif,' : ''}scale=-2:'min(1080,ih)'`, '-g', '96'];
  // AAC stereo plays everywhere; devices that decode Dolby (TVs, Safari) keep 5.1 surround as AC3.
  const audioArgs =
    p.audioCodec === 'ac3' ? ['-c:a', 'ac3', '-b:a', '448k', ...(p.audioChannels > 6 ? ['-ac', '6'] : [])] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'];
  const args = [
    '-v', 'error',
    '-rw_timeout', '60000000',
    '-copyts', '-start_at_zero',
    ...(p.start > 0 ? ['-noaccurate_seek', '-ss', p.start.toFixed(3)] : []),
    '-i', input,
    '-map', '0:v:0',
    '-map', `0:a:${p.audioTrack}?`,
    ...videoArgs,
    ...audioArgs,
    '-map_chapters', '-1', '-sn', '-dn',
    '-avoid_negative_ts', 'make_non_negative',
    '-use_editlist', '0',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+frag_discont',
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
