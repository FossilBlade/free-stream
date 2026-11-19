import type { NavigateFunction } from 'react-router-dom';
import { api, ApiError, type MediaType } from '../api';
import { toast } from './Toast';

/** Plays a specific downloaded/cached torrent for a title (and episode), then opens the player. */
export async function playDownload(
  navigate: NavigateFunction,
  d: { mediaType: MediaType | null; tmdbId: number | null; season?: number | null; episode?: number | null; infoHash: string; releaseName?: string },
): Promise<void> {
  if (!d.mediaType || d.tmdbId == null) {
    toast('This download isn’t linked to a movie or show yet, so it can’t be played from here.', 'error');
    return;
  }
  const season = d.season ?? undefined;
  const episode = d.episode ?? undefined;
  try {
    const info = await api.play({
      mediaType: d.mediaType,
      tmdbId: d.tmdbId,
      season,
      episode,
      source: { infoHash: d.infoHash, releaseTitle: d.releaseName || 'Downloaded file' },
    });
    const q = d.mediaType === 'tv' && season != null ? `?season=${season}&episode=${episode}` : '';
    navigate(`/watch/${d.mediaType}/${d.tmdbId}${q}`, { state: { play: info } });
  } catch (e) {
    toast((e as ApiError).message, 'error');
  }
}
