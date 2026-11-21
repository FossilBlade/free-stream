/**
 * Decides how this device plays a file: directly, or through the server's ffmpeg conversion
 * (AAC audio, video copied or re-encoded to H.264).
 */
import type { MediaInfo } from './api';
import { canPlayDolbyAudio, isTV } from './tv';

export type PlayMode = { kind: 'direct' } | { kind: 'convert'; video: 'copy' | 'h264'; reason: string; /** Audio track index (0-based, among audio tracks). */ audio?: number };

type AudioTrack = MediaInfo['audio'][number];

/** Profile languages (ISO 639-1) to the codes files tag audio with (ISO 639-2). */
const LANG_CODES: Record<string, string[]> = {
  en: ['eng', 'en'], hi: ['hin', 'hi'], ta: ['tam', 'ta'], te: ['tel', 'te'], ml: ['mal', 'ml'], kn: ['kan', 'kn'], bn: ['ben', 'bn'], mr: ['mar', 'mr'],
  pa: ['pan', 'pa'], ko: ['kor', 'ko'], ja: ['jpn', 'ja'], zh: ['chi', 'zho', 'zh'], es: ['spa', 'es'], fr: ['fre', 'fra', 'fr'], de: ['ger', 'deu', 'de'],
  it: ['ita', 'it'], tr: ['tur', 'tr'], th: ['tha', 'th'],
};
const TRACK_LANG: Record<string, string> = {
  eng: 'English', hin: 'Hindi', tam: 'Tamil', tel: 'Telugu', mal: 'Malayalam', kan: 'Kannada', ben: 'Bengali', mar: 'Marathi', pan: 'Punjabi', kor: 'Korean',
  jpn: 'Japanese', chi: 'Chinese', zho: 'Chinese', spa: 'Spanish', fre: 'French', fra: 'French', ger: 'German', deu: 'German', ita: 'Italian', tur: 'Turkish',
  tha: 'Thai', rus: 'Russian', por: 'Portuguese', ara: 'Arabic', urd: 'Urdu',
};
const CODEC_NAME: Record<string, string> = { aac: 'AAC', ac3: 'Dolby', eac3: 'Dolby+', dts: 'DTS', truehd: 'TrueHD', opus: 'Opus', mp3: 'MP3', flac: 'FLAC', vorbis: 'Vorbis' };

/** "Hindi · Dolby+ 5.1", or "Track 2 · AAC stereo" when the language isn't tagged. */
export function audioLabel(a: AudioTrack, i: number): string {
  const lang = TRACK_LANG[a.language] || (a.language && a.language !== 'und' ? a.language.toUpperCase() : `Track ${i + 1}`);
  const ch = a.channels >= 6 ? `${a.channels - 1}.1` : a.channels === 2 ? 'stereo' : a.channels === 1 ? 'mono' : `${a.channels}ch`;
  return `${lang} · ${CODEC_NAME[a.codec] || a.codec.toUpperCase()} ${ch}`;
}
export const audioLanguageName = (a: AudioTrack | undefined) => (a ? TRACK_LANG[a.language] || '' : '');

/** The track a player uses on its own: the one the file marks as default, else the first. */
export function defaultAudioIndex(info: MediaInfo | null): number {
  const i = info?.audio.findIndex((a) => a.default) ?? -1;
  return i >= 0 ? i : 0;
}

/**
 * The track to play: the language chosen earlier for this title, else the profile's languages in order
 * (English, then Hindi…), else the file's default.
 */
export function preferredAudioIndex(info: MediaInfo | null, languages: string[], remembered?: string | null): number {
  if (!info || info.audio.length < 2) return 0;
  if (remembered) {
    const i = info.audio.findIndex((a) => a.language === remembered);
    if (i >= 0) return i;
  }
  for (const l of languages) {
    const codes = LANG_CODES[l] || [l];
    const i = info.audio.findIndex((a) => codes.includes(a.language));
    if (i >= 0) return i;
  }
  return defaultAudioIndex(info);
}

/** Safari (and some TVs) can switch audio tracks in the player itself; Chrome can't. */
export const supportsAudioTracks = typeof HTMLMediaElement !== 'undefined' && 'audioTracks' in HTMLMediaElement.prototype;

/** What a conversion encodes the chosen track to: AAC plays everywhere; Dolby devices keep 5.1 as AC3. */
export const convertAudioCodec = (a: AudioTrack | undefined): 'aac' | 'ac3' => (a && a.codec !== 'aac' && a.channels > 2 && canPlayDolbyAudio ? 'ac3' : 'aac');

/** Remembers the chosen audio language per title (so the next episode uses it too). */
const audioKey = (type: string, id: number) => `fs-audio-${type}-${id}`;
export function rememberedAudio(type: string, id: number): string | null {
  try {
    return window.localStorage.getItem(audioKey(type, id));
  } catch {
    return null;
  }
}
export function rememberAudio(type: string, id: number, language: string): void {
  try {
    window.localStorage.setItem(audioKey(type, id), language);
  } catch {
    /* private mode */
  }
}

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

export function choosePlayMode(info: MediaInfo | null, canConvert: boolean, audioIdx = 0): PlayMode {
  if (!info || !canConvert) return { kind: 'direct' };
  const videoOk = canDecodeVideo(info.videoCodec);
  const audio = info.audio[audioIdx];
  const audioOk = !audio || canDecodeAudio(audio.codec);
  const audioName = audio ? AUDIO_NAME[audio.codec] || audio.codec.toUpperCase() : '';
  const lang = audioLanguageName(audio);
  const conv = (video: 'copy' | 'h264', reason: string): PlayMode => ({ kind: 'convert', video, reason, audio: audioIdx });
  if (!videoOk) return conv('h264', `Converting ${info.videoCodec.toUpperCase()} video for this device`);
  const needsRepack = !audioOk || !canOpenContainer(info.container);
  // Browsers can't decode interlaced H.264 once it's repackaged as MP4, so a conversion must re-encode it.
  if (needsRepack && info.interlaced && info.videoCodec === 'h264' && !isTV)
    return conv('h264', `Converting interlaced TV video${audioOk ? '' : ` and ${audioName} audio`} for this device`);
  if (!audioOk) return conv('copy', `Converting ${lang ? `${lang} ` : ''}${audioName} audio for this device`);
  if (!canOpenContainer(info.container)) return conv('copy', `Repackaging the ${info.container.toUpperCase()} file for this device`);
  // A track other than the file's default: switch it in the player if possible, otherwise repackage with it.
  if (audioIdx !== defaultAudioIndex(info) && !supportsAudioTracks) return conv('copy', `Playing ${lang || `audio track ${audioIdx + 1}`}`);
  return { kind: 'direct' };
}
