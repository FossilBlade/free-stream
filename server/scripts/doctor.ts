/**
 * FreeStream health check from the terminal. Prints OK / WARN / FAIL for each part, with what to do.
 *   npm run doctor                              (on the computer running FreeStream)
 *   docker exec freestream npm run doctor       (Docker)
 * Exits with code 1 if anything fails. Read-only: it never changes settings or data.
 */
import { existsSync } from 'node:fs';
import type { HealthCheck } from '../src/store.ts';

// Load .env before the app modules read it (it's optional, e.g. absent in Docker).
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  /* no .env */
}
const { runDoctor, worst } = await import('../src/doctor.ts');
const { getSettings } = await import('../src/store.ts');

// Settings saved by the Docker setup use container paths; checking them from the Mac would give false failures.
const s = getSettings();
if (!existsSync('/.dockerenv') && (s.downloadDir === '/downloads' || /\/\/prowlarr:/.test(s.indexerUrl))) {
  console.log('\nThese settings belong to the Docker setup. Run the check inside Docker instead:\n\n  docker exec freestream npm run doctor\n');
  process.exit(0);
}

const color = process.stdout.isTTY;
const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const TAG = { ok: paint('32', 'OK  '), warn: paint('33', 'WARN'), fail: paint('31', 'FAIL') };

async function serverCheck(): Promise<HealthCheck> {
  const port = Number(process.env.PORT) || 8080;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { id: 'server', name: 'FreeStream server', status: 'ok', detail: `Running on port ${port}.` };
  } catch {
    return { id: 'server', name: 'FreeStream server', status: 'fail', detail: `Nothing answering on port ${port}.`, fix: 'Start it with npm start, or npm run docker:up for Docker.' };
  }
}

const report = await runDoctor({ persist: false });
const checks = [await serverCheck(), ...report.checks];
const width = Math.max(...checks.map((c) => c.name.length));
console.log(paint('1', '\nFreeStream health check\n'));
for (const c of checks) {
  console.log(`${TAG[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`);
  if (c.fix && c.status !== 'ok') console.log(`${' '.repeat(width + 8)}${paint('2', '→ ' + c.fix)}`);
}
const status = worst(checks);
console.log(`\n${status === 'ok' ? paint('32', 'Everything looks good.') : status === 'warn' ? paint('33', 'Working, with warnings above.') : paint('31', 'Something needs fixing (see FAIL above).')}\n`);
process.exit(status === 'fail' ? 1 : 0);
