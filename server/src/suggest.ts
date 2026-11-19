/**
 * Personal suggestions, rebuilt nightly for each profile.
 *
 * 1. Taste: from watch history and My List (finished > watching > listed; stopped early counts against).
 * 2. Candidates: real TMDB titles only — recommendations for what they liked, more from their favourite
 *    people, top titles in their favourite genres and languages, and new releases in their languages.
 * 3. Scoring plus variety rules (no AI needed).
 * 4. AI (optional): picks the best from the numbered candidate list, writes one-line reasons and names
 *    2–3 themed rows. It can only answer with numbers from the list, so it can't invent titles.
 */
import { z } from 'zod';
import { askStructured } from './llm.ts';
import { filterAllowed } from './profiles.ts';
import { db, getSettings, profileData, save, type MediaType, type Profile, type SuggestionSet } from './store.ts';
import * as tmdb from './tmdb.ts';

const DAY = 86400000;
const NIGHTLY_HOUR = 3; // local time
const titleKey = (type: MediaType, id: number) => `${type}:${id}`;

// --- 1. taste ------------------------------------------------------------------------------------

interface Seed {
  type: MediaType;
  id: number;
  title: string;
  /** Positive = liked (decays with age), negative = stopped early. */
  weight: number;
  kind: 'finished' | 'watching' | 'list' | 'stopped';
}

const decay = (at: number) => Math.pow(0.5, (Date.now() - at) / (90 * DAY)); // half weight after ~3 months

export function seedsOf(profileId: string): Seed[] {
  const data = profileData(profileId);
  const titles = new Map<string, { type: MediaType; id: number; title: string; ratio: number; episodes: number; at: number }>();
  for (const p of Object.values(data.progress)) {
    const k = titleKey(p.mediaType, p.tmdbId);
    const ratio = p.duration > 0 ? p.position / p.duration : 0;
    const t = titles.get(k) || { type: p.mediaType, id: p.tmdbId, title: p.title, ratio: 0, episodes: 0, at: 0 };
    t.ratio = Math.max(t.ratio, ratio);
    if (ratio > 0.5) t.episodes++;
    t.at = Math.max(t.at, p.updatedAt);
    titles.set(k, t);
  }
  const seeds: Seed[] = [];
  for (const t of titles.values()) {
    const stale = Date.now() - t.at > 2 * DAY;
    let weight: number;
    let kind: Seed['kind'];
    if (t.type === 'tv' && t.episodes > 0) {
      weight = Math.min(1, 0.5 + 0.15 * t.episodes);
      kind = t.episodes >= 3 ? 'finished' : 'watching';
    } else if (t.ratio >= 0.8) {
      weight = 1;
      kind = 'finished';
    } else if (t.ratio < 0.2 && stale) {
      weight = -0.5;
      kind = 'stopped';
    } else {
      weight = t.type === 'tv' ? 0.3 : 0.6;
      kind = 'watching';
    }
    seeds.push({ type: t.type, id: t.id, title: t.title, weight: weight * decay(t.at), kind });
  }
  for (const m of data.myList) {
    if (titles.has(titleKey(m.mediaType, m.tmdbId))) continue;
    seeds.push({ type: m.mediaType, id: m.tmdbId, title: m.title, weight: 0.7 * decay(m.addedAt), kind: 'list' });
  }
  return seeds.sort((a, b) => b.weight - a.weight);
}

interface Taste {
  genres: Map<number, number>;
  /** Which media type each genre id came from (movie and TV genre ids differ). */
  genreType: Map<number, MediaType>;
  langs: Map<string, number>;
  people: Map<number, { name: string; role: string; w: number }>;
  types: Map<MediaType, number>;
}

const add = <K>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) || 0) + v);
const top = <K>(m: Map<K, number>, n: number) => [...m.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n);

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]).catch(() => null);
      }
    }),
  );
  return out;
}

