/**
 * Final ordering of a source list for one device, and the "Best pick" with a short reason.
 * Builds on indexers.score() (seeders, playability here, resolution for this screen, size, language)
 * and adds what earlier deep checks found.
 */
import { devicePlayability, resolutionFit, score, type Release, type SearchRequest } from './indexers.ts';
import type { Verdict } from './store.ts';

export interface RankedRelease extends Release {
  verdict: { outcome: Verdict['outcome']; label: string; summary: string | null; checkedBy: string | null } | null;
  /** Set on the single recommended source. */
  best?: boolean;
  /** Why it's the best pick, e.g. "Checked: full movie · 1080p, matches your screen · Plays here · 240 seeders". */
  pickReason?: string;
}

const VERDICT_BONUS: Record<Verdict['outcome'], number> = { verified: 20, theater: 0, suspect: -20, rejected: -200 };

const resName = (r: string | null) => (r === '2160p' ? '4K' : r || '');

function reasonFor(r: RankedRelease, req: SearchRequest): string {
  const parts: string[] = [];
  if (r.verdict?.outcome === 'verified') parts.push(`Checked: ${r.verdict.label.split(' · ')[0].toLowerCase()}`);
  const res = r.info.resolution;
  if (res) {
    const fit = resolutionFit(res, req.screen);
    if (req.screen && fit === 5) parts.push(`${resName(res)}, matches your screen`);
    else if (req.screen && fit === 2) parts.push(`${resName(res)} (more than your screen shows)`);
    else parts.push(resName(res));
  }
  const play = devicePlayability(r, req.dolby);
  if (play === 'good') parts.push('Plays on this device');
  else if (play === 'ok') parts.push('Should play here');
  const lang = req.preferLanguages?.find((l) => r.info.languages.includes(l));
  if (lang) parts.push(`${lang} audio`);
  parts.push(r.seeders >= 50 ? `${r.seeders} seeders, fast` : `${r.seeders} seeders`);
  return parts.join(' · ');
}

/**
 * Sorts by score plus deep-check results (theater copies still last) and marks the best pick:
 * the top full release that isn't suspiciously small, should play on this device, and has a few seeders.
 */
export function rankForDevice(releases: RankedRelease[], req: SearchRequest): RankedRelease[] {
  const total = (r: RankedRelease) => score(r, req) + (r.verdict ? VERDICT_BONUS[r.verdict.outcome] : 0);
  const sorted = releases.map((r) => ({ r, s: total(r) })).sort((a, b) => b.s - a.s).map((x) => x.r);
  const best = sorted.find(
    (r) => r.tier === 'full' && r.sizeFlag !== 'small' && devicePlayability(r, req.dolby) !== 'risky' && r.seeders >= 3 && r.verdict?.outcome !== 'suspect',
  );
  if (best) {
    best.best = true;
    best.pickReason = reasonFor(best, req);
  }
  return sorted;
}
