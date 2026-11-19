import { getSettings, type MediaType } from './store.ts';

/** Compact shapes sent to the web app. Image fields are TMDB paths; the client builds URLs. */
export interface Card {
  mediaType: MediaType;
  id: number;
  title: string;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  year: string;
  /** Full release date (yyyy-mm-dd) when known, to badge "Coming soon" cards. */
  releaseDate: string;
  rating: number;
  /** Original language (ISO 639-1), e.g. "hi". */
  language: string;
  popularity?: number;
  genreIds?: number[];
}

export interface Row {
  id: string;
  title: string;
  items: Card[];
}

/**
 * Where a title is in its release cycle. Good torrents appear after the digital/physical release,
 * not the theatrical one, so "theaters" means only theater recordings are likely to exist.
 */
export interface ReleaseStatus {
  state: 'coming' | 'theaters' | 'available';
  /** Earliest theatrical (or premiere) date anywhere, yyyy-mm-dd. */
  theatrical: string | null;
  /** Earliest digital / physical / TV date anywhere. */
  digital: string | null;
  /** Next date we expect something new: release (coming) or digital release (theaters). */
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
  seasons: { number: number; name: string; episodeCount: number; posterPath: string | null }[];
  logoPath: string | null;
  release: ReleaseStatus;
  /** Title in its original language (romanised titles help torrent searches). */
  originalTitle: string;
}

export interface Episode {
  number: number;
  name: string;
  overview: string;
  stillPath: string | null;
  runtime: number | null;
  airDate: string | null;
}

export class TmdbError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

const cache = new Map<string, { at: number; data: unknown }>();
const TTL = 60 * 60 * 1000;

