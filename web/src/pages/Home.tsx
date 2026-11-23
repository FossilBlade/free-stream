import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, type Card, type Progress, type Row as RowData } from '../api';
import { Hero } from '../components/Hero';
import { ContinueCard, Row, TitleCard } from '../components/Row';
import { Button, Message, Spinner } from '../components/ui';

export function SetupNeeded({ error }: { error: ApiError }) {
  const navigate = useNavigate();
  useEffect(() => {
    setTimeout(() => setFocus('setup-open'), 50);
  }, []);
  if (error.status !== 412) {
    return (
      <div className="page page-center">
        <Message title="Something went wrong" action={<Button focusKey="setup-open" onSelect={() => window.location.reload()}>Reload</Button>}>
          {error.message}
        </Message>
      </div>
    );
  }
  return (
    <div className="page page-center">
      <Message
        title="Welcome to FreeStream"
        action={
          <Button focusKey="setup-open" variant="primary" icon={<SettingsIcon />} onSelect={() => navigate('/settings')}>
            Open Settings
          </Button>
        }
      >
        <p>To fill the catalog with movies and shows, add a free TMDB API key on the Settings page.</p>
        <p>{error.message}</p>
      </Message>
    </div>
  );
}

function pickHero(rows: RowData[]): Card | null {
  const candidates = (rows[0]?.items || []).filter((i) => i.backdropPath && i.overview).slice(0, 6);
  if (!candidates.length) return null;
  // Rotate daily so the banner changes but doesn't jump on every visit.
  return candidates[new Date().getDate() % candidates.length];
}

export function Home() {
  const [data, setData] = useState<{ continueWatching: Progress[]; myList: Card[]; suggestions: RowData[]; rows: RowData[] } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let alive = true;
    let loaded = false;
    const load = () =>
      api
        .home()
        .then((d) => {
          if (!alive) return;
          const fresh = {
            continueWatching: d.continueWatching,
            myList: d.myList.map((m) => ({ mediaType: m.mediaType, id: m.tmdbId, title: m.title, overview: '', posterPath: m.posterPath, backdropPath: m.backdropPath, year: '', releaseDate: '', language: '', rating: 0 })),
            suggestions: d.suggestions || [],
            rows: d.rows,
          };
          // Back in the app: take what may have changed on another device, keep the rows and banner as they are.
          setData((prev) => {
            if (!prev) return fresh;
            const same = JSON.stringify([prev.continueWatching, prev.myList]) === JSON.stringify([fresh.continueWatching, fresh.myList]);
            return same ? prev : { ...prev, continueWatching: fresh.continueWatching, myList: fresh.myList };
          });
          loaded = true;
        })
        .catch((e) => alive && !loaded && setError(e));
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const hero = useMemo(() => (data ? pickHero(data.rows) : null), [data]);

  useEffect(() => {
    if (!data) return;
    const first = data.continueWatching.length ? 'row-continue' : hero ? 'hero-play' : data.myList.length ? 'row-mylist' : `row-${data.rows[0]?.id}`;
    const t = setTimeout(() => setFocus(first), 50);
    return () => clearTimeout(t);
  }, [data, hero]);

  if (error) return <SetupNeeded error={error} />;
  if (!data) return <Spinner />;

  return (
    <div className="page page-home">
      {hero && <Hero item={hero} label={hero.mediaType === 'tv' ? 'Trending series' : 'Trending film'} />}
      <div className="rows">
        {data.continueWatching.length > 0 && (
          <Row title="Continue Watching" focusKey="row-continue">
            {data.continueWatching.map((p) => (
              <ContinueCard key={`${p.mediaType}-${p.tmdbId}`} p={p} />
            ))}
          </Row>
        )}
        {data.myList.length > 0 && (
          <Row title="My List" focusKey="row-mylist">
            {data.myList.map((c) => (
              <TitleCard key={`${c.mediaType}-${c.id}`} item={c} />
            ))}
          </Row>
        )}
        {[...data.suggestions, ...data.rows].map((r) => (
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
