import { readFileSync } from 'fs';
import { decompress as ooz } from '../docs/vendor/ooz-wasm/index.js';
import { inspectWorld } from '../docs/js/migrate.js';
import { palMeta } from '../docs/js/palnames.js';

const dir = process.argv[2];
const info = await inspectWorld(new Uint8Array(readFileSync(dir + '/Level.sav')), ooz);
const species = [...new Set(info.pals.map(p => JSON.stringify({species: p.species, alpha: p.alpha})))].map(JSON.parse);
const cats = { pal: 0, human: 0, unknown: 0 };
const unknowns = [];
for (const s of species) {
  const m = palMeta(s);
  cats[m.category]++;
  if (m.category === 'unknown') unknowns.push(`${s.species} -> ${m.displayName}`);
}
console.log('species:', species.length, '| categories:', JSON.stringify(cats));
console.log('unknown (shown humanized):'); unknowns.forEach(u => console.log('  ', u));
for (const probe of ['Boss_LazyCatFish','GYM_ElecPanda_Otomo','YakushimaMonster001_Rainbow','Hunter_Rifle','SalesPerson_Wander']) {
  const m = palMeta({species: probe.replace(/^BOSS_/, ''), alpha: false});
  console.log(`  ${probe} -> [${m.category}] ${m.displayName} #${m.no ?? '-'} ${m.elements.join('/')}`);
}
