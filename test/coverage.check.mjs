import { readFileSync } from 'fs';
import { decompress as ooz } from '../docs/vendor/ooz-wasm/index.js';
import { inspectWorld } from '../docs/js/migrate.js';
import { PALDEX } from '../docs/js/paldex.js';
import { PASSIVES } from '../docs/js/passives.js';

const dir = String.raw`C:\Users\Zach\Documents\code\AMP-dockerized\.save\new-export\FAE3F4FC432820CA90ABA0AB099EEF01`;
const info = await inspectWorld(new Uint8Array(readFileSync(dir + String.raw`\Level.sav`)), ooz);
const species = [...new Set(info.pals.map(p => p.species))];
const unmappedPals = species.filter(s => !PALDEX[s.toLowerCase()]);
console.log(`species in save: ${species.length}, mapped: ${species.length - unmappedPals.length}, unmapped: ${unmappedPals.length}`, unmappedPals);
const passiveIds = [...new Set(info.pals.flatMap(p => p.passives))];
const unmappedPassives = passiveIds.filter(id => !PASSIVES[id]);
console.log(`passive ids in save: ${passiveIds.length}, unmapped: ${unmappedPassives.length}`, unmappedPassives);
console.log('samples:', species.slice(0,5).map(s => `${s} -> ${PALDEX[s.toLowerCase()]?.name} #${PALDEX[s.toLowerCase()]?.no}`).join(' | '));