async function tasteOf(seeds: Seed[]): Promise<{ taste: Taste; facts: Map<string, tmdb.TitleFacts> }> {
  const used = [...seeds.filter((s) => s.weight > 0).slice(0, 15), ...seeds.filter((s) => s.weight < 0).slice(0, 5)];
  const all = await mapLimit(used, 6, (s) => tmdb.facts(s.type, s.id));
  const taste: Taste = { genres: new Map(), genreType: new Map(), langs: new Map(), people: new Map(), types: new Map() };
  const facts = new Map<string, tmdb.TitleFacts>();
  used.forEach((s, i) => {
    const f = all[i];
    if (!f) return;
    facts.set(titleKey(s.type, s.id), f);
    for (const g of f.genreIds) {
      add(taste.genres, g, s.weight);
      if (!taste.genreType.has(g)) taste.genreType.set(g, s.type);
    }
    if (s.weight > 0) {
      add(taste.langs, f.card.language, s.weight);
      add(taste.types, s.type, s.weight);
      for (const p of f.people) {
        const cur = taste.people.get(p.id) || { name: p.name, role: p.role, w: 0 };
        cur.w += s.weight;
        taste.people.set(p.id, cur);
      }
    }
  });
  return { taste, facts };
}

// --- 2. candidates --------------------------------------------------------------------------------

interface Candidate {
  card: tmdb.Card;
  /** Recommendation strength from liked titles. */
  recW: number;
  because: Map<string, number>;
  person?: string;
  score: number;
}

const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

async function gather(profile: Profile, seeds: Seed[], taste: Taste): Promise<Map<string, Candidate>> {
  const cands = new Map<string, Candidate>();
  const put = (c: tmdb.Card, f: (x: Candidate) => void) => {
    const k = titleKey(c.mediaType, c.id);
    const cur = cands.get(k) || { card: c, recW: 0, because: new Map(), score: 0 };
    f(cur);
    cands.set(k, cur);
  };
  const kid = profile.kind === 'kid';
  const cert: Record<string, string> = kid ? { certification_country: 'US', 'certification.lte': (profile.maxAge || 7) >= 16 ? 'PG-13' : 'PG' } : {};

  // "Because you watched X": TMDB recommendations for the most-liked titles.
  const liked = seeds.filter((s) => s.weight > 0).slice(0, 8);
  const recs = await mapLimit(liked, 4, (s) => tmdb.recommendations(s.type, s.id));
  liked.forEach((s, i) =>
    (recs[i] || []).slice(0, 20).forEach((c, rank) =>
      put(c, (x) => {
        const w = s.weight * (1 - rank / 30);
        x.recW += w;
        x.because.set(s.title, (x.because.get(s.title) || 0) + w);
      }),
    ),
  );

  // More from their favourite actors, directors and creators.
  const people = [...taste.people.entries()].filter(([, p]) => p.w >= 0.9).sort((a, b) => b[1].w - a[1].w).slice(0, 3);
  const credits = await mapLimit(people, 3, ([id]) => tmdb.personCredits(id));
  people.forEach(([, p], i) =>
    (credits[i]?.results || []).slice(0, 20).forEach((c) =>
      put(c, (x) => {
        x.person ||= p.role === 'cast' ? `With ${p.name}` : `From ${p.name}`;
      }),
    ),
  );

  // Highly rated titles in their favourite genres and languages.
  const langs = [...new Set([...top(taste.langs, 2).map(([l]) => l), ...profile.languages.slice(0, 2)])].slice(0, 3);
  const genres = top(taste.genres, 2).map(([g]) => g);
  const discoverJobs: { type: MediaType; params: Record<string, string | number> }[] = [];
  for (const g of genres) {
    const type = taste.genreType.get(g) || 'movie';
    for (const l of langs.slice(0, 2)) {
      discoverJobs.push({ type, params: { with_genres: g, with_original_language: l, sort_by: 'vote_average.desc', 'vote_count.gte': l === 'en' ? 400 : 40, ...(type === 'movie' ? cert : {}) } });
    }
  }
  // New in their languages (and coming soon, for the "Coming soon for you" row).
  for (const l of profile.languages.slice(0, 2)) {
    discoverJobs.push({ type: 'movie', params: { with_original_language: l, sort_by: 'popularity.desc', 'primary_release_date.gte': daysAgo(150), 'primary_release_date.lte': tmdb.today(), ...cert } });
    discoverJobs.push({ type: 'movie', params: { with_original_language: l, sort_by: 'popularity.desc', 'primary_release_date.gte': tmdb.today(), ...cert } });
  }
  if ((taste.types.get('tv') || 0) > 0) {
    for (const l of langs.slice(0, 2)) discoverJobs.push({ type: 'tv', params: { with_original_language: l, sort_by: 'popularity.desc', 'first_air_date.gte': daysAgo(365), 'vote_count.gte': 5 } });
  }
  const found = await mapLimit(discoverJobs, 4, (j) => tmdb.discoverCards(j.type, j.params));
  for (const list of found) for (const c of list || []) put(c, () => {});

  // Never suggest what they've already watched, listed, or turned down.
  const data = profileData(profile.id);
  const exclude = new Set([
    ...Object.values(data.progress).map((p) => titleKey(p.mediaType, p.tmdbId)),
    ...data.myList.map((m) => titleKey(m.mediaType, m.tmdbId)),
    ...(data.notInterested || []),
  ]);
  for (const k of exclude) cands.delete(k);
  // Very old, middling titles are rarely what anyone wants from "suggested for you".
  for (const [k, c] of cands) if (Number(c.card.year) < 1970 && c.card.rating < 7.5) cands.delete(k);
  return cands;
}

