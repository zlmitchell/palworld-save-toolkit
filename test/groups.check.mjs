import { readFileSync } from 'fs';
import { decompress as ooz } from '../docs/vendor/ooz-wasm/index.js';
import { decompressSav } from '../docs/js/sav.js';
import { GvasFile, PALWORLD_TYPE_HINTS } from '../docs/js/gvas.js';
import { LEVEL_CUSTOM_PROPERTIES } from '../docs/js/paldata.js';
import { groups } from '../docs/js/palgroups.js';

const PROPS = { ...LEVEL_CUSTOM_PROPERTIES, '.worldSaveData.GroupSaveDataMap': groups };
let fail = 0;
for (const dir of process.argv.slice(2)) {
  const { gvas } = await decompressSav(new Uint8Array(readFileSync(dir + '/Level.sav')), ooz);
  const g = GvasFile.read(gvas, PALWORLD_TYPE_HINTS, PROPS);
  const groupWarnings = g.warnings.filter(w => w.includes('group'));
  const gm = g.properties.worldSaveData.value.GroupSaveDataMap.value;
  let decoded = 0, raw = 0, guilds = [];
  for (const grp of gm) {
    const v = grp.value.RawData.value;
    if ('values' in v) raw++;
    else {
      decoded++;
      if (v.guild) guilds.push(`"${v.guild.guild_name}" [${v.guild.tail.kind}] admin=${v.guild.tail.admin_player_uid} members=${v.guild.tail.players.map(p=>p.player_info.player_name).join('/')}`);
    }
  }
  const out = g.write(PROPS);
  const same = out.byteLength === gvas.byteLength && out.every((b, i) => b === gvas[i]);
  console.log(`${dir.split(/[\/]/).pop()}: groups decoded=${decoded} raw=${raw} | round-trip ${same ? 'IDENTICAL' : 'DIFFERS'} (${gvas.byteLength})`);
  groupWarnings.forEach(w => console.log('  warn:', w));
  guilds.forEach(x => console.log('  guild:', x));
  if (!same || raw > 0) fail++;
}
process.exit(fail ? 1 : 0);
