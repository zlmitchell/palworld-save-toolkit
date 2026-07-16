import { readFileSync } from 'fs';
import { decompress as ooz } from '../docs/vendor/ooz-wasm/index.js';
import { decompressSav } from '../docs/js/sav.js';
import { GvasFile, PALWORLD_TYPE_HINTS } from '../docs/js/gvas.js';
import { LEVEL_CUSTOM_PROPERTIES } from '../docs/js/paldata.js';

const dir = process.argv[2];
const { gvas } = await decompressSav(new Uint8Array(readFileSync(dir + '/Level.sav')), ooz);
const g = GvasFile.read(gvas, PALWORLD_TYPE_HINTS, LEVEL_CUSTOM_PROPERTIES);
const out = g.write(LEVEL_CUSTOM_PROPERTIES);
const same = out.byteLength === gvas.byteLength && out.every((b, i) => b === gvas[i]);
console.log(`round-trip save2 Level.sav: ${same ? 'IDENTICAL' : 'DIFFERS'} (${gvas.byteLength} bytes)`);
process.exit(same ? 0 : 1);
