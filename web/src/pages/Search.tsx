import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { ChevronDown, History } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, img, LANGUAGE_NAMES, type Card, type DiscoverFilters, type Person } from '../api';
import { FocusGroup, Focusable } from '../components/Focusable';
import { TextField } from '../components/Sources';
import { Button, Message, Spinner } from '../components/ui';
import { useProfile } from '../profile';
import { PosterGrid } from './Browse';

type Decade = NonNullable<DiscoverFilters['decade']>;
const DECADES: [Decade | '', string][] = [
  ['', 'Any year'],
  ['this-year', 'This year'],
  ['2020s', '2020s'],
  ['2010s', '2010s'],
  ['2000s', '2000s'],
  ['older', 'Older'],
];
const SORTS: [DiscoverFilters['sort'], string][] = [
  ['popular', 'Popular'],
  ['newest', 'Newest'],
  ['top', 'Top rated'],
];

const recentKey = (profileId: string) => `fs-recent-${profileId}`;
function loadRecent(profileId: string): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(recentKey(profileId)) || '[]');
  } catch {
    return [];
  }
}
function saveRecent(profileId: string, q: string) {
  try {
    const list = [q, ...loadRecent(profileId).filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
    window.localStorage.setItem(recentKey(profileId), JSON.stringify(list));
  } catch {
    /* private mode */
  }
}

/** One row of filter chips. */
function ChipRow<T extends string>({ label, value, options, onChange, focusKey }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void; focusKey: string }) {
  return (
    <div className="filter-row">
      <span className="filter-label muted small">{label}</span>
      <FocusGroup focusKey={focusKey} className="chips">
        {options.map(([v, text]) => (
          <Focusable key={v || 'any'} className={`chip${value === v ? ' is-active' : ''}`} onSelect={() => onChange(v)}>
            {text}
          </Focusable>
        ))}
      </FocusGroup>
    </div>
  );
}

/**
 * Search + filters. With text: titles and people, ranked for the profile's languages. Without text:
 * browse by type / language / genre / decade / sort.
 */
