// Character editing: players (level, stat/tech points) and pals (level, IVs,
// rank stars, souls, lucky, friendship, passives). Edits mutate the parsed
// property tree using the exact property shapes observed in real saves, then
// rewrite Level.sav / player files with the same verified-lossless machinery
// the migration uses.

import { GvasFile, PALWORLD_TYPE_HINTS } from "./gvas.js";
import { LEVEL_CUSTOM_PROPERTIES } from "./paldata.js";
import { decompressSav, compressSav } from "./sav.js";
import { parseLevel, parsePlayer } from "./migrate.js";

// Property factories matching the types observed in real 1.0 saves:
// Level/Rank/Talent_* are ByteProperty, UnusedStatusPoint is UInt16Property,
// FriendshipPoint/TechnologyPoint are IntProperty, IsRarePal is BoolProperty.
const makeByte = (v) => ({ id: null, value: { type: "None", value: v }, type: "ByteProperty" });
const makeInt = (v) => ({ id: null, value: v, type: "IntProperty" });
const makeU16 = (v) => ({ id: null, value: v, type: "UInt16Property" });
const makeBool = (v) => ({ value: v, id: null, type: "BoolProperty" });
const makeNameArray = (values) => ({
  array_type: "NameProperty",
  id: null,
  value: { values: [...values] },
  type: "ArrayProperty",
});

// Write through the EXISTING property's shape; only use the factory when the
// property doesn't exist yet. Never assume a scalar's type — 1.0 changed
// several of them (e.g. Rank became ByteProperty).
function setScalar(obj, name, v, make) {
  const p = obj[name];
  if (!p) { obj[name] = make(v); return; }
  switch (p.type) {
    case "ByteProperty":
      if (p.value?.type !== "None") throw new Error(`${name}: enum ByteProperty not editable`);
      p.value.value = v;
      break;
    case "Int64Property":
      p.value = BigInt(v);
      break;
    case "IntProperty":
    case "UInt16Property":
    case "UInt32Property":
    case "BoolProperty":
    case "FloatProperty":
    case "NameProperty":
    case "StrProperty":
      p.value = v;
      break;
    default:
      throw new Error(`${name}: unsupported property type ${p.type}`);
  }
}
const setByte = (obj, name, v) => setScalar(obj, name, v, makeByte);
const setInt = (obj, name, v) => setScalar(obj, name, v, makeInt);
const setU16 = (obj, name, v) => setScalar(obj, name, v, makeU16);
const setBool = (obj, name, v) => setScalar(obj, name, v, makeBool);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

export const MAX_PAL = { level: 65, talents: 100, stars: 4, souls: 10 };
export const MAX_PLAYER_LEVEL = 65;

/**
 * Apply edits to Level.sav.
 * @param {Uint8Array} levelBytes
 * @param {{players?: Object[], pals?: Object[]}} edits
 *   players: [{uid, level?, unusedStatusPoints?}]
 *   pals: [{instanceId, level?, stars?, lucky?, friendship?,
 *           talents?: {hp,melee,shot,defense}, souls?: number, passives?: string[]}]
 * @returns {Promise<{levelSav: Uint8Array, report: string[]}>}
 */
