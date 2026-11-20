import { hideBroken } from "./ui";
import {
  useFocusable,
  FocusContext,
} from "@noriginmedia/norigin-spatial-navigation";
import { ChevronLeft, ChevronRight, Info, Play, Star } from "lucide-react";
import { useCallback, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  img,
  isComingSoon,
  shortDate,
  type Card as CardData,
  type Progress,
} from "../api";
import { isTV } from "../tv";
import { Focusable, RowScrollContext } from "./Focusable";
import { ProgressBar } from "./ui";

/** A horizontal, remote-navigable row of cards, Netflix-style. */
export function Row({
  title,
  focusKey,
  children,
}: {
  title: string;
  focusKey: string;
  children: ReactNode;
}) {
  const track = useRef<HTMLDivElement>(null);
  const {
    ref,
    focusKey: key,
    hasFocusedChild,
  } = useFocusable<object, HTMLElement>({
    focusKey,
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  // Keep the focused card near the left edge, like a TV streaming app.
  const scrollTo = useCallback((el: HTMLElement) => {
    const t = track.current;
    if (!t) return;
    const pad = parseFloat(getComputedStyle(t).paddingLeft) || 0;
    t.scrollTo({ left: Math.max(0, el.offsetLeft - pad), behavior: "smooth" });
  }, []);

  const page = (dir: 1 | -1) => {
    const t = track.current;
    if (t) t.scrollBy({ left: dir * t.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <FocusContext.Provider value={key}>
      <section
        ref={ref}
        className={`row${hasFocusedChild ? " has-focus" : ""}`}
      >
        <h2 className="row-title">{title}</h2>
        <div className="row-viewport">
          {!isTV && (
            <button
              className="row-arrow row-arrow-left"
              aria-label="Scroll left"
              onClick={() => page(-1)}
            >
              <ChevronLeft />
            </button>
          )}
          <RowScrollContext.Provider value={scrollTo}>
            <div className="row-track" ref={track}>
              {children}
            </div>
          </RowScrollContext.Provider>
          {!isTV && (
            <button
              className="row-arrow row-arrow-right"
              aria-label="Scroll right"
              onClick={() => page(1)}
            >
              <ChevronRight />
            </button>
          )}
        </div>
      </section>
    </FocusContext.Provider>
  );
}

export function TitleCard({
  item,
  focusKey,
}: {
  item: CardData;
  focusKey?: string;
}) {
  const navigate = useNavigate();
  const image = item.backdropPath
    ? img(item.backdropPath, "w780")
    : img(item.posterPath, "w500");
  return (
    <Focusable
      focusKey={focusKey}
      scroll="start"
      className="card"
      onSelect={() => navigate(`/title/${item.mediaType}/${item.id}`)}
    >
      <div className="card-media">
        {image ? (
          <img src={image} alt="" loading="lazy" onError={hideBroken} />
        ) : (
          <div className="card-fallback" />
        )}
        <div className="card-shade" />
        {isComingSoon(item) && (
          <div className="card-badge">Coming {shortDate(item.releaseDate)}</div>
        )}
        <div className="card-title">{item.title}</div>
      </div>
      <div className="card-meta">
        {item.rating > 0 && (
          <span className="card-rating">
            <Star /> {item.rating.toFixed(1)}
          </span>
        )}
        <span>{item.year}</span>
        <span className="card-kind">
          {item.mediaType === "tv" ? "Series" : "Film"}
        </span>
      </div>
    </Focusable>
  );
}

export function ContinueCard({ p }: { p: Progress }) {
  const navigate = useNavigate();
  const ep =
    p.mediaType === "tv" && p.season != null
      ? `S${p.season}:E${p.episode}`
      : "";
  const left = Math.max(0, Math.round((p.duration - p.position) / 60));
  const go = () => {
    const q =
      p.mediaType === "tv" ? `?season=${p.season}&episode=${p.episode}` : "";
    navigate(`/watch/${p.mediaType}/${p.tmdbId}${q}`, {
      state: {
        title: p.title,
        episodeTitle: p.episodeTitle,
        backdropPath: p.backdropPath,
        posterPath: p.posterPath,
      },
    });
  };
  // The card resumes playback; "Details" under it opens the title page (▼ from the card on the remote).
  return (
    <div className="continue-item">
      <Focusable scroll="start" className="card card-continue" onSelect={go}>
        <div className="card-media">
          {p.backdropPath ? (
            <img
              src={img(p.backdropPath, "w780")}
              alt=""
              loading="lazy"
              onError={hideBroken}
            />
          ) : (
            <div className="card-fallback" />
          )}
          <div className="card-shade" />
          <div className="card-play">
            <Play />
          </div>
          <div className="card-title">{p.title}</div>
          <ProgressBar value={p.position / (p.duration || 1)} />
        </div>
        <div className="card-meta">
          {ep && <span className="accent">{ep}</span>}
          <span>
            {ep && p.episodeTitle ? p.episodeTitle : `${left} min left`}
          </span>
        </div>
      </Focusable>
      <Focusable
        scroll="start"
        className="continue-info"
        title={`${p.title}: details`}
        onSelect={() => navigate(`/title/${p.mediaType}/${p.tmdbId}`)}
      >
        <Info /> Details
      </Focusable>
    </div>
  );
}
