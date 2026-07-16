import { readFileSync } from 'fs';
import { decompress as ooz } from '../docs/vendor/ooz-wasm/index.js';
import { inspectWorld } from '../docs/js/migrate.js';
import { addPal } from '../docs/js/addpal.js';

const dir = String.raw`C:\Users\Zach\Documents\code\AMP-dockerized\.save\new-export\FAE3F4FC432820CA90ABA0AB099EEF01`;
const levelBytes = new Uint8Array(readFileSync(dir + String.raw`\Level.sav`));
const hostFile = new Uint8Array(readFileSync(dir + String.raw`\Players\00000000000000000000000000000001.sav`));
const HOST = '00000000-0000-0000-0000-000000000001';

const before = await inspectWorld(levelBytes, ooz);
console.log('before:', before.palCount, 'pals; host owns', before.pals.filter(p => p.owner === HOST).length);

// 1. add a boss Jetragon lvl 50 (species exists nowhere in this world -> cross-species clone)
let r = await addPal(levelBytes, hostFile, { ownerUid: HOST, species: 'jetdragon', level: 50, variant: 'alpha', gender: 'Female' }, ooz);
r.report.forEach(l => console.log(' ', l));
let after = await inspectWorld(r.levelSav, ooz);
const jet = after.pals.find(p => p.species.toLowerCase() === 'jetdragon' && p.owner === HOST);
console.log('jetragon:', JSON.stringify({found: !!jet, alpha: jet?.alpha, lvl: jet?.level, gender: jet?.gender, owner: jet?.owner === HOST}));

// 2. duplicate an existing pal (same species, keeps stats)
const src = after.pals.find(p => p.owner === HOST && p.level >= 10);
r = await addPal(r.levelSav, hostFile, { ownerUid: HOST, duplicateInstanceId: src.instanceId }, ooz);
r.report.forEach(l => console.log(' ', l));
after = await inspectWorld(r.levelSav, ooz);
const dupes = after.pals.filter(p => p.species === src.species && p.level === src.level && p.owner === HOST);
console.log(`duplicate of ${src.species}: count now ${dupes.length}`);

const ok = jet && jet.alpha && jet.level === 50 && jet.gender === 'Female' && jet.owner === HOST
  && after.palCount === before.palCount + 2 && dupes.length >= 2;
console.log(ok ? 'ADDPAL CHECKS PASSED' : 'ADDPAL CHECKS FAILED');
process.exit(ok ? 0 : 1);
