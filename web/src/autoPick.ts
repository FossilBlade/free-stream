import { api, type MediaType, type Release, type SavedSource } from './api';
import { screenHeight } from './screen';
import { canPlayDolbyAudio } from './tv';

/** How many sources Play tries by itself before handing over the full list. */
const MAX_TRIES = 4;

/**
 * Sources worth trying without asking, best first: the list's recommended pick, then the rest in the
 * server's order, ones that should play on this device before risky ones. Never theater copies,
 * likely fakes, or sources nobody is sharing.
 */
export async function autoCandidates(type: MediaType, id: number, title: string, year?: string, season?: number, episode?: number): Promise<Release[]> {
  const { releases } = await api.sources({ type, id, title, year, season, episode, screen: screenHeight(), dolby: canPlayDolbyAudio ? 1 : 0 });
  const ok = releases.filter(
    (r) =>
      r.tier === 'full' &&
      !r.info.theater &&
      r.sizeFlag !== 'small' &&
      r.seeders > 0 &&
      (r.magnet || r.downloadUrl) &&
      r.verdict?.outcome !== 'suspect' &&
      r.verdict?.outcome !== 'theater' &&
      // A single episode of the show that isn't this one.
      !(episode != null && !r.info.pack && r.info.episode != null && r.info.episode !== episode),
  );
  const rank = (r: Release) => (r.best ? 0 : r.playability === 'risky' ? 2 : 1);
  return ok
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r)
    .slice(0, MAX_TRIES);
}

export const sourceOf = (r: Release): SavedSource => ({ magnet: r.magnet, downloadUrl: r.downloadUrl, infoHash: r.infoHash, releaseTitle: r.title });

/** "1080p WEB · season pack · 45 seeders" */
export function shortLabel(r: Release): string {
  return [r.info.resolution, r.info.source, r.info.pack ? 'season pack' : null, `${r.seeders} seeder${r.seeders === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
}
