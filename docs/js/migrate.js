// Co-op -> dedicated server migration for Palworld saves.
// Port of this repo's python/migrate_coop_to_dedicated.py: the 4-layer fix
// documented by quadrantbs/palworld-hostfix-toolkit, verified against real
// Palworld 1.0 saves.

import { GvasFile, UUID, PALWORLD_TYPE_HINTS, ZERO_UUID } from "./gvas.js";
import { LEVEL_CUSTOM_PROPERTIES } from "./paldata.js";
import { decompressSav, compressSav } from "./sav.js";

export function formatGuid(guid32) {
  const g = guid32.toLowerCase().replace(/-/g, "");
  if (g.length !== 32) throw new Error(`GUID must be 32 hex chars, got ${guid32}`);
  return `${g.slice(0, 8)}-${g.slice(8, 12)}-${g.slice(12, 16)}-${g.slice(16, 20)}-${g.slice(20)}`;
}

function findBytes(hay, needle, from = 0) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function replaceBytes(hay, needle, replacement) {
  let count = 0;
  let i = 0;
  const out = new Uint8Array(hay);
  while ((i = findBytes(out, needle, i)) !== -1) {
    out.set(replacement, i);
    i += needle.length;
    count++;
  }
  return { bytes: out, count };
}

export async function parseLevel(levelBytes, ooz) {
  const { gvas, saveType } = await decompressSav(levelBytes, ooz);
  const level = GvasFile.read(gvas, PALWORLD_TYPE_HINTS, LEVEL_CUSTOM_PROPERTIES);
  return { level, gvas, saveType };
}

export async function parsePlayer(playerBytes, ooz) {
  const { gvas, saveType } = await decompressSav(playerBytes, ooz);
  const player = GvasFile.read(gvas, PALWORLD_TYPE_HINTS, {});
  return { player, gvas, saveType };
}

function charMapOf(level) {
  return level.properties.worldSaveData.value.CharacterSaveParameterMap.value;
}

function saveParamOf(entry) {
  const raw = entry.value.RawData.value;
  if (!raw || !("object" in raw)) return null; // undecoded (raw fallback)
  return raw.object.SaveParameter.value;
}

/** World summary: players (nickname/level), pal count, per-uid key counts. */
export async function inspectWorld(levelBytes, ooz) {
  const { level } = await parseLevel(levelBytes, ooz);
  const players = [];
  let palCount = 0;
  let undecoded = 0;
  for (const e of charMapOf(level)) {
    const sp = saveParamOf(e);
    if (sp === null) { undecoded++; continue; }
    if (sp.IsPlayer?.value) {
      players.push({
        uid: String(e.key.PlayerUId.value),
        instanceId: String(e.key.InstanceId.value),
        nickname: sp.NickName?.value ?? "(unnamed)",
        level: sp.Level?.value?.value ?? sp.Level?.value ?? null,
      });
    } else {
      palCount++;
    }
  }
  const wsd = level.properties.worldSaveData.value;
  const guilds = (wsd.GroupSaveDataMap?.value ?? []).filter(
    (g) => g.value.GroupType.value.value === "EPalGroupType::Guild"
  ).length;
  return { players, palCount, guilds, undecoded, warnings: level.warnings };
}

/**
 * Run the full migration.
 * @param {Uint8Array} levelBytes - Level.sav contents
 * @param {Uint8Array} oldPlayerBytes - Players/<oldGuid>.sav contents
 * @param {string} oldGuid32 - 32-hex-char GUID (usually 0...01, the co-op host)
 * @param {string} newGuid32 - 32-hex-char GUID assigned by the dedicated server
 * @param {Function} ooz
 * @returns {Promise<{levelSav: Uint8Array, playerSav: Uint8Array, report: string[]}>}
 */
