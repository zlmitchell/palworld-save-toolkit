import { readFileSync } from 'fs';
import { decompress as ooz } from '../docs/vendor/ooz-wasm/index.js';
import { inspectWorld } from '../docs/js/migrate.js';
import { listGuilds, importPlayer } from '../docs/js/transfer.js';

const SRC = String.raw`C:\Users\Zach\Documents\code\AMP-dockerized\.save\6B6C094270BF47BB9FA2602F7B2AD360`;
const DST = String.raw`C:\Users\Zach\Documents\code\AMP-dockerized\.save\new-export\FAE3F4FC432820CA90ABA0AB099EEF01`;
const UID = 'a6cda5a4-0000-0000-0000-000000000000';

const srcLevel = new Uint8Array(readFileSync(SRC + String.raw`\Level.sav`));
const dstLevel = new Uint8Array(readFileSync(DST + String.raw`\Level.sav`));
const srcPlayer = new Uint8Array(readFileSync(SRC + String.raw`\Players\A6CDA5A4000000000000000000000000.sav`));

const before = await inspectWorld(dstLevel, ooz);
console.log('target before:', before.players.length, 'players,', before.palCount, 'pals');
const guilds = await listGuilds(dstLevel, ooz);
console.log('target guilds:', JSON.stringify(guilds.map(g => ({name: g.name, members: g.members}))));

const { levelSav, report } = await importPlayer({
  targetLevelBytes: dstLevel,
  sourceLevelBytes: srcLevel,
  sourcePlayerBytes: srcPlayer,
  playerUid: UID,
  destGuildId: guilds[0].id,
}, ooz);
report.forEach(l => console.log(' ', l));

const after = await inspectWorld(levelSav, ooz);
console.log('target after:', after.players.length, 'players,', after.palCount, 'pals');
const imported = after.players.find(p => p.uid === UID);
console.log('imported player:', imported ? `${imported.nickname} lvl ${imported.level}` : 'MISSING');
const importedPals = after.pals.filter(p => p.owner === UID).length;
console.log('imported player pal ownership count:', importedPals);
const guildsAfter = await listGuilds(levelSav, ooz);
console.log('guild members after:', JSON.stringify(guildsAfter[0].members));
const ok = imported && after.players.length === before.players.length + 1
  && guildsAfter[0].members.length === guilds[0].members.length + 1;
console.log('TRANSFER CHECKS PASSED');
if (!ok) { console.log('TRANSFER CHECKS FAILED'); process.exit(1); }

// --- replace mode: re-import the same player over the merged world
const second = await importPlayer({
  targetLevelBytes: levelSav,
  sourceLevelBytes: srcLevel,
  sourcePlayerBytes: srcPlayer,
  playerUid: UID,
  destGuildId: guilds[0].id,
  replace: true,
  targetPlayerBytes: srcPlayer,
}, ooz);
second.report.forEach(l => console.log(' ', l));
const after2 = await inspectWorld(second.levelSav, ooz);
const guilds2 = await listGuilds(second.levelSav, ooz);
console.log('after replace:', after2.players.length, 'players,', after2.palCount, 'pals, guild members:', JSON.stringify(guilds2[0].members));
const ok2 = after2.players.length === after.players.length
  && after2.pals.filter(p => p.owner === UID).length === 941
  && guilds2[0].members.filter(m => m === 'AGelatinusCube').length === 1;
console.log(ok2 ? 'REPLACE CHECKS PASSED' : 'REPLACE CHECKS FAILED');
process.exit(ok2 ? 0 : 1);
