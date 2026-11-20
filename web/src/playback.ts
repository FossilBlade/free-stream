/**
 * Decides how this device plays a file: directly, or through the server's ffmpeg conversion
 * (AAC audio, video copied or re-encoded to H.264).
 */
import type { MediaInfo } from './api';
import { canPlayDolbyAudio, isTV } from './tv';

export type PlayMode = { kind: 'direct' } | { kind: 'convert'; video: 'copy' | 'h264'; reason: string };

const probeEl = typeof document !== 'undefined' ? document.createElement('video') : null;
const can = (type: string) => {
  try {
    return !!probeEl && probeEl.canPlayType(type) !== '';
  } catch {
    return false;
  }
};

export function canDecodeVideo(codec: string): boolean {
  switch (codec) {
    case 'h264':
    case 'vp8':
      return true;
    case 'hevc':
      // LG TVs decode HEVC; Chrome on Macs with hardware decoding and Safari do too.
      return isTV || can('video/mp4; codecs="hvc1.1.6.L93.B0"') || can('video/mp4; codecs="hev1.1.6.L93.B0"');
    case 'av1':
      return can('video/mp4; codecs="av01.0.05M.08"');
    case 'vp9':
      return isTV || can('video/webm; codecs="vp9"');
    default:
      return false; // MPEG-4 Part 2 (XviD/DivX), MPEG-2, VC-1…
  }
}

export function canDecodeAudio(codec: string): boolean {
  if (['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(codec)) return true;
  if (codec === 'ac3' || codec === 'eac3') return canPlayDolbyAudio;
  return false; // DTS, TrueHD, PCM in MKV…
}

/** Containers this browser can open itself. TVs also handle AVI and MPEG-TS. */
const canOpenContainer = (ext: string) => ['mkv', 'mp4', 'm4v', 'webm', 'mov'].includes(ext) || (isTV && ['avi', 'ts', 'm2ts'].includes(ext));

const AUDIO_NAME: Record<string, string> = { ac3: 'Dolby Digital (AC3)', eac3: 'Dolby Digital Plus (E-AC3)', dts: 'DTS', truehd: 'Dolby TrueHD' };

export function choosePlayMode(info: MediaInfo | null, canConvert: boolean): PlayMode {
  if (!info || !canConvert) return { kind: 'direct' };
  const videoOk = canDecodeVideo(info.videoCodec);
  // The first audio track is the one that plays by default.
  const audio = info.audio[0];
  const audioOk = !audio || canDecodeAudio(audio.codec);
  if (!videoOk) return { kind: 'convert', video: 'h264', reason: `Converting ${info.videoCodec.toUpperCase()} video for this device` };
  const audioName = audio ? AUDIO_NAME[audio.codec] || audio.codec.toUpperCase() : '';
  const needsRepack = !audioOk || !canOpenContainer(info.container);
  // Browsers can't decode interlaced H.264 once it's repackaged as MP4, so a conversion must re-encode it.
  if (needsRepack && info.interlaced && info.videoCodec === 'h264' && !isTV)
    return { kind: 'convert', video: 'h264', reason: `Converting interlaced TV video${audioOk ? '' : ` and ${audioName} audio`} for this device` };
  if (!audioOk) return { kind: 'convert', video: 'copy', reason: `Converting ${audioName} audio for this device` };
  if (!canOpenContainer(info.container)) return { kind: 'convert', video: 'copy', reason: `Repackaging the ${info.container.toUpperCase()} file for this device` };
  return { kind: 'direct' };
}
