import { readFileSync } from 'fs';
import { decompress as ooz } from '../docs/vendor/ooz-wasm/index.js';
import { inspectWorld, inspectPlayerFile } from '../docs/js/migrate.js';

const dir = String.raw`C:\Users\Zach\Documents\code\AMP-dockerized\.save\new-export\FAE3F4FC432820CA90ABA0AB099EEF01`;
const info = await inspectWorld(new Uint8Array(readFileSync(dir + String.raw`\Level.sav`)), ooz);
for (const p of info.players) {
  const owned = info.pals.filter(x => x.owner === p.uid);
  console.log(`${p.nickname}: lvl ${p.level}, exp ${p.exp}, hp ${p.hp}, food ${p.fullStomach?.toFixed(0)}, pals owned: ${owned.length}`);
  const top = owned.sort((a,b) => b.level - a.level)[0];
  if (top) console.log(`  top pal: ${top.species} lvl ${top.level} ${top.gender} IVs ${top.talents.hp}/${top.talents.melee}/${top.talents.shot}/${top.talents.defense} passives [${top.passives}] alpha=${top.alpha} lucky=${top.lucky}`);
}
console.log('unowned pals:', info.pals.filter(x => !x.owner || x.owner === '00000000-0000-0000-0000-000000000000').length);
const pf = await inspectPlayerFile(new Uint8Array(readFileSync(dir + String.raw`\Players\00000000000000000000000000000001.sav`)), ooz);
console.log('host player file:', JSON.stringify(pf, (k,v) => v instanceof Date ? v.toISOString() : v));
