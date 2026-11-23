/**
 * Health check ("doctor"): tests every moving part and says exactly what to fix.
 * Runs in the server every few hours (a failure puts a red dot on the Settings icon), from
 * Settings → Health check, and from the terminal with `npm run doctor`.
 *
 * Nothing here changes anything or spends money: remote AI providers are only checked for a key.
 */
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { testIndexer } from './indexers.ts';
import { hasPin } from './profiles.ts';
import { DATA_DIR, db, getSettings, save, type HealthCheck, type HealthReport } from './store.ts';
import * as tmdb from './tmdb.ts';

/** Checked here rather than imported from verify.ts, which would start a torrent client in the terminal command. */
const hasFfmpeg = (() => {
  try {
    return spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;
  } catch {
    return false;
  }
})();

/** Docker Desktop's shared folders (virtiofs) report a made-up disk size inside containers. */
const VIRTIOFS = 0x6a656a63;

const GB = 1024 ** 3;
const fmtGb = (b: number) => `${(b / GB).toFixed(b < 10 * GB ? 1 : 0)} GB`;

async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function folderSize(path: string): Promise<number> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.blocks * 512;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const e of await readdir(path).catch(() => [] as string[])) total += await folderSize(join(path, e));
  return total;
}

async function getJson<T>(url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

// --- individual checks ---------------------------------------------------------------------------------

async function checkStorage(): Promise<HealthCheck> {
  const ok = await writable(DATA_DIR);
  return ok
    ? { id: 'storage', name: 'App data', status: 'ok', detail: `Settings, profiles and history are saved in ${DATA_DIR}.` }
    : { id: 'storage', name: 'App data', status: 'fail', detail: `Can't write to ${DATA_DIR}, so settings and progress won't be saved.`, fix: 'Check the folder exists and this user (or the Docker volume) can write to it.' };
}

async function checkTmdb(): Promise<HealthCheck> {
  const name = 'Catalog (TMDB)';
  if (!getSettings().tmdbApiKey) return { id: 'tmdb', name, status: 'fail', detail: 'No TMDB key, so there are no movies or shows to browse.', fix: 'Get a free key at themoviedb.org → Settings → API, and paste it under Settings → Catalog.' };
  try {
    await tmdb.ping();
    return { id: 'tmdb', name, status: 'ok', detail: 'Connected.' };
  } catch (e) {
    const msg = (e as Error).message;
    return { id: 'tmdb', name, status: 'fail', detail: msg, fix: /key/i.test(msg) ? 'Check the key under Settings → Catalog.' : 'Check the internet connection; TMDB may also be down briefly.' };
  }
}

async function checkIndexers(): Promise<HealthCheck[]> {
  const s = getSettings();
  const name = s.indexerType === 'jackett' ? 'Torrent search (Jackett)' : 'Torrent search (Prowlarr)';
  const conn = await testIndexer();
  if (!conn.ok) {
    return [
      {
        id: 'indexer',
        name,
        status: 'fail',
        detail: conn.message,
        fix: !s.indexerApiKey
          ? `Copy the API key from ${s.indexerType === 'jackett' ? 'Jackett' : 'Prowlarr (Settings → General)'} into Settings → Torrent search.`
          : `Check ${s.indexerType} is running at ${s.indexerUrl}${process.env.DATA_DIR === '/data' ? ' (in Docker use http://prowlarr:9696)' : ''}, and that the API key is current.`,
      },
    ];
  }
  const out: HealthCheck[] = [{ id: 'indexer', name, status: 'ok', detail: conn.message }];

  // Prowlarr's own list: removed or turned-off indexers no longer slow searches, so their history doesn't count.
  const headers = { 'X-Api-Key': s.indexerApiKey };
  let indexers: { id: number; name: string; enable: boolean }[] | null = null;
  if (s.indexerType === 'prowlarr') {
    try {
      indexers = await getJson<{ id: number; name: string; enable: boolean }[]>(`${s.indexerUrl}/api/v1/indexer`, headers);
    } catch {
      /* the connection check above already covers Prowlarr being unreachable */
    }
  }

  // Indexers that keep failing slow every search down (each gets up to 25 s).
  const health = db.indexerHealth || {};
  const recentCut = Date.now() - 14 * 24 * 3600 * 1000;
  for (const [ix, h] of Object.entries(health)) {
    if (h.lastAt < recentCut || h.recent.length < 3) continue;
    if (indexers && !indexers.some((i) => i.name === ix && i.enable)) continue;
    const fails = h.recent.filter((x) => x === 0).length;
    if (fails / h.recent.length < 0.5) continue;
    out.push({
      id: `indexer-${ix}`,
      name: `Indexer: ${ix}`,
      status: 'warn',
      detail: `Failed ${fails} of the last ${h.recent.length} searches${h.lastError ? ` (${h.lastError})` : ''}. Every search waits up to 25 s for it.`,
      fix: `Turn it off in ${s.indexerType === 'jackett' ? 'Jackett' : 'Prowlarr → Indexers'}${/cloudflare|403/i.test(h.lastError || '') ? ', or add FlareSolverr for Cloudflare-protected sites' : ''}.`,
    });
  }

  // Prowlarr also pauses indexers itself after repeated errors.
  if (indexers) {
    try {
      const statuses = await getJson<{ indexerId: number; disabledTill?: string }[]>(`${s.indexerUrl}/api/v1/indexerstatus`, headers);
      for (const st of statuses) {
        if (!st.disabledTill || Date.parse(st.disabledTill) < Date.now()) continue;
        const ix = indexers.find((i) => i.id === st.indexerId);
        if (!ix?.enable || out.some((c) => c.id === `indexer-${ix.name}`)) continue;
        out.push({
          id: `indexer-${ix.name}`,
          name: `Indexer: ${ix.name}`,
          status: 'warn',
          detail: `Prowlarr has paused it after errors until ${new Date(st.disabledTill).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.`,
          fix: 'Open Prowlarr → Indexers and test it; turn it off if it keeps failing.',
        });
      }
    } catch {
      /* the connection check above already covers Prowlarr being unreachable */
    }
  }
  return out;
}

function checkFfmpeg(): HealthCheck {
  return hasFfmpeg
    ? { id: 'ffmpeg', name: 'ffmpeg', status: 'ok', detail: 'Installed: files a device can’t play are converted live, and source checks measure the real runtime.' }
    : {
        id: 'ffmpeg',
        name: 'ffmpeg',
        status: 'warn',
        detail: 'Not installed. Files with Dolby/DTS audio play silently in Chrome, and source checks can’t measure the runtime.',
        fix: 'Install it (on a Mac: brew install ffmpeg) and restart FreeStream, or run FreeStream with Docker, which includes it.',
      };
}

async function checkAi(): Promise<HealthCheck[]> {
  const s = getSettings();
  if (s.aiMode === 'off') return [{ id: 'ai', name: 'AI', status: 'ok', detail: 'Off. Source checks use runtime and file list only; suggestions use scoring only.' }];
  const out: HealthCheck[] = [];
  if (s.aiMode === 'local' || s.aiMode === 'local+remote') {
    const name = 'AI (local, Ollama)';
    try {
      const tags = await getJson<{ models?: { name: string }[] }>(`${s.aiLocalUrl}/api/tags`, {}, 5000);
      const names = (tags.models || []).map((m) => m.name);
      const has = names.some((n) => n === s.aiLocalModel || n === `${s.aiLocalModel}:latest` || n.split(':')[0] === s.aiLocalModel);
      out.push(
        has
          ? { id: 'ai-local', name, status: 'ok', detail: `Ollama is running with ${s.aiLocalModel}.` }
          : { id: 'ai-local', name, status: 'warn', detail: `Ollama is running, but ${s.aiLocalModel} isn't downloaded.`, fix: `Run: ollama pull ${s.aiLocalModel}` },
      );
    } catch {
      out.push({
        id: 'ai-local',
        name,
        status: 'warn',
        detail: `Can't reach Ollama at ${s.aiLocalUrl}, so source checks and suggestions run without AI.`,
        fix: 'Start Ollama (open the Ollama app, or run: ollama serve), or turn AI off in Settings → AI source check.',
      });
    }
  }
  if (s.aiMode === 'remote' || s.aiMode === 'local+remote') {
    const needsKey = s.aiRemoteProvider !== 'custom';
    out.push(
      needsKey && !s.aiRemoteApiKey
        ? { id: 'ai-remote', name: 'AI (remote)', status: 'warn', detail: `No API key for ${s.aiRemoteProvider}.`, fix: 'Add it under Settings → AI source check, then press Test.' }
        : { id: 'ai-remote', name: 'AI (remote)', status: 'ok', detail: `${s.aiRemoteProvider} is set up (use Test in Settings to try a real request).` },
    );
  }
  return out;
}

async function checkDisk(): Promise<HealthCheck> {
  const s = getSettings();
  const name = 'Download folder';
  if (!(await writable(s.downloadDir))) {
    return { id: 'disk', name, status: 'fail', detail: `Can't write to ${s.downloadDir}, so nothing can stream or download.`, fix: 'Create the folder or fix its permissions, or choose another under Settings → Storage.' };
  }
  const fs = await statfs(s.downloadDir);
  const free = fs.bavail * fs.bsize;
  const used = await folderSize(s.downloadDir);
  const limit = s.cacheLimitGb * GB;
  if (fs.type === VIRTIOFS) {
    return { id: 'disk', name, status: 'ok', detail: `Downloads use ${fmtGb(used)} of the ${s.cacheLimitGb} GB cache limit. (Free disk space can’t be measured from inside Docker Desktop; check it on the computer itself.)` };
  }
  const detail = `${fmtGb(free)} free on the disk · downloads use ${fmtGb(used)} of the ${s.cacheLimitGb} GB cache limit.`;
  if (free < 2 * GB) return { id: 'disk', name, status: 'fail', detail, fix: 'Free some space: delete downloads you no longer need on the Downloads page, or empty the Trash.' };
  if (free < 10 * GB) return { id: 'disk', name, status: 'warn', detail, fix: 'Space is getting low. Remove old downloads, or lower the cache limit under Settings → Storage.' };
  if (limit - used > free) return { id: 'disk', name, status: 'warn', detail, fix: `The cache limit allows ${fmtGb(limit - used)} more, but only ${fmtGb(free)} is free. Lower the limit under Settings → Storage.` };
  return { id: 'disk', name, status: 'ok', detail };
}

function checkTimeZone(): HealthCheck {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const utc = !tz || tz === 'UTC' || tz === 'Etc/UTC';
  return utc && !process.env.TZ
    ? { id: 'tz', name: 'Time zone', status: 'warn', detail: 'Running on UTC, so nightly suggestions run at 3am UTC, not your night.', fix: 'Set TZ in .env, e.g. TZ=Europe/London, and restart.' }
    : { id: 'tz', name: 'Time zone', status: 'ok', detail: `${tz}: nightly suggestions run at 3am local time.` };
}

function checkParentPin(): HealthCheck {
  const kids = Object.values(db.profiles).filter((p) => p.kind === 'kid');
  if (!kids.length) return { id: 'pin', name: 'Parent PIN', status: 'ok', detail: hasPin() ? 'Set.' : 'Not set (no kids’ profiles yet).' };
  return hasPin()
    ? { id: 'pin', name: 'Parent PIN', status: 'ok', detail: `Set; it protects Settings and the limits on ${kids.map((k) => k.name).join(', ')}.` }
    : { id: 'pin', name: 'Parent PIN', status: 'warn', detail: 'Kids’ profiles exist but there’s no parent PIN, so anyone can open Settings or change their limits.', fix: 'Set one under Profiles → Manage profiles → Parent PIN.' };
}

function checkSuggestions(): HealthCheck {
  const name = 'Suggestions';
  const problems: string[] = [];
  const stale = Date.now() - 2 * 24 * 3600 * 1000;
  for (const p of Object.values(db.profiles)) {
    const s = db.suggestions[p.id];
    if (!s) continue;
    if (s.builtAt < stale) problems.push(`${p.name}'s were last built ${Math.round((Date.now() - s.builtAt) / 86400000)} days ago`);
    else if (s.aiError) problems.push(`${p.name}'s last build couldn't use AI (${s.aiError})`);
  }
  if (!problems.length) return { id: 'suggestions', name, status: 'ok', detail: Object.keys(db.suggestions).length ? 'Built on schedule.' : 'None yet; they appear once a profile has watched something.' };
  return {
    id: 'suggestions',
    name,
    status: 'warn',
    detail: `${problems.join('; ')}.`,
    fix: 'Keep the computer awake overnight (or press Rebuild now under Settings → Suggestions); check the AI line above.',
  };
}

// --- run ------------------------------------------------------------------------------------------------

export const worst = (checks: HealthCheck[]): HealthReport['status'] => (checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok');

/** `persist: false` for the terminal command, which runs in its own process and must not overwrite the server's database. */
export async function runDoctor({ persist = true } = {}): Promise<HealthReport> {
  const settled = await Promise.allSettled([checkStorage(), checkTmdb(), checkIndexers(), Promise.resolve(checkFfmpeg()), checkAi(), checkDisk(), Promise.resolve(checkTimeZone()), Promise.resolve(checkParentPin()), Promise.resolve(checkSuggestions())]);
  const names = ['App data', 'Catalog (TMDB)', 'Torrent search', 'ffmpeg', 'AI', 'Download folder', 'Time zone', 'Parent PIN', 'Suggestions'];
  const checks = settled.flatMap((r, i): HealthCheck[] =>
    r.status === 'fulfilled'
      ? [r.value].flat()
      : [{ id: `error-${i}`, name: names[i], status: 'warn', detail: `The check itself failed: ${(r.reason as Error).message}` }],
  );
  const report: HealthReport = { at: Date.now(), status: worst(checks), checks };
  if (persist) {
    db.health = report;
    save();
  }
  return report;
}

let running: Promise<HealthReport> | null = null;
/** One run at a time; concurrent callers share it. */
export function doctor(): Promise<HealthReport> {
  running ||= runDoctor().finally(() => (running = null));
  return running;
}

/** In the server: a first check shortly after start, then every 6 hours. */
export function startDoctor(): void {
  setTimeout(() => doctor().catch(() => {}), 2 * 60 * 1000).unref();
  setInterval(() => doctor().catch(() => {}), 6 * 3600 * 1000).unref();
}
