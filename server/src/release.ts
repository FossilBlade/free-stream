/**
 * Parses scene-style release names ("Movie.Name.2021.1080p.WEB-DL.x264.AAC-GRP")
 * into tags, and estimates how likely the file is to play directly in a browser/TV
 * (we stream the raw file, no transcoding).
 */

export interface ReleaseInfo {
  resolution: '2160p' | '1080p' | '720p' | '480p' | null;
  codec: 'H.264' | 'HEVC' | 'AV1' | 'XviD' | null;
  source: string | null;
  hdr: 'DV' | 'HDR' | null;
  audio: string | null;
  season: number | null;
  episode: number | null;
  /** True for full-season / multi-season packs. */
  pack: boolean;
  /** Low-quality theatre recordings. */
  cam: boolean;
  /** What kind of theater copy, if it is one: a camera recording or a leaked screener. */
  theater: 'cam' | 'screener' | null;
  /** Trailers, samples, teasers: never the actual film. */
  extra: boolean;
  /** Audio languages named in the release, e.g. ["Hindi", "English"]. */
  languages: string[];
  /** "Dual audio" / "Multi audio" releases. */
  multiAudio: boolean;
}

export type Playability = 'good' | 'ok' | 'risky';

const has = (s: string, re: RegExp) => re.test(s);

export function parseRelease(title: string): ReleaseInfo {
  const t = title.replace(/[._]/g, ' ');

  const resolution = has(t, /\b(2160p|4k|uhd)\b/i)
    ? '2160p'
    : has(t, /\b1080[pi]\b/i)
      ? '1080p'
      : has(t, /\b720p\b/i)
        ? '720p'
        : has(t, /\b(480p|576p|dvdrip|sd)\b/i)
          ? '480p'
          : null;

  const codec = has(t, /\b(x265|h ?265|hevc)\b/i)
    ? 'HEVC'
    : has(t, /\bav1\b/i)
      ? 'AV1'
      : has(t, /\b(x264|h ?264|avc)\b/i)
        ? 'H.264'
        : has(t, /\b(xvid|divx)\b/i)
          ? 'XviD'
          : null;

  const source = has(t, /\bremux\b/i)
    ? 'Remux'
    : has(t, /\b(blu-?ray|bdrip|brrip)\b/i)
      ? 'BluRay'
      : has(t, /\bweb-?dl\b/i)
        ? 'WEB-DL'
        : has(t, /\bweb-?rip\b/i)
          ? 'WEBRip'
          : has(t, /\bweb\b/i)
            ? 'WEB'
            : has(t, /\bhdtv\b/i)
              ? 'HDTV'
              : null;

  const hdr = has(t, /\b(dv|dovi|dolby ?vision)\b/i) ? 'DV' : has(t, /\bhdr(10)?(\+|plus)?\b/i) ? 'HDR' : null;

  const audio = has(t, /\btruehd\b/i)
    ? 'TrueHD'
    : has(t, /\bdts(-?hd|-?x)?\b/i)
      ? 'DTS'
      : has(t, /\b(ddp|dd\+|e-?ac-?3)/i)
        ? 'EAC3'
        : has(t, /\b(dd|ac-?3)\s?\d?/i)
          ? 'AC3'
          : has(t, /\baac/i)
            ? 'AAC'
            : null;

  const se = t.match(/\bS(\d{1,2})\s?E(\d{1,3})\b/i) || t.match(/\b(\d{1,2})x(\d{2,3})\b/);
  const seasonOnly = t.match(/\b(?:S|Season\s?)(\d{1,2})\b(?!\s?E\d)/i);
  const season = se ? Number(se[1]) : seasonOnly ? Number(seasonOnly[1]) : null;
  const episode = se ? Number(se[2]) : null;
  const pack = !episode && (season != null || has(t, /\b(complete|seasons?\s?\d+\s?-\s?\d+|S\d{1,2}\s?-\s?S?\d{1,2})\b/i));

  const cam = has(t, /\b(cam|camrip|hdcam|hqcam|ts|telesync|hdts|tc|telecine|hdtc|pre-?dvd(rip)?|s-?print)\b/i);
  const screener = has(t, /\b(dvd-?scr|scr|screener|bd-?scr|web-?scr)\b/i);
  const theater = cam ? 'cam' : screener ? 'screener' : null;
  const extra = has(t, /\b(trailer|teaser|sample|promo|featurette|behind the scenes)\b/i);

  const LANGS = ['Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam', 'Kannada', 'Bengali', 'Marathi', 'Punjabi', 'Korean', 'Japanese', 'Spanish', 'French'];
  const languages = LANGS.filter((l) => new RegExp(`\\b${l}\\b`, 'i').test(t));
  if (/\b(hin|hindi)[ -]?(eng|english)\b|\b(eng|english)[ -]?(hin|hindi)\b/i.test(t)) for (const l of ['Hindi', 'English']) if (!languages.includes(l)) languages.push(l);
  const multiAudio = has(t, /\b(dual|multi)[ -]?audio\b|\bdual\b|\bmulti\b/i);

  return { resolution, codec, source, hdr, audio, season, episode, pack, cam, theater, extra, languages, multiAudio };
}