export async function applyLevelEdits(levelBytes, edits, ooz) {
  const report = [];
  const { level, saveType } = await parseLevel(levelBytes, ooz);
  const map = level.properties.worldSaveData.value.CharacterSaveParameterMap.value;

  const playerEdits = new Map((edits.players ?? []).map((e) => [e.uid, e]));
  const palEdits = new Map((edits.pals ?? []).map((e) => [e.instanceId, e]));
  let playersTouched = 0, palsTouched = 0;

  for (const entry of map) {
    const raw = entry.value.RawData.value;
    if (!raw || !("object" in raw)) continue;
    const sp = raw.object.SaveParameter.value;

    if (sp.IsPlayer?.value) {
      const e = playerEdits.get(String(entry.key.PlayerUId.value));
      if (!e) continue;
      if (e.level !== undefined) setByte(sp, "Level", clamp(e.level, 1, MAX_PLAYER_LEVEL));
      if (e.unusedStatusPoints !== undefined) setU16(sp, "UnusedStatusPoint", clamp(e.unusedStatusPoints, 0, 9999));
      playersTouched++;
    } else {
      const e = palEdits.get(String(entry.key.InstanceId.value));
      if (!e) continue;
      if (e.level !== undefined) setByte(sp, "Level", clamp(e.level, 1, MAX_PAL.level));
      if (e.talents !== undefined) {
        setByte(sp, "Talent_HP", clamp(e.talents.hp, 0, MAX_PAL.talents));
        setByte(sp, "Talent_Melee", clamp(e.talents.melee, 0, MAX_PAL.talents));
        setByte(sp, "Talent_Shot", clamp(e.talents.shot, 0, MAX_PAL.talents));
        setByte(sp, "Talent_Defense", clamp(e.talents.defense, 0, MAX_PAL.talents));
      }
      if (e.stars !== undefined) setByte(sp, "Rank", clamp(e.stars, 0, MAX_PAL.stars) + 1);
      if (e.souls !== undefined) {
        const s = clamp(e.souls, 0, MAX_PAL.souls);
        setByte(sp, "Rank_HP", s);
        setByte(sp, "Rank_Attack", s);
        setByte(sp, "Rank_Defence", s);
        setByte(sp, "Rank_CraftSpeed", s);
      }
      if (e.lucky !== undefined) setBool(sp, "IsRarePal", !!e.lucky);
      if (e.alpha !== undefined && sp.CharacterID) {
        // Alpha status lives in the species id itself as a BOSS_ prefix
        const cur = String(sp.CharacterID.value);
        const isAlpha = /^boss_/i.test(cur);
        if (e.alpha && !isAlpha) sp.CharacterID.value = "BOSS_" + cur;
        else if (!e.alpha && isAlpha) sp.CharacterID.value = cur.replace(/^boss_/i, "");
      }
      if (e.friendship !== undefined) setInt(sp, "FriendshipPoint", clamp(e.friendship, 0, 99999));
      if (e.passives !== undefined) {
        const list = e.passives.filter((s) => /^[0-9A-Za-z_]+$/.test(s)).slice(0, 4);
        if (sp.PassiveSkillList) sp.PassiveSkillList.value.values = list;
        else sp.PassiveSkillList = makeNameArray(list);
      }
      palsTouched++;
    }
  }

  report.push(`edited: ${playersTouched} player(s), ${palsTouched} pal(s)`);
  const levelSav = await compressSav(level.write(LEVEL_CUSTOM_PROPERTIES), saveType);

  // Verify the result still parses and the counts are stable.
  const { gvas } = await decompressSav(levelSav, ooz);
  const check = GvasFile.read(gvas, PALWORLD_TYPE_HINTS, LEVEL_CUSTOM_PROPERTIES);
  const n = check.properties.worldSaveData.value.CharacterSaveParameterMap.value.length;
  if (n !== map.length) throw new Error(`verification failed: character count changed (${map.length} -> ${n})`);
  report.push("verification passed: edited Level.sav re-parses cleanly");
  return { levelSav, report };
}

/**
 * Apply edits to a Players/<guid>.sav file (tech points).
 * @returns {Promise<Uint8Array>}
 */
export async function applyPlayerFileEdits(playerBytes, { techPoints, ancientTechPoints }, ooz) {
  const { player, saveType } = await parsePlayer(playerBytes, ooz);
  const sd = player.properties.SaveData.value;
  if (techPoints !== undefined) setInt(sd, "TechnologyPoint", clamp(techPoints, 0, 99999));
  if (ancientTechPoints !== undefined) setInt(sd, "bossTechnologyPoint", clamp(ancientTechPoints, 0, 99999));
  const out = await compressSav(player.write({}), saveType);
  await parsePlayer(out, ooz); // verify
  return out;
}

/** Build the pal-edit list that maxes every given pal (level/IVs/stars/souls). */
export function maxPalEdits(pals) {
  return pals.map((p) => ({
    instanceId: p.instanceId,
    level: MAX_PAL.level,
    talents: { hp: MAX_PAL.talents, melee: MAX_PAL.talents, shot: MAX_PAL.talents, defense: MAX_PAL.talents },
    stars: MAX_PAL.stars,
    souls: MAX_PAL.souls,
  }));
}
