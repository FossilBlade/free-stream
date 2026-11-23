import { Check, Plus, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, batchMessage, type DownloadRow, type SavedSource } from '../api';
import { FocusGroup, Focusable } from './Focusable';
import { Sources } from './Sources';
import { toast } from './Toast';
import { Button, Spinner } from './ui';

export interface SeasonBatch {
  season: number;
  /** Aired episodes still to download. */
  episodes: number[];
  /** "Whole season", "From episode 4", "Picked episodes". */
  label: string;
  /** The season is still airing, so new episodes can be followed. */
  airing: boolean;
}

/**
 * Downloads several episodes at once. Offers the season's full-season sources first (one torrent
 * for all of them); episodes a pack lacks, or all of them without one, are found one by one.
 */
export function SeasonDownload({
  tmdbId,
  title,
  year,
  batch,
  downloads,
  busy,
  onPlay,
  onStarted,
  onCancel,
}: {
  tmdbId: number;
  title: string;
  year?: string;
  batch: SeasonBatch;
  downloads: DownloadRow[];
  busy?: boolean;
  /** Preview's "Watch this" on a pack: plays the batch's first episode from it. */
  onPlay: (episode: number, source: SavedSource) => void;
  onStarted: () => void;
  onCancel: () => void;
}) {
  const [follow, setFollow] = useState(batch.airing);
  const [starting, setStarting] = useState(false);

  const start = async (source?: SavedSource) => {
    if (starting) return;
    setStarting(true);
    try {
      const r = await api.downloadEpisodes({ tmdbId, season: batch.season, episodes: batch.episodes, source, follow: batch.airing && follow });
      toast(batchMessage(r));
      onStarted();
    } catch (e) {
      toast((e as ApiError).message, 'error');
    } finally {
      setStarting(false);
    }
  };

  const count = `${batch.episodes.length} episode${batch.episodes.length === 1 ? '' : 's'}`;
  return (
    <Sources
      mediaType="tv"
      tmdbId={tmdbId}
      title={title}
      year={year}
      season={batch.season}
      mode="pack"
      previewEpisode={batch.episodes[0]}
      subtitle={`Season ${batch.season} · ${batch.label} · ${count}`}
      busy={busy || starting}
      downloads={downloads}
      onPlay={(src) => onPlay(batch.episodes[0] ?? 1, src)}
      onPack={start}
      extra={
        <>
          <p className="muted small">One torrent with the whole season is the fastest and most reliable. Episodes it doesn’t have are found one by one.</p>
          {batch.airing && (
            <FocusGroup focusKey="batch-follow" className="chips batch-follow">
              <Focusable className={`chip${follow ? ' is-active' : ''}`} onSelect={() => setFollow((f) => !f)}>
                {follow ? <Check /> : <Plus />} Also download new episodes as they air
              </Focusable>
            </FocusGroup>
          )}
        </>
      }
      footer={
        starting ? (
          <Spinner label="Starting downloads…" />
        ) : (
          <FocusGroup focusKey="batch-actions" className="actions batch-actions">
            <Button icon={<Wand2 />} onSelect={() => start()}>
              Find each episode automatically
            </Button>
            <Button variant="ghost" onSelect={onCancel}>
              Cancel
            </Button>
          </FocusGroup>
        )
      }
    />
  );
}
