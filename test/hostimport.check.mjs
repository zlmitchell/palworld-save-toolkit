import { readFileSync } from 'fs';
import { decompress as ooz } from '../docs/vendor/ooz-wasm/index.js';
import { inspectWorld, parsePlayer } from '../docs/js/migrate.js';
import { listGuilds, importPlayer } from '../docs/js/transfer.js';

const COOP = String.raw`C:\Users\Zach\Documents\code\AMP-dockerized\.save\new-export\FAE3F4FC432820CA90ABA0AB099EEF01`;
const SERVER = String.raw`C:\Users\Zach\Documents\code\AMP-dockerized\.save\server-players\8005AF53E70140AAA05F101B45EB4B89`;
const NEW = 'a6cda5a4-0000-0000-0000-000000000000';

const dstLevel = new Uint8Array(readFileSync(SERVER + String.raw`\Level.sav`));
const srcLevel = new Uint8Array(readFileSync(COOP + String.raw`\Level.sav`));
const srcHost = new Uint8Array(readFileSync(COOP + String.raw`\Players\00000000000000000000000000000001.sav`));
const dstHostFile = new Uint8Array(readFileSync(SERVER + String.raw`\Players\A6CDA5A4000000000000000000000000.sav`));

// no-GUID case must be rejected
try {
  await importPlayer({ targetLevelBytes: dstLevel, sourceLevelBytes: srcLevel, sourcePlayerBytes: srcHost,
    playerUid: '00000000-0000-0000-0000-000000000001', destGuildId: 'x' }, ooz);
  console.log('GUARD FAILED: placeholder import was allowed');
  process.exit(1);
} catch (e) { console.log('guard ok:', e.message.slice(0, 60) + '…'); }

const guilds = await listGuilds(dstLevel, ooz);
const { levelSav, playerFile, finalUid, report } = await importPlayer({
  targetLevelBytes: dstLevel, sourceLevelBytes: srcLevel, sourcePlayerBytes: srcHost,
  playerUid: '00000000-0000-0000-0000-000000000001',
  destGuildId: guilds[0].id,
  replace: true, targetPlayerBytes: dstHostFile,
  newUid: 'A6CDA5A4000000000000000000000000',
}, ooz);
report.forEach(l => console.log(' ', l));

const after = await inspectWorld(levelSav, ooz);
const host = after.players.find(p => p.uid === NEW);
const zeros = after.players.find(p => p.uid.endsWith('0001'));
const owned = after.pals.filter(p => p.owner === NEW).length;
const { player: pf } = await parsePlayer(playerFile, ooz);
const pfUid = String(pf.properties.SaveData.value.PlayerUId.value);
const guilds2 = await listGuilds(levelSav, ooz);
console.log(`host: ${host?.nickname} lvl ${host?.level} | placeholder present: ${!!zeros} | owned pals: ${owned} | player file uid: ${pfUid}`);
console.log('guild members:', JSON.stringify(guilds2[0].members));
const ok = host && host.level === 19 && !zeros && owned === 67 && pfUid === NEW
  && after.players.length === 3
  && guilds2[0].members.filter(m => m === 'AGelatinousCube').length === 1;
console.log(ok ? 'HOST IMPORT CHECKS PASSED' : 'HOST IMPORT CHECKS FAILED');
process.exit(ok ? 0 : 1);
