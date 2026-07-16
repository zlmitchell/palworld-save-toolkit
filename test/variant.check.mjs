import { readFileSync } from 'fs';
import { decompress as ooz } from '../docs/vendor/ooz-wasm/index.js';
import { inspectWorld } from '../docs/js/migrate.js';
import { applyLevelEdits } from '../docs/js/edit.js';

const dir = String.raw`C:\Users\Zach\Documents\code\AMP-dockerized\.save\new-export\FAE3F4FC432820CA90ABA0AB099EEF01`;
const bytes = new Uint8Array(readFileSync(dir + String.raw`\Level.sav`));
const info = await inspectWorld(bytes, ooz);
const pal = info.pals.find(p => !p.alpha && !p.lucky && p.owner);
console.log('before:', pal.species, 'alpha:', pal.alpha, 'lucky:', pal.lucky);

// -> alpha (with Demon God + Diamond Body passives)
let r = await applyLevelEdits(bytes, { pals: [{ instanceId: pal.instanceId, alpha: true, lucky: false, passives: ['PAL_ALLAttack_up3', 'Deffence_up3'] }] }, ooz);
let after = await inspectWorld(r.levelSav, ooz);
let p2 = after.pals.find(p => p.instanceId === pal.instanceId);
console.log('alpha set:', p2.characterId, 'alpha:', p2.alpha, 'lucky:', p2.lucky, 'passives:', p2.passives);

// -> lucky (alpha must clear)
r = await applyLevelEdits(r.levelSav, { pals: [{ instanceId: pal.instanceId, alpha: false, lucky: true }] }, ooz);
after = await inspectWorld(r.levelSav, ooz);
let p3 = after.pals.find(p => p.instanceId === pal.instanceId);
console.log('lucky set:', p3.characterId, 'alpha:', p3.alpha, 'lucky:', p3.lucky);

const ok = p2.alpha && !p2.lucky && p2.characterId.startsWith('BOSS_')
  && p2.passives.join() === 'PAL_ALLAttack_up3,Deffence_up3'
  && !p3.alpha && p3.lucky && p3.characterId === pal.characterId;
console.log(ok ? 'VARIANT CHECKS PASSED' : 'VARIANT CHECKS FAILED');
process.exit(ok ? 0 : 1);
