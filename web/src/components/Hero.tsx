import { Info, Play, Star } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { img, type Card } from '../api';
import { FocusGroup } from './Focusable';
import { Button } from './ui';

export function Hero({ item, label }: { item: Card; label?: string }) {
  const navigate = useNavigate();
  const open = () => navigate(`/title/${item.mediaType}/${item.id}`);
  return (
    <section className="hero">
      <div className="hero-bg" style={{ backgroundImage: `url(${img(item.backdropPath, 'w1280')})` }} />
      <div className="hero-shade" />
      <div className="hero-content">
        {label && <div className="eyebrow">{label}</div>}
        <h1 className="hero-title">{item.title}</h1>
        <div className="meta-line">
          {item.rating > 0 && (
            <span className="rating">
              <Star /> {item.rating.toFixed(1)}
            </span>
          )}
          <span>{item.year}</span>
          <span>{item.mediaType === 'tv' ? 'Series' : 'Film'}</span>
        </div>
        <p className="hero-overview">{item.overview}</p>
        <FocusGroup focusKey="hero" className="actions">
          <Button focusKey="hero-play" variant="primary" icon={<Play />} scroll="top" onSelect={() => navigate(`/title/${item.mediaType}/${item.id}?play=1`)}>
            Play
          </Button>
          <Button icon={<Info />} scroll="top" onSelect={open}>
            More Info
          </Button>
        </FocusGroup>
      </div>
    </section>
  );
}