async function tmdb<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const key = getSettings().tmdbApiKey;
  if (!key) throw new TmdbError('TMDB API key is not set. Add it on the Settings page.', 412);

  const url = new URL(`${process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'}${path}`);
  url.searchParams.set('language', 'en-US');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  // A v4 read token is a long JWT; a v3 key is a 32-char hex string.
  const isToken = key.length > 40;
  if (!isToken) url.searchParams.set('api_key', key);

  const cacheKey = url.toString();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL) return hit.data as T;

  const res = await fetch(url, {
    headers: isToken ? { Authorization: `Bearer ${key}`, accept: 'application/json' } : { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const msg = res.status === 401 ? 'TMDB rejected the API key. Check it on the Settings page.' : `TMDB error ${res.status}`;
    throw new TmdbError(msg, res.status === 401 ? 412 : 502);
  }
  const data = (await res.json()) as T;
  cache.set(cacheKey, { at: Date.now(), data });
  return data;
}

// --- mapping -----------------------------------------------------------------

interface RawItem {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  adult?: boolean;
  original_language?: string;
  original_title?: string;
  original_name?: string;
  popularity?: number;
  genre_ids?: number[];
}

function toCard(r: RawItem, fallbackType: MediaType): Card {
  const mediaType = (r.media_type === 'tv' || r.media_type === 'movie' ? r.media_type : fallbackType) as MediaType;
  return {
    mediaType,
    id: r.id,
    title: r.title || r.name || 'Untitled',
    overview: r.overview || '',
    posterPath: r.poster_path ?? null,
    backdropPath: r.backdrop_path ?? null,
    year: (r.release_date || r.first_air_date || '').slice(0, 4),
    releaseDate: r.release_date || r.first_air_date || '',
    language: r.original_language || '',
    popularity: r.popularity || 0,
    genreIds: r.genre_ids || [],
    rating: Math.round((r.vote_average || 0) * 10) / 10,
  };
}

const cards = (results: RawItem[], type: MediaType) =>
  results.filter((r) => !r.adult && r.poster_path && (r.media_type == null || r.media_type === 'movie' || r.media_type === 'tv')).map((r) => toCard(r, type));

type Page = { results: RawItem[] };

async function row(id: string, title: string, path: string, type: MediaType, params: Record<string, string | number> = {}): Promise<Row> {
  const data = await tmdb<Page>(path, params);
  return { id, title, items: cards(data.results, type) };
}

const MOVIE_GENRES: [number, string][] = [
  [28, 'Action'],
  [35, 'Comedy'],
  [53, 'Thrillers'],
  [878, 'Sci-Fi'],
  [27, 'Horror'],
  [10749, 'Romance'],
  [16, 'Animation'],
  [99, 'Documentaries'],
];

const TV_GENRES: [number, string][] = [
  [10759, 'Action & Adventure'],
  [35, 'Comedy'],
  [18, 'Drama'],
  [80, 'Crime'],
  [10765, 'Sci-Fi & Fantasy'],
  [16, 'Animation'],
  [99, 'Docuseries'],
];

async function settled(rows: Promise<Row>[]): Promise<Row[]> {
  const out = await Promise.allSettled(rows);
  const ok = out.flatMap((r) => (r.status === 'fulfilled' && r.value.items.length ? [r.value] : []));
  if (!ok.length) {
    const firstErr = out.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (firstErr) throw firstErr.reason;
  }
  return ok;
}

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada', bn: 'Bengali', mr: 'Marathi', pa: 'Punjabi',
  ko: 'Korean', ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', tr: 'Turkish', th: 'Thai',
};
const langName = (l: string) => LANGUAGE_NAMES[l] || l.toUpperCase();

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/** Extra rows for each preferred language other than English, e.g. "Popular in Hindi". */
function languageRows(languages: string[], type?: MediaType): Promise<Row>[] {
  const out: Promise<Row>[] = [];
  for (const l of languages.filter((x) => x !== 'en').slice(0, 3)) {
    const name = langName(l);
    if (!type || type === 'movie') {
      out.push(row(`new-${l}`, `New ${name} Films`, '/discover/movie', 'movie', { with_original_language: l, sort_by: 'popularity.desc', 'primary_release_date.gte': daysAgo(150), 'primary_release_date.lte': today() }));
      out.push(row(`pop-${l}`, `Popular ${name} Films`, '/discover/movie', 'movie', { with_original_language: l, sort_by: 'popularity.desc', 'vote_count.gte': 30 }));
    }
    if (!type || type === 'tv') out.push(row(`tv-${l}`, `${name} Shows`, '/discover/tv', 'tv', { with_original_language: l, sort_by: 'popularity.desc', 'vote_count.gte': 10 }));
  }
  return out;
}

export function homeRows(languages: string[] = ['en']): Promise<Row[]> {
  const lang = languageRows(languages);
  return settled([
    row('trending', 'Trending This Week', '/trending/all/week', 'movie'),
    ...lang.slice(0, 1),
    row('popular-movies', 'Popular Movies', '/movie/popular', 'movie'),
    ...lang.slice(1, 2),
    row('popular-tv', 'Popular Shows', '/tv/popular', 'tv'),
    ...lang.slice(2),
    row('now-playing', 'New Releases', '/movie/now_playing', 'movie'),
    // Most popular films releasing after today (TMDB's /movie/upcoming is mostly films already out somewhere).
    row('upcoming', 'Coming Soon', '/discover/movie', 'movie', { 'primary_release_date.gte': today(), sort_by: 'popularity.desc' }).then((r) => ({
      ...r,
      items: r.items.filter((c) => c.releaseDate > today()),
    })),
    row('top-movies', 'Top Rated Movies', '/movie/top_rated', 'movie'),
    row('top-tv', 'Top Rated Shows', '/tv/top_rated', 'tv'),
    ...MOVIE_GENRES.slice(0, 4).map(([g, name]) =>
      row(`movie-genre-${g}`, `${name}`, '/discover/movie', 'movie', { with_genres: g, sort_by: 'popularity.desc', 'vote_count.gte': 200 }),
    ),
  ]);
}