// --- 3. scoring ------------------------------------------------------------------------------------

function scoreAll(cands: Map<string, Candidate>, taste: Taste, profile: Profile): void {
  const maxGenre = Math.max(0.01, ...[...taste.genres.values()]);
  const maxLang = Math.max(0.01, ...[...taste.langs.values()]);
  const thisYear = new Date().getFullYear();
  for (const c of cands.values()) {
    const card = c.card;
    const genre = Math.min(2, (card.genreIds || []).reduce((a, g) => a + (taste.genres.get(g) || 0), 0) / maxGenre);
    const langW = (taste.langs.get(card.language) || 0) / maxLang;
    const lang = langW > 0 ? langW : profile.languages.includes(card.language) ? 0.3 : -1.5;
    const rec = Math.log2(1 + c.recW * 3) * 2;
    const person = c.person ? 1.5 : 0;
    const quality = ((card.rating || 6.5) - 6.5) * 0.6;
    const popularity = Math.log10(1 + (card.popularity || 0)) * 0.4;
    const fresh = Number(card.year) >= thisYear - 1 ? 0.5 : 0;
    c.score = genre + lang * 1.5 + rec + person + quality + popularity + fresh;
  }
}

/** Greedy pick that spreads across "because" titles and genres, so a row isn't ten near-identical films. */
function diverse(list: Candidate[], n: number): Candidate[] {
  const out: Candidate[] = [];
  const perSeed = new Map<string, number>();
  const perGenre = new Map<number, number>();
  const perLang = new Map<string, number>();
  const pool = [...list];
  while (out.length < n && pool.length) {
    let bestI = 0;
    let bestS = -Infinity;
    pool.forEach((c, i) => {
      const seed = mainBecause(c);
      const g = c.card.genreIds?.[0];
      const s =
        c.score * Math.pow(0.8, seed ? perSeed.get(seed) || 0 : 0) * Math.pow(0.88, g != null ? perGenre.get(g) || 0 : 0) * Math.pow(0.94, perLang.get(c.card.language) || 0);
      if (s > bestS) {
        bestS = s;
        bestI = i;
      }
    });
    const [c] = pool.splice(bestI, 1);
    out.push(c);
    const seed = mainBecause(c);
    if (seed) perSeed.set(seed, (perSeed.get(seed) || 0) + 1);
    const g = c.card.genreIds?.[0];
    if (g != null) perGenre.set(g, (perGenre.get(g) || 0) + 1);
    perLang.set(c.card.language, (perLang.get(c.card.language) || 0) + 1);
  }
  return out;
}