export function Search() {
  const { profile } = useProfile();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') || '');
  const [type, setType] = useState<DiscoverFilters['type']>((params.get('type') as DiscoverFilters['type']) || 'all');
  const [language, setLanguage] = useState(params.get('language') || '');
  const [genre, setGenre] = useState(params.get('genre') || '');
  const [decade, setDecade] = useState<Decade | ''>((params.get('decade') as Decade) || '');
  const [sort, setSort] = useState<DiscoverFilters['sort']>((params.get('sort') as DiscoverFilters['sort']) || 'popular');
  const [moreLangs, setMoreLangs] = useState(false);
  const [moreGenres, setMoreGenres] = useState(false);
  const [genres, setGenres] = useState<string[]>([]);

  const [results, setResults] = useState<Card[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => (profile ? loadRecent(profile.id) : []));
  const requestId = useRef(0);

  useEffect(() => {
    api
      .genres()
      .then((r) => setGenres(r.genres))
      .catch(() => {});
    setTimeout(() => setFocus('search-input'), 50);
  }, []);

  const text = query.trim();
  const browsing = text.length < 2;
  const anyFilter = type !== 'all' || !!language || !!genre || !!decade;
  const filters: DiscoverFilters = useMemo(
    () => ({ type, language: language || undefined, genre: genre || undefined, decade: decade || undefined, sort }),
    [type, language, genre, decade, sort],
  );

  // Fetch page 1 whenever the text or filters change (debounced for typing); keep everything in the URL.
  useEffect(() => {
    const id = ++requestId.current;
    if (browsing && !anyFilter) {
      setResults(null);
      setPeople([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(
      () => {
        const p: Record<string, string> = {};
        if (text) p.q = text;
        if (type !== 'all') p.type = type;
        if (language) p.language = language;
        if (genre) p.genre = genre;
        if (decade) p.decade = decade;
        if (sort !== 'popular') p.sort = sort;
        setParams(p, { replace: true });
        const call = browsing ? api.discover({ ...filters, page: 1 }).then((r) => ({ ...r, people: [] as Person[] })) : api.search(text, filters, 1);
        call
          .then((r) => {
            if (id !== requestId.current) return;
            setResults(r.results);
            setPeople(r.people);
            setHasMore(r.hasMore);
            setPage(1);
            setError(null);
            if (!browsing && profile) {
              saveRecent(profile.id, text);
              setRecent(loadRecent(profile.id));
            }
          })
          .catch((e: ApiError) => id === requestId.current && setError(e.message))
          .finally(() => id === requestId.current && setLoading(false));
      },
      browsing ? 0 : 450,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, filters]);

  const loadMore = async () => {
    const next = page + 1;
    setLoading(true);
    try {
      const r = browsing ? await api.discover({ ...filters, page: next }) : await api.search(text, filters, next);
      const seen = new Set((results || []).map((c) => `${c.mediaType}:${c.id}`));
      setResults([...(results || []), ...r.results.filter((c) => !seen.has(`${c.mediaType}:${c.id}`))]);
      setHasMore(r.hasMore);
      setPage(next);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  };

  // Language chips: the profile's languages first; everything else behind "More".
  const preferred = profile?.languages || ['en'];
  const langOptions: [string, string][] = [['', 'Any language'], ...preferred.map((l): [string, string] => [l, LANGUAGE_NAMES[l] || l])];
  if (moreLangs) for (const [code, name] of Object.entries(LANGUAGE_NAMES)) if (!preferred.includes(code)) langOptions.push([code, name]);
  const genreOptions: [string, string][] = [['', 'All genres'], ...(moreGenres ? genres : genres.slice(0, 8)).map((g): [string, string] => [g, g])];

  return (
    <div className="page page-padded">
      <h1 className="page-title">Search</h1>
      <div className="search-box">
        <TextField focusKey="search-input" value={query} onChange={setQuery} placeholder="Titles, actors, directors" autoFocus onSubmit={() => setTimeout(() => setFocus('search-0'), 50)} />
      </div>

      <div className="filters">
        <ChipRow
          label="Type"
          focusKey="f-type"
          value={type}
          onChange={setType}
          options={[
            ['all', 'All'],
            ['movie', 'Movies'],
            ['tv', 'Shows'],
          ]}
        />
        <div className="filter-row">
          <span className="filter-label muted small">Language</span>
          <FocusGroup focusKey="f-lang" className="chips">
            {langOptions.map(([v, label]) => (
              <Focusable key={v || 'any'} className={`chip${language === v ? ' is-active' : ''}`} onSelect={() => setLanguage(v)}>
                {label}
              </Focusable>
            ))}
            {!moreLangs && (
              <Focusable className="chip" onSelect={() => setMoreLangs(true)}>
                More <ChevronDown />
              </Focusable>
            )}
          </FocusGroup>
        </div>
        <div className="filter-row">
          <span className="filter-label muted small">Genre</span>
          <FocusGroup focusKey="f-genre" className="chips">
            {genreOptions.map(([v, label]) => (
              <Focusable key={v || 'all'} className={`chip${genre === v ? ' is-active' : ''}`} onSelect={() => setGenre(v)}>
                {label}
              </Focusable>
            ))}
            {!moreGenres && genres.length > 8 && (
              <Focusable className="chip" onSelect={() => setMoreGenres(true)}>
                More <ChevronDown />
              </Focusable>
            )}
          </FocusGroup>
        </div>
        <ChipRow label="Year" focusKey="f-year" value={decade} onChange={setDecade} options={DECADES} />
        {browsing && <ChipRow label="Sort" focusKey="f-sort" value={sort} onChange={setSort} options={SORTS} />}
      </div>

      {browsing && !anyFilter && recent.length > 0 && (
        <div className="filter-row recent">
          <span className="filter-label muted small">
            <History className="inline-icon" /> Recent
          </span>
          <FocusGroup focusKey="f-recent" className="chips">
            {recent.map((r) => (
              <Focusable key={r} className="chip" onSelect={() => setQuery(r)}>
                {r}
              </Focusable>
            ))}
          </FocusGroup>
        </div>
      )}

      {people.length > 0 && (
        <FocusGroup focusKey="people" className="people-row">
          {people.map((p) => (
            <Focusable key={p.id} className="person-chip" onSelect={() => navigate(`/person/${p.id}`)}>
              {p.profilePath ? <img src={img(p.profilePath, 'w185')} alt="" /> : <span className="person-fallback">{p.name[0]}</span>}
              <span>
                <strong>{p.name}</strong>
                <small className="muted">{p.knownFor}</small>
              </span>
            </Focusable>
          ))}
        </FocusGroup>
      )}

      {error ? (
        <Message title="Search failed">{error}</Message>
      ) : loading && !results ? (
        <Spinner />
      ) : results && !results.length ? (
        <Message title={browsing ? 'Nothing matches these filters' : `Nothing found for “${text}”`}>{anyFilter ? 'Try removing a filter.' : undefined}</Message>
      ) : results ? (
        <>
          <PosterGrid items={results} focusKeyPrefix="search" />
          {hasMore && (
            <FocusGroup focusKey="search-more" className="actions more-actions">
              <Button disabled={loading} onSelect={loadMore}>
                {loading ? 'Loading…' : 'Show more'}
              </Button>
            </FocusGroup>
          )}
        </>
      ) : (
        <p className="muted">Type a title or a name, or pick filters to browse.</p>
      )}
    </div>
  );
}
