/** Builds suggestions for every profile and prints them. Use with DATA_DIR pointing at a copy of data/. */
import { buildSuggestions, seedsOf } from '../src/suggest.ts';
import { db, flush } from '../src/store.ts';

for (const p of Object.values(db.profiles)) {
  console.log(`\n=== ${p.name} — seeds:`, seedsOf(p.id).map((s) => `${s.title} [${s.kind} ${s.weight.toFixed(2)}]`).join(', '));
  const set = await buildSuggestions(p);
  if (!set) continue;
  console.log(set.ai ? `AI: ${set.ai.model} ${(set.ai.ms / 1000).toFixed(1)}s` : `no AI ${set.aiError || ''}`);
  for (const r of set.rows) {
    console.log(`\n# ${r.title}`);
    for (const c of r.items.slice(0, 10)) console.log(`  ${c.title} (${c.year}, ${c.language}) — ${set.reasons[`${c.mediaType}:${c.id}`] || ''}`);
  }
}
flush();
process.exit(0);
