/**
 * Scores local Ollama models on the source-check task: accuracy on labelled cases, speed, and memory.
 *
 *   npx tsx scripts/ai-bench.ts gemma4:e2b lfm3-vl:2b qwen3.5:0.8b
 *   OLLAMA_URL=http://localhost:11434 (default)
 */
import { SYSTEM_PROMPT, VERDICT_JSON_SCHEMA, VerdictSchema } from '../src/llm.ts';
import { decideOutcome } from '../src/verify.ts';

const OLLAMA = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');

type Expect = { match: boolean; kinds: string[]; full?: boolean; decision: string[] };
interface Case {
  name: string;
  expect: Expect;
  evidence: Record<string, unknown>;
}

const movie = (title: string, year: string, runtime: number) => ({ type: 'movie', title, year, expectedRuntimeMinutes: runtime, releaseState: 'available' });
const ep = (title: string, year: string, season: number, episode: number, runtime: number) => ({ type: 'tv', title, year, season, episode, expectedRuntimeMinutes: runtime });
const file = (name: string, sizeMB: number, minutes: number, res: string, audio: string[]) => ({ name, sizeMB, measuredRuntimeMinutes: minutes, resolution: res, videoCodec: 'h264', audioTracks: audio, subtitleTracks: [] });
const checks = (runtimeCheck: string, fileIssues: string[] = [], theater: string | null = null) => ({ runtimeCheck, fileIssues, nameSuggestsTheaterCopy: theater });

const THEATER = ['theater_cam', 'theater_screener'];