/**
 * Direct-play estimate. H.264 + AAC/AC3/EAC3 plays almost everywhere (LG webOS plays AC3/EAC3; Chrome/Safari play AAC).
 * HEVC plays on LG TVs and Safari, and in Chrome on Macs with hardware decoding.
 * DTS/TrueHD audio and AV1/XviD video are the usual failures.
 */
export function playability(r: ReleaseInfo): Playability {
  if (r.codec === 'AV1' || r.codec === 'XviD' || r.audio === 'DTS' || r.audio === 'TrueHD' || r.source === 'Remux') return 'risky';
  if (r.codec === 'HEVC' || r.hdr) return 'ok';
  return 'good';
}

/**
 * Best-effort "Title (Year)" from a release name, for naming folders when nothing better is known.
 * "www.Site.org - The.Odyssey.2026.1080p.WEB-DL" -> "The Odyssey (2026)". Returns null if no year is found.
 */
export function guessTitle(releaseName: string): string | null {
  const t = releaseName
    .replace(/^\s*(?:www\.)?[\w-]+\.(?:org|com|net|to|se|cc|me|io|tv|xyz|info)\s*-+\s*/i, '') // leading site tag
    .replace(/^\s*\[[^\]]*\]\s*/, '') // leading [group]
    .replace(/[._]+/g, ' ');
  // Everything before the first quality/episode tag is "title [year]".
  const q = t.search(/\b(2160p|1080p|720p|480p|4k|uhd|web|webrip|web-dl|bluray|blu-ray|brrip|bdrip|hdtv|hdrip|x264|x265|h 26[45]|hevc|S\d{1,2}E\d{1,3}|S\d{1,2}|complete)\b/i);
  const head = (q > 0 ? t.slice(0, q) : t).replace(/[\s(\[\-]+$/, '');
  // The year is the last one in that part ("Blade Runner 2049 2017" -> 2017).
  const years = [...head.matchAll(/(^|[\s(\[-])((?:19|20)\d{2})(?=[\s)\].-]|$)/g)].filter((m) => (m.index || 0) > 0);
  const y = years[years.length - 1];
  const title = (y ? head.slice(0, y.index) : q > 0 ? head : '').replace(/[\s(\[\-]+$/, '').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  return y ? `${title} (${y[2]})` : title;
}

/** Removes leading site tags and group brackets: "www.Site.com - Name…", "[Group] Name…". */
export function stripSiteTag(name: string): string {
  return name
    .replace(/^\s*(?:www\.)?[\w-]+\.(?:org|com|net|to|se|cc|me|io|tv|xyz|info|company|world|click|lol|pics|art|vip|ws|in|mx|bz|gg)\s*-+\s*/i, '')
    .replace(/^\s*\[[^\]]*\]\s*/, '');
}
