import { readFileSync } from 'fs';
import { decompress as ooz } from '../docs/vendor/ooz-wasm/index.js';
import { inspectWorld } from '../docs/js/migrate.js';
import { PALDEX } from '../docs/js/paldex.js';

const dir = process.argv[2];
const info = await inspectWorld(new Uint8Array(readFileSync(dir + '/Level.sav')), ooz);
console.log('players:', info.players.map(p => `${p.nickname} lvl ${p.level}`).join(', '));
console.log('pals:', info.palCount, 'undecoded:', info.undecoded);
const species = [...new Set(info.pals.map(p => p.species))];
const unmapped = species.filter(s => !PALDEX[s.toLowerCase()]);
console.log(`species: ${species.length}, unmapped: ${unmapped.length}`);
for (const s of unmapped) console.log('  UNMAPPED:', s);
