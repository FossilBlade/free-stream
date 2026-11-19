import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { Download, Play, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, downloadMessage, episodeLabel, img, type Watch } from '../api';
import { FocusGroup, Focusable } from '../components/Focusable';
import { playDownload } from '../components/playDownload';
import { toast } from '../components/Toast';
import { Badge, Message, Spinner } from '../components/ui';

const STATUS: Record<Watch['status'], { text: string; tone: 'good' | 'accent' | 'plain' }> = {
  found: { text: 'Found', tone: 'good' },
  waiting: { text: 'Watching', tone: 'accent' },
  'gave-up': { text: 'Stopped', tone: 'plain' },
};

/** Titles FreeStream is looking out for: "Notify me" releases and better versions of theater copies. */
export function Watching() {
  const navigate = useNavigate();
  const [watches, setWatches] = useState<Watch[] | null>(null);

  const load = useCallback(() => {
    api
      .watching()
      .then((r) => {
        setWatches(r.watches);
        // Seeing the list counts as seeing the news.
        for (const w of r.watches) if (w.status === 'found' && !w.seen) api.watchSeen(w.key).catch(() => {});
      })
      .catch(() => setWatches([]));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (watches?.length) setTimeout(() => setFocus('watch-0'), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watches === null]);

  const download = async (w: Watch) => {
    try {
      const r = await api.download({ mediaType: w.mediaType, tmdbId: w.tmdbId, season: w.season, episode: w.episode, source: w.found!.source });
      toast(downloadMessage(r));
    } catch (e) {
      toast((e as ApiError).message, 'error');
    }
  };

  if (!watches) return <Spinner />;

  return (
    <div className="page page-padded">
      <h1 className="page-title">Watching</h1>
      <p className="muted">
        FreeStream checks these in the background and verifies what it finds (runtime, files, AI). “Notify me” titles are picked up once they’re out digitally; theater copies you play
        are upgraded when a proper release appears.
      </p>
      {!watches.length ? (
        <Message title="Nothing being watched">Press “Notify me” on an upcoming or in-theaters title.</Message>
      ) : (
        <FocusGroup focusKey="watching" className="watch-list download-list">
          {watches.map((w, i) => {
            const st = STATUS[w.status];
            const ep = episodeLabel(w.season, w.episode);
            return (
              <div className={`watch${w.status === 'found' ? ' is-found' : ''}`} key={w.key}>
                <div className="watch-poster">{w.posterPath && <img src={img(w.posterPath, 'w185')} alt="" />}</div>
                <Focusable focusKey={`watch-${i}`} className="watch-body download-body" onSelect={() => navigate(`/title/${w.mediaType}/${w.tmdbId}`)}>
                  <div className="download-name">
                    {w.title} {w.year && <span className="muted">({w.year})</span>}
                    {ep && <span className="accent"> · {ep}</span>}
                  </div>
                  <div className="download-stats muted">
                    <Badge tone={st.tone}>{st.text}</Badge>
                    <span>{w.reason === 'upgrade' ? 'Better version of a theater copy' : 'Notify when out'}</span>
                  </div>
                  <div className="muted small">{w.note}</div>
                </Focusable>
                <div className="watch-actions">
                  {w.status === 'found' && w.found && (
                    <>
                      <Focusable
                        className="btn btn-primary btn-icon"
                        title="Play it"
                        onSelect={() =>
                          playDownload(navigate, { mediaType: w.mediaType, tmdbId: w.tmdbId, season: w.season, episode: w.episode, infoHash: w.found!.source.infoHash!, releaseName: w.found!.source.releaseTitle })
                        }
                      >
                        <Play />
                      </Focusable>
                      {!w.downloaded && (
                        <Focusable className="btn btn-secondary btn-icon" title="Download it" onSelect={() => download(w)}>
                          <Download />
                        </Focusable>
                      )}
                    </>
                  )}
                  <Focusable className="btn btn-danger btn-icon" title="Stop watching" onSelect={() => api.unwatch(w.key).then(load)}>
                    <Trash2 />
                  </Focusable>
                </div>
              </div>
            );
          })}
        </FocusGroup>
      )}
    </div>
  );
}