/** Movies or Shows page; with `lang`, every row is limited to that original language. */
export function browseRows(type: MediaType, lang?: string): Promise<Row[]> {
  const genres = type === 'movie' ? MOVIE_GENRES : TV_GENRES;
  const label = type === 'movie' ? 'Movies' : 'Shows';
  if (lang) {
    const name = langName(lang);
    const base = { with_original_language: lang };
    const dateKey = type === 'movie' ? 'primary_release_date' : 'first_air_date';
    return settled([
      row(`${type}-${lang}-new`, `New ${name} ${label}`, `/discover/${type}`, type, { ...base, sort_by: 'popularity.desc', [`${dateKey}.gte`]: daysAgo(180), [`${dateKey}.lte`]: today() }),
      row(`${type}-${lang}-popular`, `Popular ${name} ${label}`, `/discover/${type}`, type, { ...base, sort_by: 'popularity.desc', 'vote_count.gte': 20 }),
      row(`${type}-${lang}-top`, `Top Rated ${name} ${label}`, `/discover/${type}`, type, { ...base, sort_by: 'vote_average.desc', 'vote_count.gte': 100 }),
      ...genres.map(([g, gname]) => row(`${type}-${lang}-genre-${g}`, `${name} ${gname}`, `/discover/${type}`, type, { ...base, with_genres: g, sort_by: 'popularity.desc', 'vote_count.gte': 10 })),
    ]);
  }
  return settled([
    row(`trending-${type}`, `Trending ${label}`, `/trending/${type}/week`, type),
    row(`popular-${type}`, `Popular ${label}`, `/${type}/popular`, type),
    row(`top-${type}`, `Top Rated ${label}`, `/${type}/top_rated`, type),
    ...genres.map(([g, name]) =>
      row(`${type}-genre-${g}`, name, `/discover/${type}`, type, { with_genres: g, sort_by: 'popularity.desc', 'vote_count.gte': 100 }),
    ),
  ]);
}

/** Candidate rows for kids' profiles (callers still filter every title by age rating). */
export function kidsRows(type?: MediaType, languages: string[] = ['en'], maxAge = 7): Promise<Row[]> {
  // Start from films already certified within the limit (US ratings are the most complete).
  const cert = { certification_country: 'US', 'certification.lte': maxAge >= 16 ? 'PG-13' : 'PG' };
  const rows: Promise<Row>[] = [];
  if (!type || type === 'movie') {
    rows.push(row('kids-family', 'Family Movies', '/discover/movie', 'movie', { ...cert, with_genres: 10751, sort_by: 'popularity.desc', 'vote_count.gte': 100 }));
    rows.push(row('kids-animation', 'Animated Movies', '/discover/movie', 'movie', { ...cert, with_genres: 16, sort_by: 'popularity.desc', 'vote_count.gte': 100 }));
    rows.push(row('kids-new', 'New for Kids', '/discover/movie', 'movie', { ...cert, with_genres: '10751|16', sort_by: 'popularity.desc', 'primary_release_date.gte': daysAgo(365), 'primary_release_date.lte': today() }));
    if (maxAge >= 12) rows.push(row('kids-adventure', 'Adventures', '/discover/movie', 'movie', { ...cert, with_genres: 12, sort_by: 'popularity.desc', 'vote_count.gte': 300 }));
    for (const l of languages.filter((x) => x !== 'en').slice(0, 2)) {
      rows.push(row(`kids-${l}`, `${langName(l)} Family Films`, '/discover/movie', 'movie', { with_original_language: l, with_genres: '10751|16', sort_by: 'popularity.desc', 'vote_count.gte': 5 }));
    }
  }
  if (!type || type === 'tv') {
    rows.push(row('kids-tv', 'Kids Shows', '/discover/tv', 'tv', { with_genres: 10762, sort_by: 'popularity.desc', 'vote_count.gte': 20 }));
    rows.push(row('kids-tv-animation', 'Cartoons', '/discover/tv', 'tv', { with_genres: 16, sort_by: 'popularity.desc', 'vote_count.gte': 50 }));
    rows.push(row('kids-tv-family', 'Family Shows', '/discover/tv', 'tv', { with_genres: 10751, sort_by: 'popularity.desc', 'vote_count.gte': 30 }));
  }
  return settled(rows);
}

