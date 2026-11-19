import { hideBroken } from '../components/ui';
import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect, useState } from 'react';
import { api, ApiError, type Card, type MediaType, type Row as RowData } from '../api';
import { FocusGroup, Focusable } from '../components/Focusable';
import { Hero } from '../components/Hero';
import { Row, TitleCard } from '../components/Row';
import { Message, Spinner } from '../components/ui';
import { useNavigate } from 'react-router-dom';
import { img, isComingSoon, languageName, shortDate } from '../api';
import { useProfile } from '../profile';
import { SetupNeeded } from './Home';

export function Browse({ type }: { type: MediaType }) {
  const [rows, setRows] = useState<RowData[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const { profile, isKid } = useProfile();
  const [lang, setLang] = useState('');

  useEffect(() => {
    setRows(null);
    api
      .browse(type, lang || undefined)
      .then((r) => setRows(r.rows))
      .catch(setError);
  }, [type, lang]);

  useEffect(() => {
    if (!rows) return;
    const hasHero = rows[0]?.items.some((i) => i.backdropPath && i.overview);
    const t = setTimeout(() => setFocus(hasHero ? 'hero-play' : `row-${rows[0]?.id}`), 50);
    return () => clearTimeout(t);
  }, [rows]);

  if (error) return <SetupNeeded error={error} />;
  if (!rows) return <Spinner />;
  const hero = rows[0]?.items.find((i) => i.backdropPath && i.overview);

  // Language tabs from the profile's languages (kids' pages are already tailored).
  const tabs = !isKid && profile && profile.languages.length > 1 ? ['', ...profile.languages] : [];
  return (
    <div className="page page-home">
      {hero && <Hero item={hero} label={type === 'tv' ? 'Top series this week' : 'Top film this week'} />}
      {tabs.length > 0 && (
        <FocusGroup focusKey="lang-tabs" className={`chips lang-tabs${hero ? '' : ' no-hero'}`}>
          {tabs.map((l) => (
            <Focusable key={l || 'all'} className={`chip${lang === l ? ' is-active' : ''}`} onSelect={() => setLang(l)}>
              {l ? languageName(l) : 'All'}
            </Focusable>
          ))}
        </FocusGroup>
      )}
      <div className="rows">
        {rows.map((r) => (
          <Row key={r.id} title={r.title} focusKey={`row-${r.id}`}>
            {r.items.map((c) => (
              <TitleCard key={`${c.mediaType}-${c.id}`} item={c} />
            ))}
          </Row>
        ))}
      </div>
    </div>
  );
}

/** Poster grid used by My List and Search. */
export function PosterGrid({ items, focusKeyPrefix = 'grid' }: { items: Card[]; focusKeyPrefix?: string }) {
  const navigate = useNavigate();
  return (
    <div className="poster-grid">
      {items.map((c, i) => (
        <Focusable key={`${c.mediaType}-${c.id}`} focusKey={`${focusKeyPrefix}-${i}`} className="poster" onSelect={() => navigate(`/title/${c.mediaType}/${c.id}`)}>
          <div className="poster-media">
            {c.posterPath ? <img src={img(c.posterPath, 'w342')} alt="" loading="lazy" onError={hideBroken} /> : <div className="card-fallback" />}
            {isComingSoon(c) && <div className="card-badge">Coming {shortDate(c.releaseDate)}</div>}
            {c.language && c.language !== 'en' && <div className="lang-badge">{c.language.toUpperCase()}</div>}
          </div>
          <div className="poster-title">{c.title}</div>
        </Focusable>
      ))}
    </div>
  );
}

export function MyList() {
  const [items, setItems] = useState<Card[] | null>(null);
  useEffect(() => {
    api
      .home()
      .then((d) => setItems(d.myList.map((m) => ({ mediaType: m.mediaType, id: m.tmdbId, title: m.title, overview: '', posterPath: m.posterPath, backdropPath: m.backdropPath, year: '', releaseDate: '', language: '', rating: 0 }))))
      .catch(() => setItems([]));
  }, []);
  useEffect(() => {
    if (items?.length) setTimeout(() => setFocus('list-0'), 50);
  }, [items]);
  if (!items) return <Spinner />;
  return (
    <div className="page page-padded">
      <h1 className="page-title">My List</h1>
      {items.length ? <PosterGrid items={items} focusKeyPrefix="list" /> : <Message title="Your list is empty">Add movies and shows with the “My List” button on their page.</Message>}
    </div>
  );
}