export async function migrate(levelBytes, oldPlayerBytes, oldGuid32, newGuid32, ooz) {
  const report = [];
  const oldF = formatGuid(oldGuid32);
  const newF = formatGuid(newGuid32);
  if (oldF === newF) throw new Error("old and new GUIDs are identical");
  const oldB = UUID.fromString(oldF).rawBytes;
  const newB = UUID.fromString(newF).rawBytes;

  // ---- Layer 0a: player file
  const { player, saveType: pst } = await parsePlayer(oldPlayerBytes, ooz);
  const sd = player.properties.SaveData.value;
  if (String(sd.PlayerUId.value) !== oldF) {
    throw new Error(`player file PlayerUId is ${sd.PlayerUId.value}, expected ${oldF}`);
  }
  sd.PlayerUId.value = newF;
  sd.IndividualId.value.PlayerUId.value = newF;
  const hostInstance = String(sd.IndividualId.value.InstanceId.value);
  const playerSav = await compressSav(player.write({}), pst);
  report.push(`[0a] player file re-keyed (host instance ${hostInstance})`);

  const { level, saveType: lst } = await parseLevel(levelBytes, ooz);
  const wsd = level.properties.worldSaveData.value;
  const charMap = charMapOf(level);

  // ---- Remove throwaway character already on the new GUID (from a prior join)
  const before = charMap.length;
  const kept = charMap.filter((e) => String(e.key.PlayerUId.value) !== newF);
  if (kept.length !== before) {
    wsd.CharacterSaveParameterMap.value = kept;
    report.push(`[0-] throwaway character entries removed: ${before - kept.length}`);
  }
  const map = wsd.CharacterSaveParameterMap.value;

  // ---- Layer 0b: host character map key (matched by instance id)
  let hostKeyed = 0;
  for (const e of map) {
    if (String(e.key.InstanceId.value) === hostInstance) {
      e.key.PlayerUId.value = newF;
      hostKeyed++;
    }
  }
  report.push(`[0b] host character keys patched: ${hostKeyed}`);
  if (hostKeyed !== 1) throw new Error(`expected exactly 1 host character entry, got ${hostKeyed}`);

  // ---- Layers 1+2: pals re-keyed to zero GUID, owners retargeted
  let rekeyed = 0, ownerFixed = 0, oldOwnerFixed = 0, playersKept = 0, rawEntries = 0;
  const palInstances = [];
  for (const e of map) {
    const sp = saveParamOf(e);
    if (sp === null) { rawEntries++; continue; }
    if (sp.IsPlayer?.value) { playersKept++; continue; }
    palInstances.push(String(e.key.InstanceId.value));
    if (String(e.key.PlayerUId.value) !== ZERO_UUID) {
      e.key.PlayerUId.value = ZERO_UUID;
      rekeyed++;
    }
    const owner = sp.OwnerPlayerUId;
    if (owner && String(owner.value) === oldF) {
      owner.value = newF;
      ownerFixed++;
    }
    const vals = sp.OldOwnerPlayerUIds?.value?.values;
    if (Array.isArray(vals)) {
      for (let i = 0; i < vals.length; i++) {
        if (String(vals[i]) === oldF) { vals[i] = newF; oldOwnerFixed++; }
      }
    }
  }
  report.push(
    `[1+2] players kept: ${playersKept}, pals re-keyed to zero: ${rekeyed}, ` +
    `owners retargeted: ${ownerFixed}, old-owners retargeted: ${oldOwnerFixed}, ` +
    `undecoded entries: ${rawEntries}`
  );
  if (rawEntries > 0) throw new Error("some character entries failed to decode; aborting");

  // ---- Layer 3: guild blobs — zero the owner guid paired before each pal
  //      instance id, then move remaining old-guid refs (host handle, admin,
  //      member entry) to the new guid.
  let handlesZeroed = 0, hostRefs = 0;
  const zero16 = new Uint8Array(16);
  for (const grp of wsd.GroupSaveDataMap.value) {
    const v = grp.value;
    const raw = v.RawData.value;
    if (v.GroupType.value.value !== "EPalGroupType::Guild" || !("values" in raw)) continue;
    let b = raw.values instanceof Uint8Array ? new Uint8Array(raw.values) : Uint8Array.from(raw.values);
    for (const inst of palInstances) {
      const ib = UUID.fromString(inst).rawBytes;
      const idx = findBytes(b, ib);
      if (idx >= 16 && findBytes(b.subarray(idx - 16, idx), zero16) !== 0) {
        b.set(zero16, idx - 16);
        handlesZeroed++;
      }
    }
    const replaced = replaceBytes(b, oldB, newB);
    hostRefs += replaced.count;
    raw.values = replaced.bytes;
  }
  report.push(`[3] pal guild handles zeroed: ${handlesZeroed}, host guild refs updated: ${hostRefs}`);

  // ---- Layer 4: container slot player_uid old -> zero
  let slotsFixed = 0;
  for (const c of wsd.CharacterContainerSaveData.value) {
    const slots = c.value.Slots?.value?.values ?? [];
    for (const s of slots) {
      const rd = s.RawData?.value;
      if (rd && typeof rd === "object" && "player_uid" in rd && String(rd.player_uid) === oldF) {
        rd.player_uid = ZERO_UUID;
        slotsFixed++;
      }
    }
  }
  report.push(`[4] container slots zeroed: ${slotsFixed}`);

  const levelGvas = level.write(LEVEL_CUSTOM_PROPERTIES);
  const levelSav = await compressSav(levelGvas, lst);

  // ---- Verification pass on the freshly written bytes
  const { level: check } = await parseLevel(levelSav, ooz);
  const cwsd = check.properties.worldSaveData.value;
  const keyCounts = {};
  for (const e of cwsd.CharacterSaveParameterMap.value) {
    const k = String(e.key.PlayerUId.value);
    keyCounts[k] = (keyCounts[k] ?? 0) + 1;
  }
  report.push(`char map keys by uid: ${JSON.stringify(keyCounts)}`);
  if (keyCounts[oldF]) throw new Error("verification failed: old guid still keyed in char map");
  if (keyCounts[newF] !== 1) throw new Error("verification failed: host character not keyed to new guid");
  for (const grp of cwsd.GroupSaveDataMap.value) {
    const v = grp.value;
    const raw = v.RawData.value;
    if (v.GroupType.value.value === "EPalGroupType::Guild" && "values" in raw) {
      const b = raw.values instanceof Uint8Array ? raw.values : Uint8Array.from(raw.values);
      if (findBytes(b, oldB) !== -1) throw new Error("verification failed: old guid remains in a guild blob");
    }
  }
  for (const c of cwsd.CharacterContainerSaveData.value) {
    for (const s of c.value.Slots?.value?.values ?? []) {
      const rd = s.RawData?.value;
      if (rd && typeof rd === "object" && "player_uid" in rd && String(rd.player_uid) === oldF) {
        throw new Error("verification failed: old guid remains in a container slot");
      }
    }
  }
  const { player: pcheck } = await parsePlayer(playerSav, ooz);
  if (String(pcheck.properties.SaveData.value.PlayerUId.value) !== newF) {
    throw new Error("verification failed: player file not on new guid");
  }
  report.push("VERIFICATION PASSED");

  return { levelSav, playerSav, report };
}
