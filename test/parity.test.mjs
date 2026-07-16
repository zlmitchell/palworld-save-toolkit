// Parity tests against real Palworld 1.0 saves and against the Python
// implementation's output. Run with:
//   node test/parity.test.mjs <coop-world-dir> <server-world-dir> <old-guid> <new-guid>
// where <server-world-dir> contains Level.sav.bak / Players/<old>.sav.bak
// (pre-migration originals) alongside the Python-migrated Level.sav and
// Players/<new>.sav.

import { readFileSync } from "fs";
import { join } from "path";
import { decompress as ooz } from "../docs/vendor/ooz-wasm/index.js";
import { decompressSav, compressSav } from "../docs/js/sav.js";
import { GvasFile, PALWORLD_TYPE_HINTS } from "../docs/js/gvas.js";
import { LEVEL_CUSTOM_PROPERTIES } from "../docs/js/paldata.js";
import { inspectWorld, migrate } from "../docs/js/migrate.js";

const [coopDir, serverDir, oldGuid, newGuid] = process.argv.slice(2);
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 1. Round-trip: parse + rewrite must reproduce the decompressed bytes exactly.
for (const [label, path, props] of [
  ["Level.sav", join(coopDir, "Level.sav"), LEVEL_CUSTOM_PROPERTIES],
  ["player.sav", join(coopDir, "Players", oldGuid.toUpperCase() + ".sav"), {}],
]) {
  const data = new Uint8Array(readFileSync(path));
  const { gvas } = await decompressSav(data, ooz);
  const parsed = GvasFile.read(gvas, PALWORLD_TYPE_HINTS, props);
  const out = parsed.write(props);
  check(`round-trip ${label}`, bytesEqual(out, gvas), `${gvas.byteLength} bytes`);
}

// 2. PlZ re-compression must be readable back.
{
  const data = new Uint8Array(readFileSync(join(coopDir, "Level.sav")));
  const { gvas, saveType } = await decompressSav(data, ooz);
  const plz = await compressSav(gvas, saveType);
  const { gvas: again } = await decompressSav(plz, ooz);
  check("PlZ compress/decompress", bytesEqual(gvas, again));
}

// 3. Inspection sanity.
{
  const data = new Uint8Array(readFileSync(join(coopDir, "Level.sav")));
  const info = await inspectWorld(data, ooz);
  console.log("  players:", info.players.map((p) => `${p.nickname} (lvl ${p.level}, ${p.uid})`).join(", "));
  console.log(`  pals: ${info.palCount}, guilds: ${info.guilds}, undecoded: ${info.undecoded}`);
  check("inspection finds players", info.players.length > 0 && info.undecoded === 0);
}

// 4. Migration parity with the Python implementation.
{
  const levelOrig = new Uint8Array(readFileSync(join(serverDir, "Level.sav.bak")));
  const playerOrig = new Uint8Array(readFileSync(join(serverDir, "Players", oldGuid.toUpperCase() + ".sav.bak")));
  const { levelSav, playerSav, report } = await migrate(levelOrig, playerOrig, oldGuid, newGuid, ooz);
  for (const line of report) console.log("  " + line);

  const pyLevel = new Uint8Array(readFileSync(join(serverDir, "Level.sav")));
  const pyPlayer = new Uint8Array(readFileSync(join(serverDir, "Players", newGuid.toUpperCase() + ".sav")));
  const { gvas: jsLevelGvas } = await decompressSav(levelSav, ooz);
  const { gvas: pyLevelGvas } = await decompressSav(pyLevel, ooz);
  const { gvas: jsPlayerGvas } = await decompressSav(playerSav, ooz);
  const { gvas: pyPlayerGvas } = await decompressSav(pyPlayer, ooz);
  check("migrated Level.sav matches Python output", bytesEqual(jsLevelGvas, pyLevelGvas),
    `${jsLevelGvas.byteLength} vs ${pyLevelGvas.byteLength} bytes`);
  check("migrated player .sav matches Python output", bytesEqual(jsPlayerGvas, pyPlayerGvas),
    `${jsPlayerGvas.byteLength} vs ${pyPlayerGvas.byteLength} bytes`);
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