const mainBecause = (c: Candidate) => [...c.because.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

/** Reason without AI: the strongest link to their taste. `listed` = titles only in My List (not watched). */
function plainReason(c: Candidate, listed: Set<string>): string {
  const seed = mainBecause(c);
  if (seed) return listed.has(seed) ? `Like ${seed}, in your list` : `Because you watched ${seed}`;
  if (c.person) return c.person;
  const genre = tmdb.genreName(c.card.genreIds?.[0] ?? -1).replace(/ & .*/, '');
  const lang = c.card.language === 'en' ? '' : `${tmdb.languageName(c.card.language)} `;
  const kind = c.card.mediaType === 'tv' ? 'show' : 'film';
  return `${c.card.rating >= 7.5 ? 'Highly rated' : 'Popular'} ${lang}${genre ? `${genre.toLowerCase()} ` : ''}${kind}`;
}

// --- 4. AI ---------------------------------------------------------------------------------------------

const AiSchema = z.strictObject({
  picks: z.array(z.strictObject({ n: z.number().int().describe('Candidate number'), reason: z.string().describe('One short sentence, at most 12 words') })),
  rows: z.array(z.strictObject({ name: z.string().describe('Row name, 2-5 words'), items: z.array(z.number().int()).describe('Candidate numbers') })),
});

const AI_SYSTEM = `You are the recommendation engine of a family's home streaming app. You get one viewer's taste and a numbered list of real candidate movies and shows. Choose ONLY from that list, referring to items by number.

Return:
- picks: the 12 best candidates for this viewer, best first. For each, "reason": one short sentence (at most 12 words) linking it to their taste, naming a title they watched when one is similar, e.g. "A twisty Hindi crime thriller like Drishyam 2". Use only facts from the list.
- rows: 2 or 3 themed rows, each with 6 to 10 candidate numbers sharing a clear theme, and a short natural name (2 to 5 words), e.g. "Edge-of-your-seat Hindi thrillers" or "Big-screen space epics".

Rules: prefer the languages and genres they watch most, and include some titles in each of their languages; avoid genres they stopped watching; if they watch both movies and shows, include both; never use a number that is not in the list.`;

function aiPrompt(profile: Profile, seeds: Seed[], taste: Taste, list: Candidate[]): string {
  const names = (kind: Seed['kind']) =>
    seeds
      .filter((s) => s.kind === kind)
      .slice(0, 8)
      .map((s) => s.title)
      .join(', ') || '—';
  const genres = top(taste.genres, 5).map(([g]) => tmdb.genreName(g)).filter(Boolean).join(', ');
  const people = [...taste.people.values()].filter((p) => p.w >= 0.9).sort((a, b) => b.w - a.w).slice(0, 5).map((p) => p.name).join(', ');
  const lines = list.map((c, i) => {
    const k = c.card;
    const g = (k.genreIds || []).map(tmdb.genreName).filter(Boolean).slice(0, 3).join(', ');
    const overview = k.overview.split(/(?<=\.)\s/)[0].slice(0, 140);
    return `${i + 1}. ${k.title} (${k.year || '?'}) · ${k.mediaType === 'tv' ? 'show' : 'movie'} · ${tmdb.languageName(k.language)} · ${g} · ★${k.rating || '?'} · ${overview}`;
  });
  return [
    `Viewer: ${profile.name}${profile.kind === 'kid' ? ` (a child; everything listed is already within their age limit of ${profile.maxAge})` : ''}. Languages: ${profile.languages.map(tmdb.languageName).join(', ')}.`,
    `Finished: ${names('finished')}.`,
    `Watching: ${names('watching')}.`,
    `In My List: ${names('list')}.`,
    `Stopped early: ${names('stopped')}.`,
    `Favourite genres: ${genres || '—'}. Favourite people: ${people || '—'}.`,
    '',
    'Candidates:',
    ...lines,
  ].join('\n');
}

/**
 * Small models sometimes invent links ("like Game of Thrones" when it was never watched) or compare a
 * title to itself. A reason may only name titles from the viewer's history.
 */
const simple = (t: string) => t.toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim();
const ALLOWED_NAMES = new Set(
  [...Object.values(tmdb.LANGUAGE_NAMES), 'Bollywood', 'Hollywood', 'Marvel', 'DC', 'Pixar', 'Disney', 'Oscar', 'IMAX', 'Sci-Fi', 'Greek', 'Indian', 'British', 'American', 'Korean', 'Japanese', 'Christmas', 'World', 'War', 'II'].flatMap((x) => simple(x).split(' ')),
);
const CONNECTORS = new Set(['of', 'the', 'and', 'a', 'in', 'on', 'to', '&']);

/** Capitalised phrases after the first word, e.g. "Game of Thrones", "Shutter Island", "Drishyam: The Conclusion". */
function namedPhrases(reason: string): string[] {
  const words = reason.replace(/[.,!?;"“”()]/g, ' ').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    while (run.length && CONNECTORS.has(run[run.length - 1].toLowerCase())) run.pop();
    if (run.length) out.push(run.join(' '));
    run = [];
  };
  words.forEach((w, i) => {
    const cap = /^[A-Z0-9ऀ-ॿ]/.test(w);
    if (i > 0 && cap) run.push(w);
    else if (run.length && CONNECTORS.has(w.toLowerCase())) run.push(w);
    else flush();
  });
  flush();
  return out;
}

export function reasonIsGrounded(reason: string, self: string, history: string[]): boolean {
  const own = simple(self);
  if (own.length >= 3 && simple(reason).includes(own)) return false;
  const known = history.map(simple).filter((h) => h.length >= 3);
  for (const phrase of namedPhrases(reason)) {
    const ref = simple(phrase);
    if (!ref) continue;
    if (ref.split(' ').every((w) => ALLOWED_NAMES.has(w) || CONNECTORS.has(w))) continue; // "Hindi", "Sci-Fi", "Marvel"
    if (!known.some((h) => h.startsWith(ref) || ref.startsWith(h) || h.includes(ref))) return false;
  }
  return true;
}

// --- build -------------------------------------------------------------------------------------------

const AI_CANDIDATES = 40;
const ROW_SIZE = 15;

export async function buildSuggestions(profile: Profile): Promise<SuggestionSet | null> {
  const started = Date.now();
  const seeds = seedsOf(profile.id);
  if (!seeds.some((s) => s.weight > 0)) {
    delete db.suggestions[profile.id];
    save();
    return null; // nothing watched yet: Home's popular rows already cover it
  }
  const { taste } = await tasteOf(seeds);
  const cands = await gather(profile, seeds, taste);
  scoreAll(cands, taste, profile);

  let all = [...cands.values()].sort((a, b) => b.score - a.score);
  all = await filterAllowed(
    profile,
    all.map((c) => ({ ...c, mediaType: c.card.mediaType, id: c.card.id })),
  );
  const now = tmdb.today();
  const released = all.filter((c) => !c.card.releaseDate || c.card.releaseDate <= now);
  const upcoming = all.filter((c) => c.card.releaseDate && c.card.releaseDate > now);

  const shortlist = diverse(released, AI_CANDIDATES);
  const listed = new Set(seeds.filter((x) => x.kind === 'list').map((x) => x.title));
  const reasons: Record<string, string> = {};
  for (const c of shortlist) reasons[titleKey(c.card.mediaType, c.card.id)] = plainReason(c, listed);

  let topPicks = shortlist.slice(0, ROW_SIZE);
  const themed: SuggestionSet['rows'] = [];
  let ai: SuggestionSet['ai'] = null;
  let aiError: string | undefined;

  if (getSettings().suggestAi && shortlist.length >= 10) {
    const aiStarted = Date.now();
    try {
      const r = await askStructured(AiSchema, AI_SYSTEM, aiPrompt(profile, seeds, taste, shortlist), { numCtx: 8192, keepAlive: 0, name: 'suggestions' });
      if (r) {
        const history = seeds.map((x) => x.title);
        const at = (n: number) => (Number.isInteger(n) && n >= 1 && n <= shortlist.length ? shortlist[n - 1] : null);
        const seen = new Set<Candidate>();
        const picks: Candidate[] = [];
        for (const p of r.data.picks) {
          const c = at(p.n);
          if (!c || seen.has(c)) continue;
          seen.add(c);
          picks.push(c);
          const reason = p.reason.trim().replace(/\s+/g, ' ');
          if (reason.length >= 8 && reason.length <= 140 && reasonIsGrounded(reason, c.card.title, history)) reasons[titleKey(c.card.mediaType, c.card.id)] = reason;
        }
        if (picks.length < 5) throw new Error(`the answer only had ${picks.length} usable picks`);
        // AI's order first, then the best of the rest by score.
        topPicks = [...picks, ...shortlist.filter((c) => !seen.has(c))].slice(0, ROW_SIZE);
        for (const row of r.data.rows.slice(0, 3)) {
          const items = [...new Set(row.items.map(at).filter((c): c is Candidate => !!c))].slice(0, 12);
          const name = row.name.trim().replace(/\s+/g, ' ');
          if (items.length >= 5 && name.length >= 3 && name.length <= 48) themed.push({ id: `sugg-theme-${themed.length}`, title: name, items: items.map((c) => c.card) });
        }
        ai = { provider: r.provider, model: r.model, ms: Date.now() - aiStarted };
      }
    } catch (e) {
      aiError = (e as Error).message;
      console.error(`[suggest] ${profile.name}: AI step failed, using scoring only:`, aiError);
    }
  }

  const rows: SuggestionSet['rows'] = [{ id: 'sugg-top', title: `Top picks for ${profile.name}`, items: topPicks.map((c) => c.card) }];
  // "Because you watched X" for the two most-liked recent titles.
  const inTop = new Set(topPicks);
  for (const s of seeds.filter((x) => x.kind === 'finished' || x.kind === 'watching').slice(0, 2)) {
    const items = released.filter((c) => c.because.has(s.title) && !inTop.has(c)).slice(0, ROW_SIZE); // already best-first
    if (items.length < 5) continue;
    rows.push({ id: `sugg-because-${s.type}-${s.id}`, title: `Because you watched ${s.title}`, items: items.map((c) => c.card) });
    for (const c of items) reasons[titleKey(c.card.mediaType, c.card.id)] ||= `Because you watched ${s.title}`;
  }
  rows.push(...themed);
  if (upcoming.length >= 3) rows.push({ id: 'sugg-coming', title: 'Coming soon for you', items: upcoming.slice(0, ROW_SIZE).map((c) => c.card) });
  for (const c of upcoming.slice(0, ROW_SIZE)) reasons[titleKey(c.card.mediaType, c.card.id)] ||= plainReason(c, listed);

  const set: SuggestionSet = { builtAt: Date.now(), rows, reasons, ai, aiError, basedOn: seeds.filter((s) => s.weight > 0).length };
  db.suggestions[profile.id] = set;
  save();
  console.log(
    `[suggest] ${profile.name}: ${rows.length} rows from ${cands.size} candidates in ${((Date.now() - started) / 1000).toFixed(1)}s${ai ? ` (AI: ${ai.model}, ${(ai.ms / 1000).toFixed(1)}s)` : aiError ? ' (AI failed)' : ' (scoring only)'}`,
  );
  return set;
}

// --- serving ---------------------------------------------------------------------------------------

/** Stored rows minus anything watched, listed or turned down since they were built; kids re-checked against their limit. */
export async function suggestionRows(profile: Profile): Promise<tmdb.Row[]> {
  const set = db.suggestions[profile.id];
  if (!set) return [];
  const data = profileData(profile.id);
  const hide = new Set([
    ...Object.values(data.progress).map((p) => titleKey(p.mediaType, p.tmdbId)),
    ...data.myList.map((m) => titleKey(m.mediaType, m.tmdbId)),
    ...(data.notInterested || []),
  ]);
  const rows = await Promise.all(
    set.rows.map(async (r) => ({ ...r, items: await filterAllowed(profile, r.items.filter((c) => !hide.has(titleKey(c.mediaType, c.id)))) })),
  );
  return rows.filter((r) => r.items.length >= 3);
}

export function suggestedBecause(profileId: string, type: MediaType, id: number): string | null {
  const data = profileData(profileId);
  const k = titleKey(type, id);
  if (data.notInterested?.includes(k)) return null;
  return db.suggestions[profileId]?.reasons[k] || null;
}

export function markNotInterested(profileId: string, type: MediaType, id: number): void {
  const data = profileData(profileId);
  const k = titleKey(type, id);
  data.notInterested = [...new Set([...(data.notInterested || []), k])].slice(-500);
  save();
}

/** "More like this" on a title page: recommendations minus what this profile watched or turned down. */
export async function moreLikeThis(profile: Profile, type: MediaType, id: number): Promise<tmdb.Card[]> {
  const data = profileData(profile.id);
  const hide = new Set([...Object.values(data.progress).map((p) => titleKey(p.mediaType, p.tmdbId)), ...(data.notInterested || []), titleKey(type, id)]);
  const recs = (await tmdb.recommendations(type, id)).filter((c) => !hide.has(titleKey(c.mediaType, c.id)) && !(Number(c.year) < 1970 && c.rating < 7.5));
  return (await filterAllowed(profile, recs)).slice(0, 20);
}

export function suggestionStatus() {
  return Object.values(db.profiles).map((p) => {
    const s = db.suggestions[p.id];
    return {
      profileId: p.id,
      name: p.name,
      builtAt: s?.builtAt || null,
      rows: s?.rows.length || 0,
      basedOn: s?.basedOn || 0,
      ai: s?.ai || null,
      aiError: s?.aiError || null,
      building: building === p.id,
    };
  });
}

// --- schedule: nightly at 3am, plus a first build for profiles that have none ---------------------------

let building: string | null = null;
let queue: Promise<void> = Promise.resolve();

/** Builds profiles one at a time (the local model only loads once at a time). */
export function rebuild(profileIds: string[]): void {
  for (const id of profileIds) {
    queue = queue.then(async () => {
      const p = db.profiles[id];
      if (!p) return;
      building = id;
      try {
        await buildSuggestions(p);
      } catch (e) {
        console.error(`[suggest] ${p.name}:`, (e as Error).message);
      } finally {
        building = null;
      }
    });
  }
}

function lastNightly(): number {
  const d = new Date();
  d.setHours(NIGHTLY_HOUR, 0, 0, 0);
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
  return d.getTime();
}

function due(): string[] {
  const since = lastNightly();
  return Object.values(db.profiles)
    .filter((p) => {
      const s = db.suggestions[p.id];
      if (s) return s.builtAt < since;
      return seedsOf(p.id).some((x) => x.weight > 0); // never built, and there's history to build from
    })
    .map((p) => p.id);
}

let checking = false;
export function startSuggestions(): void {
  const check = () => {
    if (checking || building) return;
    const ids = due();
    if (!ids.length || !getSettings().tmdbApiKey) return;
    checking = true;
    rebuild(ids);
    queue.finally(() => (checking = false));
  };
  setInterval(check, 10 * 60 * 1000).unref();
  setTimeout(check, 60 * 1000);
}