// --- search ---------------------------------------------------------------------------------

const norm = (x: string) =>
  x
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9ऀ-ॿ]+/g, ' ') // keep Devanagari for Hindi titles
    .trim();

export interface SearchPerson {
  id: number;
  name: string;
  profilePath: string | null;
  knownFor: string;
}

/**
 * Movies and shows searched separately (2 pages each), then ranked: exact title (ignoring
 * punctuation, so "Mrs" = "Mrs.") > preferred languages > popularity. "Title 2025" narrows by year.
 */
export async function search(query: string, opts: { languages?: string[]; page?: number } = {}): Promise<{ results: Card[]; people: SearchPerson[]; hasMore: boolean }> {
  const languages = opts.languages?.length ? opts.languages : ['en'];
  const page = Math.max(1, opts.page || 1);
  const m = query.trim().match(/^(.*\S)\s+\(?((?:19|20)\d{2})\)?$/);
  const text = m ? m[1] : query.trim();
  const year = m ? m[2] : undefined;
  const pages = [page * 2 - 1, page * 2];

  const reqs: Promise<Page & { total_pages?: number }>[] = [];
  for (const p of pages) {
    reqs.push(tmdb<Page & { total_pages?: number }>('/search/movie', { query: text, include_adult: 'false', page: p, ...(year ? { primary_release_year: year } : {}) }).catch(() => ({ results: [] })));
    reqs.push(tmdb<Page & { total_pages?: number }>('/search/tv', { query: text, include_adult: 'false', page: p, ...(year ? { first_air_date_year: year } : {}) }).catch(() => ({ results: [] })));
  }
  const peopleReq = page === 1 && !year ? tmdb<{ results: { id: number; name: string; profile_path: string | null; known_for_department?: string; popularity?: number }[] }>('/search/person', { query: text, include_adult: 'false' }).catch(() => ({ results: [] })) : Promise.resolve({ results: [] });
  const [pagesOut, people] = await Promise.all([Promise.all(reqs), peopleReq]);

  const raw: { r: RawItem; type: MediaType }[] = [];
  pagesOut.forEach((d, i) => (d.results || []).forEach((r) => raw.push({ r, type: i % 2 === 0 ? 'movie' : 'tv' })));
  const hasMore = pagesOut.some((d) => (d.total_pages || 0) > pages[1]);

  const q = norm(text);
  const seen = new Set<string>();
  const scored = raw
    .filter(({ r }) => !r.adult && r.poster_path)
    .map(({ r, type }) => {
      const titles = [r.title, r.name, r.original_title, r.original_name].filter(Boolean).map((t) => norm(t!));
      const exact = titles.some((t) => t === q);
      const starts = !exact && titles.some((t) => t.startsWith(q + ' '));
      const langIdx = languages.indexOf(r.original_language || '');
      const score =
        (exact ? 1000 : starts ? 300 : 0) + (langIdx >= 0 ? 200 - langIdx * 40 : 0) + Math.log10(1 + (r.popularity || 0)) * 40 + Math.log10(1 + (r.vote_count || 0)) * 10;
      return { card: toCard({ ...r, media_type: type }, type), score };
    })
    .filter(({ card }) => {
      const k = `${card.mediaType}:${card.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.score - a.score);

  return {
    results: scored.map((x) => x.card),
    people: (people.results || [])
      .filter((p) => p.profile_path && (p.popularity || 0) > 1)
      .slice(0, 4)
      .map((p) => ({ id: p.id, name: p.name, profilePath: p.profile_path, knownFor: p.known_for_department || '' })),
    hasMore,
  };
}

export interface DiscoverFilters {
  type: 'all' | MediaType;
  language?: string;
  genre?: string; // genre name (mapped to each type's id)
  decade?: 'this-year' | '2020s' | '2010s' | '2000s' | 'older';
  sort: 'popular' | 'newest' | 'top';
  page?: number;
}

const GENRE_IDS: Record<string, { movie?: number; tv?: number }> = {
  Action: { movie: 28, tv: 10759 }, Adventure: { movie: 12, tv: 10759 }, Animation: { movie: 16, tv: 16 }, Comedy: { movie: 35, tv: 35 },
  Crime: { movie: 80, tv: 80 }, Documentary: { movie: 99, tv: 99 }, Drama: { movie: 18, tv: 18 }, Family: { movie: 10751, tv: 10751 },
  Fantasy: { movie: 14, tv: 10765 }, History: { movie: 36 }, Horror: { movie: 27 }, Music: { movie: 10402 }, Mystery: { movie: 9648, tv: 9648 },
  Romance: { movie: 10749 }, 'Sci-Fi': { movie: 878, tv: 10765 }, Thriller: { movie: 53 }, War: { movie: 10752, tv: 10768 }, Western: { movie: 37, tv: 37 },
  Kids: { tv: 10762 }, Reality: { tv: 10764 }, 'Talk Show': { tv: 10767 },
};
export const genreNames = () => Object.keys(GENRE_IDS);

/** Browse without typing: filters map onto TMDB's discover endpoints. */
export async function discover(f: DiscoverFilters): Promise<{ results: Card[]; hasMore: boolean }> {
  const year = new Date().getFullYear();
  const range: Record<string, [string, string]> = {
    'this-year': [`${year}-01-01`, today()],
    '2020s': ['2020-01-01', today()],
    '2010s': ['2010-01-01', '2019-12-31'],
    '2000s': ['2000-01-01', '2009-12-31'],
    older: ['1900-01-01', '1999-12-31'],
  };
  const types: MediaType[] = f.type === 'all' ? ['movie', 'tv'] : [f.type];
  const page = Math.max(1, f.page || 1);
  const outs = await Promise.all(
    types.map(async (type) => {
      const params: Record<string, string | number> = { include_adult: 'false', page };
      if (f.language) params.with_original_language = f.language;
      if (f.genre) {
        const g = GENRE_IDS[f.genre]?.[type];
        if (!g) return { results: [] as RawItem[], total_pages: 0, type };
        params.with_genres = g;
      }
      const dk = type === 'movie' ? 'primary_release_date' : 'first_air_date';
      const [from, to] = f.decade ? range[f.decade] : ['', today()];
      if (from) params[`${dk}.gte`] = from;
      params[`${dk}.lte`] = to;
      params.sort_by = f.sort === 'newest' ? `${dk}.desc` : f.sort === 'top' ? 'vote_average.desc' : 'popularity.desc';
      params['vote_count.gte'] = f.sort === 'top' ? (f.language && f.language !== 'en' ? 30 : 200) : f.sort === 'newest' ? 3 : 10;
      const d = await tmdb<Page & { total_pages?: number }>(`/discover/${type}`, params);
      return { results: d.results, total_pages: d.total_pages || 0, type };
    }),
  );
  const cards = outs.flatMap((o) => cards_(o.results, o.type));
  if (f.type === 'all') cards.sort((a, b) => (f.sort === 'newest' ? b.releaseDate.localeCompare(a.releaseDate) : f.sort === 'top' ? b.rating - a.rating : (b.popularity || 0) - (a.popularity || 0)));
  return { results: cards, hasMore: outs.some((o) => o.total_pages > page) };
}
const cards_ = (results: RawItem[], type: MediaType) => cards(results.map((r) => ({ ...r, media_type: type })), type);

/** A person's films and shows, most popular first. */
export async function personCredits(id: number): Promise<{ name: string; profilePath: string | null; results: Card[] }> {
  const [p, c] = await Promise.all([
    tmdb<{ name: string; profile_path: string | null }>(`/person/${id}`),
    tmdb<{ cast?: RawItem[]; crew?: (RawItem & { job?: string })[] }>(`/person/${id}/combined_credits`),
  ]);
  const all = [...(c.cast || []), ...(c.crew || []).filter((x) => x.job === 'Director')];
  const seen = new Set<string>();
  const results = cards(all, 'movie')
    .filter((x) => {
      const k = `${x.mediaType}:${x.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  return { name: p.name, profilePath: p.profile_path, results };
}

export const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;

/** TMDB release types: 1 Premiere (ignored), 2 Theatrical (limited), 3 Theatrical, 4 Digital, 5 Physical, 6 TV. */
function movieRelease(r: RawDetails): ReleaseStatus {
  const now = today();
  const theatrical: string[] = [];
  const digital: string[] = [];
  for (const country of r.release_dates?.results || []) {
    for (const rd of country.release_dates || []) {
      const d = (rd.release_date || '').slice(0, 10);
      if (!d) continue;
      if (rd.type >= 4) digital.push(d);
      else if (rd.type >= 2) theatrical.push(d); // type 1 = premiere (red carpet), not a public release
    }
  }
  const min = (xs: string[]) => (xs.length ? xs.sort()[0] : null);
  const firstTheatrical = min(theatrical) || (r.release_date ? r.release_date : null);
  const firstDigital = min(digital);
  const base = { theatrical: firstTheatrical, digital: firstDigital, nextEpisode: null };

  if (firstDigital && firstDigital <= now) return { ...base, state: 'available', expected: null };
  if (firstTheatrical && firstTheatrical <= now) {
    // Long after the theatrical run a digital release almost certainly exists even if TMDB lacks the date.
    if (daysBetween(firstTheatrical, now) > 120) return { ...base, state: 'available', expected: null };
    return { ...base, state: 'theaters', expected: firstDigital };
  }
  const upcoming = [firstTheatrical, firstDigital].filter((d): d is string => !!d && d > now).sort()[0] || null;
  return { ...base, state: 'coming', expected: upcoming };
}

function tvRelease(r: RawDetails): ReleaseStatus {
  const now = today();
  const first = r.first_air_date || null;
  const next = r.next_episode_to_air;
  const nextEpisode = next?.air_date ? { season: next.season_number, episode: next.episode_number, airDate: next.air_date, name: next.name || '' } : null;
  if (!first || first > now) return { state: 'coming', theatrical: null, digital: first, expected: first, nextEpisode };
  return { state: 'available', theatrical: null, digital: first, expected: null, nextEpisode };
}

interface RawDetails extends RawItem {
  tagline?: string;
  genres?: { name: string }[];
  runtime?: number;
  episode_run_time?: number[];
  imdb_id?: string;
  external_ids?: { imdb_id?: string };
  credits?: { cast?: { name: string }[] };
  videos?: { results?: { key: string; site: string; type: string; official?: boolean }[] };
  images?: { logos?: { file_path: string; iso_639_1: string | null }[] };
  seasons?: { season_number: number; name: string; episode_count: number; poster_path: string | null }[];
  release_dates?: { results?: { iso_3166_1: string; release_dates?: { type: number; release_date: string }[] }[] };
  next_episode_to_air?: { season_number: number; episode_number: number; air_date: string | null; name?: string } | null;
}

export async function details(type: MediaType, id: number): Promise<Details> {
  const r = await tmdb<RawDetails>(`/${type}/${id}`, {
    append_to_response: type === 'movie' ? 'credits,videos,external_ids,images,release_dates' : 'credits,videos,external_ids,images',
    include_image_language: 'en,null',
  });
  const trailer =
    r.videos?.results?.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official) ||
    r.videos?.results?.find((v) => v.site === 'YouTube' && v.type === 'Trailer');
  const logo = r.images?.logos?.find((l) => l.iso_639_1 === 'en') || r.images?.logos?.[0];
  return {
    ...toCard(r, type),
    mediaType: type,
    tagline: r.tagline || '',
    genres: (r.genres || []).map((g) => g.name),
    runtime: r.runtime || r.episode_run_time?.[0] || null,
    imdbId: r.imdb_id || r.external_ids?.imdb_id || null,
    cast: (r.credits?.cast || []).slice(0, 6).map((c) => c.name),
    trailerKey: trailer?.key || null,
    logoPath: logo?.file_path || null,
    seasons: (r.seasons || [])
      .filter((s) => s.season_number > 0 && s.episode_count > 0)
      .map((s) => ({ number: s.season_number, name: s.name, episodeCount: s.episode_count, posterPath: s.poster_path })),
    release: type === 'movie' ? movieRelease(r) : tvRelease(r),
    originalTitle: r.original_title || r.original_name || '',
  };
}

export async function season(id: number, n: number): Promise<Episode[]> {
  const r = await tmdb<{
    episodes?: { episode_number: number; name: string; overview: string; still_path: string | null; runtime: number | null; air_date: string | null }[];
  }>(`/tv/${id}/season/${n}`);
  return (r.episodes || []).map((e) => ({
    number: e.episode_number,
    name: e.name,
    overview: e.overview,
    stillPath: e.still_path,
    runtime: e.runtime,
    airDate: e.air_date,
  }));
}

// --- age ratings ------------------------------------------------------------------------------

/** Certificate -> minimum age, per rating system. Unknown certificates are ignored. */
const AGE: Record<string, Record<string, number>> = {
  // PG / TV-PG = 7+, matching how streaming services group them ("7+").
  US: { G: 0, PG: 7, 'PG-13': 13, R: 17, 'NC-17': 18, 'TV-Y': 0, 'TV-Y7': 7, 'TV-Y7-FV': 7, 'TV-G': 0, 'TV-PG': 7, 'TV-14': 14, 'TV-MA': 17 },
  IN: { U: 0, UA: 12, 'U/A': 12, 'UA 7+': 7, 'UA7+': 7, 'UA 13+': 13, 'UA13+': 13, 'UA 16+': 16, 'UA16+': 16, A: 18, S: 18 },
  GB: { U: 0, PG: 7, '12A': 12, '12': 12, '15': 15, '18': 18, R18: 18 },
  NZ: { G: 0, PG: 7, M: 13, R13: 13, RP13: 13, R15: 15, R16: 16, RP16: 16, R18: 18, RP18: 18, R: 18 },
  AU: { G: 0, PG: 7, M: 15, 'MA15+': 15, MA: 15, 'R18+': 18, 'X18+': 18, P: 0, C: 0 },
  CA: { G: 0, PG: 7, '14A': 14, '18A': 18, R: 18, A: 18, C: 0, C8: 8, '14+': 14, '18+': 18 },
  IE: { G: 0, PG: 7, '12A': 12, '15A': 15, '16': 16, '18': 18 },
};

function certAge(country: string, cert: string): number | null {
  const c = cert.trim().toUpperCase();
  if (!c || c === 'NR' || c === 'NOT RATED' || c === 'UNRATED') return null;
  const table = AGE[country];
  if (table && table[c] != null) return table[c];
  // Many countries use plain ages: "12", "16", "13+", "FSK 12", "-12".
  const n = c.match(/^(?:FSK\s*|-)?(\d{1,2})\+?$/);
  return n ? Number(n[1]) : null;
}

/**
 * Age for a title: the strictest rating among the main rating systems (India, US, UK, NZ, Australia,
 * Canada, Ireland). If none of those rated it, the typical (median) age from other countries.
 * Null when nobody rated it. (Taking the strictest of 50+ countries hid most family films.)
 */
export async function ageRating(type: MediaType, id: number): Promise<number | null> {
  const ratings: { country: string; age: number }[] = [];
  if (type === 'movie') {
    const r = await tmdb<{ results?: { iso_3166_1: string; release_dates?: { certification?: string }[] }[] }>(`/movie/${id}/release_dates`);
    for (const c of r.results || []) for (const rd of c.release_dates || []) if (rd.certification) addAge(ratings, c.iso_3166_1, rd.certification);
  } else {
    const r = await tmdb<{ results?: { iso_3166_1: string; rating?: string }[] }>(`/tv/${id}/content_ratings`);
    for (const c of r.results || []) if (c.rating) addAge(ratings, c.iso_3166_1, c.rating);
  }
  const main = ratings.filter((x) => x.country in AGE).map((x) => x.age);
  if (main.length) return Math.max(...main);
  const others = ratings.map((x) => x.age).sort((a, b) => a - b);
  return others.length ? others[Math.floor((others.length - 1) / 2)] : null;
}

function addAge(out: { country: string; age: number }[], country: string, cert: string): void {
  const age = certAge(country, cert);
  if (age != null) out.push({ country, age });
}

/** Applies browse filters to already-fetched titles (used for text search + filters). */
export function matchesFilters(c: Card, f: Partial<DiscoverFilters>): boolean {
  if (f.type && f.type !== 'all' && c.mediaType !== f.type) return false;
  if (f.language && c.language !== f.language) return false;
  if (f.genre) {
    const id = GENRE_IDS[f.genre]?.[c.mediaType];
    if (!id || !(c.genreIds || []).includes(id)) return false;
  }
  if (f.decade) {
    const y = Number(c.year);
    const now = new Date().getFullYear();
    const ok = { 'this-year': y === now, '2020s': y >= 2020, '2010s': y >= 2010 && y < 2020, '2000s': y >= 2000 && y < 2010, older: y > 0 && y < 2000 }[f.decade];
    if (!ok) return false;
  }
  return true;
}

// --- suggestions ------------------------------------------------------------------------------

/** What suggestions need to know about a title someone watched: genres, language, main people. */
export interface TitleFacts {
  card: Card;
  genreIds: number[];
  people: { id: number; name: string; role: 'cast' | 'director' | 'creator' }[];
}

export async function facts(type: MediaType, id: number): Promise<TitleFacts> {
  const r = await tmdb<
    RawItem & {
      genres?: { id: number }[];
      credits?: { cast?: { id: number; name: string; order?: number }[]; crew?: { id: number; name: string; job?: string }[] };
      created_by?: { id: number; name: string }[];
    }
  >(`/${type}/${id}`, { append_to_response: 'credits' });
  const people: TitleFacts['people'] = [
    ...(r.credits?.crew || []).filter((c) => c.job === 'Director').slice(0, 1).map((c) => ({ id: c.id, name: c.name, role: 'director' as const })),
    ...(r.created_by || []).slice(0, 1).map((c) => ({ id: c.id, name: c.name, role: 'creator' as const })),
    ...(r.credits?.cast || []).slice(0, 3).map((c) => ({ id: c.id, name: c.name, role: 'cast' as const })),
  ];
  const genreIds = (r.genres || []).map((g) => g.id);
  return { card: { ...toCard({ ...r, genre_ids: genreIds }, type), mediaType: type }, genreIds, people };
}

/** TMDB's "people who liked this also liked" list, falling back to similar titles. */
export async function recommendations(type: MediaType, id: number): Promise<Card[]> {
  const rec = await tmdb<Page>(`/${type}/${id}/recommendations`).catch(() => ({ results: [] }) as Page);
  if (rec.results.length >= 8) return cards_(rec.results, type);
  const sim = await tmdb<Page>(`/${type}/${id}/similar`).catch(() => ({ results: [] }) as Page);
  return cards_([...rec.results, ...sim.results], type);
}

export async function discoverCards(type: MediaType, params: Record<string, string | number>): Promise<Card[]> {
  const r = await tmdb<Page>(`/discover/${type}`, { include_adult: 'false', ...params });
  return cards_(r.results, type);
}

const GENRE_NAMES_BY_ID: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
  14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 53: 'Thriller',
  10752: 'War', 37: 'Western', 10759: 'Action & Adventure', 10762: 'Kids', 10764: 'Reality', 10765: 'Sci-Fi & Fantasy',
  10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics', 10770: 'TV Movie',
};
export const genreName = (id: number) => GENRE_NAMES_BY_ID[id] || '';
export const languageName = langName;
