import { readFileSync } from 'fs';
import { decompress as ooz } from '../docs/vendor/ooz-wasm/index.js';
import { inspectWorld, inspectPlayerFile } from '../docs/js/migrate.js';
import { applyLevelEdits, applyPlayerFileEdits, maxPalEdits } from '../docs/js/edit.js';

const dir = String.raw`C:\Users\Zach\Documents\code\AMP-dockerized\.save\new-export\FAE3F4FC432820CA90ABA0AB099EEF01`;
const levelBytes = new Uint8Array(readFileSync(dir + String.raw`\Level.sav`));
const info = await inspectWorld(levelBytes, ooz);

const host = info.players.find(p => p.nickname === 'AGelatinousCube');
const targetPal = info.pals.find(p => p.owner === host.uid && p.talents.melee === 0 && p.rank === 1); // has absent fields
console.log('before:', targetPal.species, JSON.stringify({t: targetPal.talents, rank: targetPal.rank, lucky: targetPal.lucky, passives: targetPal.passives}));

const { levelSav, report } = await applyLevelEdits(levelBytes, {
  players: [{ uid: host.uid, level: 25, unusedStatusPoints: 50 }],
  pals: [
    { instanceId: targetPal.instanceId, level: 60, stars: 4, souls: 10, lucky: true, friendship: 9999,
      talents: { hp: 100, melee: 100, shot: 100, defense: 100 }, passives: ['Legend', 'PAL_ALLAttack_up2'] },
    ...maxPalEdits(info.pals.filter(p => p.owner === host.uid && p.instanceId !== targetPal.instanceId)),
  ],
}, ooz);
report.forEach(l => console.log(' ', l));

const after = await inspectWorld(levelSav, ooz);
const hostAfter = after.players.find(p => p.uid === host.uid);
const palAfter = after.pals.find(p => p.instanceId === targetPal.instanceId);
console.log('host after: level', hostAfter.level, 'unspent', hostAfter.unusedStatusPoints);
console.log('pal after:', palAfter.species, JSON.stringify({lvl: palAfter.level, t: palAfter.talents, rank: palAfter.rank, lucky: palAfter.lucky, passives: palAfter.passives, friendship: palAfter.friendship}));
const hostPals = after.pals.filter(p => p.owner === host.uid);
const allMaxed = hostPals.every(p => p.talents.hp === 100 && p.talents.melee === 100 && p.rank === 5);
console.log(`all ${hostPals.length} host pals maxed:`, allMaxed);

const pfBytes = new Uint8Array(readFileSync(dir + String.raw`\Players\00000000000000000000000000000001.sav`));
const pfEdited = await applyPlayerFileEdits(pfBytes, { techPoints: 999, ancientTechPoints: 99 }, ooz);
const pfInfo = await inspectPlayerFile(pfEdited, ooz);
console.log('player file after:', pfInfo.techPoints, pfInfo.ancientTechPoints);

const ok = hostAfter.level === 25 && hostAfter.unusedStatusPoints === 50 && palAfter.level === 60
  && palAfter.rank === 5 && palAfter.lucky && palAfter.passives.join() === 'Legend,PAL_ALLAttack_up2'
  && allMaxed && pfInfo.techPoints === 999 && pfInfo.ancientTechPoints === 99;
console.log(ok ? 'EDIT CHECKS PASSED' : 'EDIT CHECKS FAILED');
process.exit(ok ? 0 : 1);
