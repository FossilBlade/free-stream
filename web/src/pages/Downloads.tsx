import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { HardDriveDownload, Pin, PinOff, Play, Trash2, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, episodeLabel, formatBytes, saveFileUrl, type DownloadRow } from '../api';
import { FocusGroup, Focusable } from '../components/Focusable';
import { playDownload } from '../components/playDownload';
import { toast } from '../components/Toast';
import { Badge, Message, ProgressBar, Spinner } from '../components/ui';
import { isTV } from '../tv';

function statusLabel(d: DownloadRow): { text: string; tone: 'good' | 'ok' | 'accent' | 'plain' } {
  if (d.complete) return { text: 'Downloaded', tone: 'good' };
  if (d.watching) return { text: 'Streaming', tone: 'accent' };
  if (d.downloading) return { text: d.active ? 'Downloading' : 'Waiting to resume', tone: 'accent' };
  return { text: 'Partly cached', tone: 'plain' };
}

/** Triggers a browser download of a finished file without leaving the page. */
function saveToDevice(d: DownloadRow) {
  if (d.fileIdx == null) return;
  const a = document.createElement('a');
  a.href = saveFileUrl(d.infoHash, d.fileIdx);
  a.download = d.fileName || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`Saving ${d.fileName || d.releaseName} to this device…`);
}

const rowKey = (d: DownloadRow) => `${d.infoHash}:${d.fileIdx ?? 'all'}`;

export function Downloads() {
  const navigate = useNavigate();
  const [items, setItems] = useState<DownloadRow[] | null>(null);
  const [limit, setLimit] = useState(0);

  const load = useCallback(() => {
    api
      .downloads()
      .then((r) => {
        setItems(r.downloads);
        setLimit(r.cacheLimitGb);
      })
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (items?.length) setTimeout(() => setFocus('dl-0'), 50);
    // only on first load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items === null]);

  const act = (p: Promise<unknown>) => p.then(load).catch((e: ApiError) => toast(e.message, 'error'));

  if (!items) return <Spinner />;
  // Disk use is per file; count each torrent's "kept" state once per file row.
  const used = items.reduce((a, d) => a + (d.diskBytes || 0), 0);
  const kept = items.filter((d) => d.kept).reduce((a, d) => a + (d.diskBytes || 0), 0);

  return (
    <div className="page page-padded">
      <h1 className="page-title">Downloads</h1>
      <p className="muted">
        {formatBytes(used)} used ({formatBytes(kept)} kept) · cache limit {limit} GB. Kept items are never removed automatically; others are cleared
        oldest-first when the cache is full. Files are in ~/Movies/FreeStream on the Mac.
      </p>
      {!items.length ? (
        <Message title="Nothing here yet">Press Download on a movie, episode or source, or just watch something — it’s cached here.</Message>
      ) : (
        <FocusGroup focusKey="downloads" className="download-list">
          {items.map((d, i) => {
            const st = statusLabel(d);
            const linked = d.mediaType != null && d.tmdbId != null;
            const ep = episodeLabel(d.season, d.episode);
            return (
              <div className="download" key={rowKey(d)}>
                <Focusable
                  className="download-body"
                  disabled={!linked}
                  title={linked ? 'Open the movie / show page' : 'Not linked to a title yet'}
                  onSelect={() => linked && navigate(`/title/${d.mediaType}/${d.tmdbId}`)}
                >
                  <div className="download-name">
                    {d.title || d.releaseName}
                    {ep && <span className="accent"> · {ep}</span>}
                    {d.kept && <Pin className="kept-icon" aria-label="Kept" />}
                  </div>
                  <div className="download-file muted small">{d.fileName || d.releaseName}</div>
                  <div className="download-stats muted">
                    <Badge tone={st.tone}>{st.text}</Badge>
                    <span>
                      {formatBytes(d.diskBytes || 0)}
                      {d.size > 0 && !d.complete ? ` of ${formatBytes(d.size)}` : ''}
                    </span>
                    {!d.complete && d.size > 0 && <span>{Math.floor(d.progress * 100)}%</span>}
                    {d.active && !d.complete && d.downloading && (
                      <>
                        <span>
                          <Users className="inline-icon" /> {d.peers}
                        </span>
                        <span>↓ {formatBytes(d.downloadSpeed)}/s</span>
                      </>
                    )}
                    {d.active && <span title="Sent to other peers since this torrent started">↑ {formatBytes(d.uploaded)} uploaded</span>}
                  </div>
                  {!d.complete && d.size > 0 && <ProgressBar value={d.progress} />}
                </Focusable>
                <div className="download-actions">
                  <Focusable
                    focusKey={`dl-${i}`}
                    className="btn btn-primary btn-icon"
                    disabled={!linked}
                    title={linked ? 'Play' : 'Not linked to a title yet'}
                    onSelect={() => playDownload(navigate, d)}
                  >
                    <Play />
                  </Focusable>
                  <Focusable
                    className={`btn btn-secondary btn-icon${d.kept ? ' is-on' : ''}`}
                    title={d.kept ? 'Kept — click to let cache cleanup remove it' : 'Keep — never remove automatically'}
                    onSelect={() => act(api.keep(d.infoHash, !d.kept))}
                  >
                    {d.kept ? <PinOff /> : <Pin />}
                  </Focusable>
                  {!isTV && (
                    <Focusable
                      className="btn btn-secondary btn-icon"
                      disabled={!d.complete || d.fileIdx == null}
                      title={d.complete ? 'Save to this device' : 'Available when the download finishes'}
                      onSelect={() => saveToDevice(d)}
                    >
                      <HardDriveDownload />
                    </Focusable>
                  )}
                  <Focusable className="btn btn-danger btn-icon" title="Delete from the Mac" onSelect={() => act(api.deleteDownload(d.infoHash, d.fileIdx))}>
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