const CASES: Case[] = [
  {
    name: 'full movie (YTS BluRay)',
    expect: { match: true, kinds: ['full_release'], full: true, decision: ['verified'] },
    evidence: {
      requested: movie('The Odyssey', '2026', 173),
      release: { name: 'The Odyssey (2026) [1080p] [BluRay] [5.1] [YTS.GG - YTS.BZ]', sizeMB: 3200, seeders: 9986, filesInTorrent: ['The Odyssey (2026) [1080p]/The.Odyssey.2026.1080p.BluRay.x264.AAC5.1-[YTS.GG - YTS.BZ].mp4 (3200 MB)'] },
      file: file('The.Odyssey.2026.1080p.BluRay.x264.AAC5.1-[YTS.GG - YTS.BZ].mp4', 3200, 172.6, '1920x1080', ['aac (und, 6ch)']),
      automatedChecks: checks('ok'),
    },
  },
  {
    name: 'screener (DVDScr)',
    expect: { match: true, kinds: THEATER, decision: ['theater'] },
    evidence: {
      requested: { ...movie('Drishyam: The Conclusion', '2026', 148), releaseState: 'theaters' },
      release: { name: 'www.5MovieRulz.company - Drishyam The Conclusion (2026) 1080p Hindi DVDScr - x264 - AAC - 2.7GB.mkv', sizeMB: 2700, seeders: 328, filesInTorrent: ['Drishyam The Conclusion (2026) 1080p Hindi DVDScr - x264 - AAC - 2.7GB.mkv (2700 MB)'] },
      file: file('Drishyam The Conclusion (2026) 1080p Hindi DVDScr - x264 - AAC - 2.7GB.mkv', 2700, 141, '1920x800', ['aac (eng, 2ch)']),
      automatedChecks: checks('ok', [], 'screener'),
    },
  },
  {
    name: 'camera copy (PreDVD)',
    expect: { match: true, kinds: THEATER, decision: ['theater'] },
    evidence: {
      requested: { ...movie('Drishyam: The Conclusion', '2026', 148), releaseState: 'theaters' },
      release: { name: 'Drishyam The Conclusion (2026) Hindi HQ PreDVD - 1080p - x264 - HQ Clean - AAC - 2.6GB', sizeMB: 2600, seeders: 70, filesInTorrent: ['Drishyam The Conclusion (2026) Hindi HQ PreDVD 1080p.mkv (2600 MB)'] },
      file: file('Drishyam The Conclusion (2026) Hindi HQ PreDVD 1080p.mkv', 2600, 139, '1920x1080', ['aac (und, 2ch)']),
      automatedChecks: checks('ok', [], 'cam'),
    },
  },
  {
    name: 'wrong sequel (Part Two vs Three)',
    expect: { match: false, kinds: ['wrong_title'], decision: ['rejected'] },
    evidence: {
      requested: movie('Dune: Part Three', '2026', 165),
      release: { name: 'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.Atmos.H.264-FLUX', sizeMB: 9800, seeders: 2100, filesInTorrent: ['Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.Atmos.H.264-FLUX.mkv (9800 MB)'] },
      file: file('Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.Atmos.H.264-FLUX.mkv', 9800, 166, '1920x804', ['eac3 (eng, 6ch)']),
      automatedChecks: checks('ok'),
    },
  },
  {
    name: 'wrong year (1997 miniseries)',
    expect: { match: false, kinds: ['wrong_title'], decision: ['rejected'] },
    evidence: {
      requested: movie('The Odyssey', '2026', 173),
      release: { name: 'The.Odyssey.1997.Miniseries.720p.WEBRip.x264', sizeMB: 2100, seeders: 40, filesInTorrent: ['The.Odyssey.1997.Miniseries.720p.WEBRip.x264.mp4 (2100 MB)'] },
      file: file('The.Odyssey.1997.Miniseries.720p.WEBRip.x264.mp4', 2100, 176, '1280x720', ['aac (eng, 2ch)']),
      automatedChecks: checks('ok'),
    },
  },
  {
    name: 'sample clip',
    expect: { match: true, kinds: ['trailer_or_sample'], full: false, decision: ['rejected', 'suspect'] },
    evidence: {
      requested: movie('The Odyssey', '2026', 173),
      release: { name: 'The.Odyssey.2026.1080p.WEB-DL.Sample', sizeMB: 45, seeders: 12, filesInTorrent: ['sample-the.odyssey.2026.1080p.mkv (45 MB)'] },
      file: file('sample-the.odyssey.2026.1080p.mkv', 45, 2.1, '1920x1080', ['eac3 (eng, 6ch)']),
      automatedChecks: checks('short', ['Picked file looks like a sample']),
    },
  },
  {
    name: 'incomplete (58 of 173 min)',
    expect: { match: true, kinds: ['full_release', 'unknown', 'fake_or_malware', 'trailer_or_sample'], full: false, decision: ['suspect', 'rejected'] },
    evidence: {
      requested: movie('The Odyssey', '2026', 173),
      release: { name: 'The.Odyssey.2026.1080p.WEB-DL.x264-NoGrp', sizeMB: 1100, seeders: 25, filesInTorrent: ['The.Odyssey.2026.1080p.WEB-DL.x264-NoGrp.mkv (1100 MB)'] },
      file: file('The.Odyssey.2026.1080p.WEB-DL.x264-NoGrp.mkv', 1100, 58, '1920x1080', ['aac (eng, 2ch)']),
      automatedChecks: checks('short'),
    },
  },
  {
    name: 'fake with .exe',
    expect: { match: true, kinds: ['fake_or_malware'], decision: ['rejected'] },
    evidence: {
      requested: movie('The Odyssey', '2026', 173),
      release: { name: 'The Odyssey 2026 1080p WEB-DL x265', sizeMB: 1400, seeders: 600, filesInTorrent: ['The Odyssey 2026 1080p.zip (1350 MB)', 'Codec Installer.exe (2 MB)', 'Password.txt (1 MB)'] },
      file: file('The Odyssey 2026 1080p.zip', 1350, 0, 'unknown', []),
      automatedChecks: checks('unknown', ['Contains a program file (Codec Installer.exe) — typical of fake or unsafe torrents', 'Mentions a password — typical of fake torrents']),
    },
  },
  {
    name: 'right TV episode',
    expect: { match: true, kinds: ['full_release'], full: true, decision: ['verified'] },
    evidence: {
      requested: ep('Severance', '2022', 2, 3, 50),
      release: { name: 'Severance.S02E03.Who.Is.Alive.1080p.ATVP.WEB-DL.DDP5.1.H.264-NTb', sizeMB: 2300, seeders: 410, filesInTorrent: ['Severance.S02E03.1080p.ATVP.WEB-DL.mkv (2300 MB)'] },
      file: file('Severance.S02E03.1080p.ATVP.WEB-DL.mkv', 2300, 49, '1920x1080', ['eac3 (eng, 6ch)']),
      automatedChecks: checks('ok'),
    },
  },
  {
    name: 'wrong TV episode (E04 for E03)',
    expect: { match: false, kinds: ['wrong_title'], decision: ['rejected'] },
    evidence: {
      requested: ep('Severance', '2022', 2, 3, 50),
      release: { name: 'Severance.S02E04.Woes.Hollow.1080p.ATVP.WEB-DL.DDP5.1.H.264-NTb', sizeMB: 2200, seeders: 380, filesInTorrent: ['Severance.S02E04.1080p.ATVP.WEB-DL.mkv (2200 MB)'] },
      file: file('Severance.S02E04.1080p.ATVP.WEB-DL.mkv', 2200, 47, '1920x1080', ['eac3 (eng, 6ch)']),
      automatedChecks: checks('ok'),
    },
  },
  {
    name: 'punctuation-different title',
    expect: { match: true, kinds: ['full_release'], full: true, decision: ['verified'] },
    evidence: {
      requested: movie('Spider-Man: Brand New Day', '2026', 138),
      release: { name: 'Spider Man Brand New Day (2026) [1080p] [WEBRip] [5.1] [YTS.GG - YTS.BZ]', sizeMB: 2600, seeders: 5400, filesInTorrent: ['Spider.Man.Brand.New.Day.2026.1080p.WEBRip.x264.AAC5.1.mp4 (2600 MB)'] },
      file: file('Spider.Man.Brand.New.Day.2026.1080p.WEBRip.x264.AAC5.1.mp4', 2600, 137, '1920x800', ['aac (und, 6ch)']),
      automatedChecks: checks('ok'),
    },
  },
  {
    name: 'Hindi dub (should flag the dub)',
    expect: { match: true, kinds: ['full_release'], full: true, decision: ['verified'] },
    evidence: {
      requested: movie('The Odyssey', '2026', 173),
      release: { name: 'The Odyssey (2026) Hindi Dubbed 1080p WEB-DL x264 AAC', sizeMB: 2900, seeders: 150, filesInTorrent: ['The Odyssey (2026) Hindi Dubbed 1080p WEB-DL.mkv (2900 MB)'] },
      file: file('The Odyssey (2026) Hindi Dubbed 1080p WEB-DL.mkv', 2900, 172, '1920x1080', ['aac (hin, 2ch)']),
      automatedChecks: checks('ok'),
    },
  },
];

