import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, img, type Card } from '../api';
import { Message, Spinner } from '../components/ui';
import { PosterGrid } from './Browse';

/** An actor's or director's films and shows. */
export function PersonPage() {
  const id = Number(useParams().id);
  const [data, setData] = useState<{ name: string; profilePath: string | null; results: Card[] } | null>(null);
  useEffect(() => {
    api
      .person(id)
      .then(setData)
      .catch(() => setData({ name: '', profilePath: null, results: [] }));
  }, [id]);
  useEffect(() => {
    if (data?.results.length) setTimeout(() => setFocus('person-0'), 50);
  }, [data]);
  if (!data) return <Spinner />;
  return (
    <div className="page page-padded">
      <div className="person-head">
        {data.profilePath && <img src={img(data.profilePath, 'w185')} alt="" />}
        <h1 className="page-title">{data.name}</h1>
      </div>
      {data.results.length ? <PosterGrid items={data.results} focusKeyPrefix="person" /> : <Message title="Nothing to show" />}
    </div>
  );
}