async function ask(model: string, evidence: Record<string, unknown>): Promise<{ ms: number; verdict: ReturnType<typeof VerdictSchema.parse> | null; error?: string }> {
  const started = Date.now();
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: VERDICT_JSON_SCHEMA,
        options: { temperature: 0, num_ctx: 4096 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Requested title and file details (JSON):\n${JSON.stringify(evidence, null, 2)}\n\nReturn your verdict.` },
        ],
      }),
      signal: AbortSignal.timeout(180000),
    });
    const data = (await res.json()) as { message?: { content?: string }; error?: string };
    if (!res.ok || data.error) return { ms: Date.now() - started, verdict: null, error: data.error || `HTTP ${res.status}` };
    const text = data.message?.content || '';
    const parsed = VerdictSchema.safeParse(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
    return { ms: Date.now() - started, verdict: parsed.success ? parsed.data : null, error: parsed.success ? undefined : 'invalid JSON shape' };
  } catch (e) {
    return { ms: Date.now() - started, verdict: null, error: (e as Error).message };
  }
}

type V = NonNullable<Awaited<ReturnType<typeof ask>>['verdict']>;
/** Strict: every field of the AI's answer as labelled. */
const exact = (c: Case, v: V) => v.match === c.expect.match && c.expect.kinds.includes(v.kind) && (c.expect.full === undefined || v.is_full_feature === c.expect.full);
/** What FreeStream actually decides from this answer plus the automated checks (what matters). */
function decision(c: Case, v: V | null): string {
  const ac = c.evidence.automatedChecks as { runtimeCheck: 'ok' | 'short' | 'long' | 'unknown'; fileIssues: string[]; nameSuggestsTheaterCopy: string | null };
  return decideOutcome({
    dangerous: ac.fileIssues.some((i) => i.startsWith('Contains a program') || i.startsWith('Mentions a password')),
    nameTheater: !!ac.nameSuggestsTheaterCopy,
    runtimeCheck: ac.runtimeCheck,
    fileIssueCount: ac.fileIssues.length,
    ai: v ? { match: v.match, kind: v.kind, isFullFeature: v.is_full_feature, confidence: v.confidence } : null,
  });
}

async function memoryOf(model: string): Promise<string> {
  try {
    const ps = (await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models?: { name: string; size: number; size_vram: number }[] };
    const m = ps.models?.find((x) => x.name === model || x.name.startsWith(model));
    return m ? `${(m.size / 1e9).toFixed(2)} GB` : '?';
  } catch {
    return '?';
  }
}

async function unload(model: string) {
  await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) }).catch(() => {});
}

const models = process.argv.slice(2);
if (!models.length) {
  console.error('usage: npx tsx scripts/ai-bench.ts <ollama-model> [more models...]');
  process.exit(1);
}

const summary: string[] = [];
{
  const noAi = CASES.filter((c) => c.expect.decision.includes(decision(c, null))).length;
  summary.push(`${'(no AI: checks only)'.padEnd(22)} decisions ${noAi}/${CASES.length}`);
}
for (const model of models) {
  console.log(`\n=== ${model}`);
  const load = await ask(model, CASES[0].evidence); // warm-up (loads the model); not scored
  if (load.error && !load.verdict) {
    console.log(`  could not run: ${load.error}`);
    summary.push(`${model.padEnd(22)} could not run: ${load.error}`);
    continue;
  }
  const mem = await memoryOf(model);
  let ok = 0;
  let decided = 0;
  let total = 0;
  const times: number[] = [];
  for (const c of CASES) {
    const r = await ask(model, c.evidence);
    total++;
    times.push(r.ms);
    const good = !!r.verdict && exact(c, r.verdict);
    if (good) ok++;
    const d = decision(c, r.verdict);
    const dGood = c.expect.decision.includes(d);
    if (dGood) decided++;
    const got = r.verdict ? `match=${r.verdict.match} kind=${r.verdict.kind} full=${r.verdict.is_full_feature} conf=${r.verdict.confidence.toFixed(2)}` : `ERROR ${r.error}`;
    console.log(`  ${dGood ? '✓' : '✗'} ${c.name.padEnd(34)} -> ${d.padEnd(8)} ${(r.ms / 1000).toFixed(1).padStart(5)}s  AI ${good ? 'exact' : 'off  '}: ${got}`);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length / 1000;
  summary.push(`${model.padEnd(22)} decisions ${decided}/${total}   AI exact ${ok}/${total}   avg ${avg.toFixed(1)}s/check   loaded ${mem}   (first load ${(load.ms / 1000).toFixed(1)}s)`);
  await unload(model);
}
console.log('\n=== Summary');
for (const line of summary) console.log(line);
