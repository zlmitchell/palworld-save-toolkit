// Cross-world player import: merge a player (character, pals, party/palbox,
// inventory, guild membership) from a source world into the loaded world.
// Approach mirrors palworld-save-pal's transfer feature: character map entries
// and container map entries move as whole values; the destination guild gets
// the player appended with handles for their character and pals.

import { GvasFile, UUID, PALWORLD_TYPE_HINTS, ZERO_UUID } from "./gvas.js";
import { LEVEL_CUSTOM_PROPERTIES } from "./paldata.js";
import { groups } from "./palgroups.js";
import { decompressSav, compressSav } from "./sav.js";
import { parsePlayer } from "./migrate.js";

export const LEVEL_PROPS_FULL = {
  ...LEVEL_CUSTOM_PROPERTIES,
  ".worldSaveData.GroupSaveDataMap": groups,
};

async function parseLevelFull(levelBytes, ooz) {
  const { gvas, saveType } = await decompressSav(levelBytes, ooz);
  const level = GvasFile.read(gvas, PALWORLD_TYPE_HINTS, LEVEL_PROPS_FULL);
  return { level, saveType };
}

const wsdOf = (level) => level.properties.worldSaveData.value;
const charMapOf = (level) => wsdOf(level).CharacterSaveParameterMap.value;

function saveParamOf(entry) {
  const raw = entry.value.RawData.value;
  return raw && "object" in raw ? raw.object.SaveParameter.value : null;
}

/** Guilds in a world that decoded well enough to accept new members. */
export async function listGuilds(levelBytes, ooz) {
  const { level } = await parseLevelFull(levelBytes, ooz);
  const out = [];
  for (const grp of wsdOf(level).GroupSaveDataMap.value) {
    const v = grp.value;
    if (v.GroupType.value.value !== "EPalGroupType::Guild") continue;
    const raw = v.RawData.value;
    if ("values" in raw || !raw.guild) continue;
    out.push({
      id: String(raw.group_id),
      name: raw.guild.guild_name || raw.group_name || "(unnamed guild)",
      members: raw.guild.tail.players.map((p) => p.player_info.player_name),
    });
  }
  return out;
}

// Recursively collect the container IDs referenced by a player's SaveData
// (party, palbox, inventory, equipment, ...).
function collectContainerIds(node, out) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectContainerIds(item, out);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.endsWith("ContainerId") && value?.value?.ID?.value) {
      out.add(String(value.value.ID.value));
    }
    collectContainerIds(value, out);
  }
}

function containerKeyId(entry) {
  return String(entry.key?.ID?.value ?? "");
}

/**
 * Import one player from a source world into the target world.
 * @returns {Promise<{levelSav: Uint8Array, playerFile: Uint8Array, report: string[]}>}
 */
export async function importPlayer(
  { targetLevelBytes, sourceLevelBytes, sourcePlayerBytes, playerUid, destGuildId,
    replace = false, targetPlayerBytes = null, newUid = null },
  ooz
) {
  const report = [];
  const uidF = playerUid.toLowerCase();
  // Optional remap: import the player under a different GUID. This is how a
  // co-op host placeholder (...0001) gets fixed onto a real server GUID
  // during the merge.
  const finalUid = newUid
    ? `${newUid.toLowerCase().replace(/-/g, "").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5")}`
    : uidF;
  const remap = finalUid !== uidF;
  const OLD_HOST_UID = "00000000-0000-0000-0000-000000000001";
  if (uidF === OLD_HOST_UID && !remap) {
    throw new Error(
      "this is a co-op host placeholder (…0001) — a real GUID to import them as is required"
    );
  }

  // ---- source player file: gather instance + container ids
  const { player: srcPlayer, saveType: srcPlayerSaveType } = await parsePlayer(sourcePlayerBytes, ooz);
  const sd = srcPlayer.properties.SaveData.value;
  if (String(sd.PlayerUId.value) !== uidF) {
    throw new Error(`player file is for ${sd.PlayerUId.value}, expected ${uidF}`);
  }
  const hostInstance = String(sd.IndividualId.value.InstanceId.value);
  const containerIds = new Set();
  collectContainerIds(sd, containerIds);
  let playerFileBytes = sourcePlayerBytes;
  if (remap) {
    sd.PlayerUId.value = finalUid;
    sd.IndividualId.value.PlayerUId.value = finalUid;
    playerFileBytes = await compressSav(srcPlayer.write({}), srcPlayerSaveType);
    report.push(`host fix: importing ${uidF} as ${finalUid}`);
  }
  report.push(`source player instance ${hostInstance}, ${containerIds.size} container(s) referenced`);

  const { level: target, saveType } = await parseLevelFull(targetLevelBytes, ooz);
  const { level: source } = await parseLevelFull(sourceLevelBytes, ooz);
  const targetWsd = wsdOf(target);
  const sourceWsd = wsdOf(source);

  // ---- existing player: abort, or excise them entirely when replacing
  const exists = charMapOf(target).some((e) => String(e.key.PlayerUId.value) === finalUid);
  if (exists && !replace) {
    throw new Error(`target world already has a player with GUID ${finalUid}`);
  }
  if (exists) {
    const removedInstances = new Set();
    const keep = [];
    for (const e of charMapOf(target)) {
      const sp = saveParamOf(e);
      const isP = sp?.IsPlayer?.value === true;
      const theirs =
        (isP && String(e.key.PlayerUId.value) === finalUid) ||
        (!isP && sp?.OwnerPlayerUId && String(sp.OwnerPlayerUId.value) === finalUid);
      if (theirs) removedInstances.add(String(e.key.InstanceId.value));
      else keep.push(e);
    }
    targetWsd.CharacterSaveParameterMap.value = keep;

    let removedContainers = 0;
    if (targetPlayerBytes) {
      const { player: tp } = await parsePlayer(targetPlayerBytes, ooz);
      const oldIds = new Set();
      collectContainerIds(tp.properties.SaveData.value, oldIds);
      for (const key of ["CharacterContainerSaveData", "ItemContainerSaveData"]) {
        const before = targetWsd[key].value.length;
        targetWsd[key].value = targetWsd[key].value.filter((e) => !oldIds.has(containerKeyId(e)));
        removedContainers += before - targetWsd[key].value.length;
      }
    } else {
      report.push("note: no target player file provided — their old containers were left behind");
    }

    for (const grp of targetWsd.GroupSaveDataMap.value) {
      const raw = grp.value.RawData.value;
      if ("values" in raw) continue;
      raw.individual_character_handle_ids = raw.individual_character_handle_ids.filter(
        (h) => String(h.guid) !== finalUid && !removedInstances.has(String(h.instance_id))
      );
      if (raw.guild) {
        const t = raw.guild.tail;
        const had = t.players.length;
        t.players = t.players.filter((p) => String(p.player_uid) !== finalUid);
        // if they administered a *different* guild than the destination and
        // members remain, hand admin to the first remaining member
        if (had !== t.players.length && String(t.admin_player_uid) === finalUid &&
            t.players.length && String(raw.group_id) !== destGuildId) {
          t.admin_player_uid = String(t.players[0].player_uid);
        }
      }
    }
    report.push(`replaced: removed existing player + ${removedInstances.size - 1} pals, ${removedContainers} containers`);
  }

  const targetInstances = new Set(charMapOf(target).map((e) => String(e.key.InstanceId.value)));
  const targetContainers = new Set(
    [...targetWsd.CharacterContainerSaveData.value, ...targetWsd.ItemContainerSaveData.value].map(containerKeyId)
  );

  // ---- destination guild
  const destGuildEntry = targetWsd.GroupSaveDataMap.value.find(
    (g) => g.value.GroupType.value.value === "EPalGroupType::Guild" &&
           !("values" in g.value.RawData.value) &&
           String(g.value.RawData.value.group_id) === destGuildId
  );
  if (!destGuildEntry) throw new Error("destination guild not found or not decodable");
  const destGuild = destGuildEntry.value.RawData.value;
  const destGuildGuid = destGuild.group_id;

  // ---- move character map entries (player + owned pals)
  const moved = [];
  let playerEntry = null;
  for (const e of charMapOf(source)) {
    const sp = saveParamOf(e);
    if (!sp) continue;
    const isPlayer = sp.IsPlayer?.value === true;
    if (isPlayer && String(e.key.PlayerUId.value) === uidF) {
      playerEntry = e;
      moved.push(e);
    } else if (!isPlayer && sp.OwnerPlayerUId && String(sp.OwnerPlayerUId.value) === uidF) {
      moved.push(e);
    }
  }
  if (!playerEntry) throw new Error(`no character entry for ${uidF} in the source world`);
  const palEntries = moved.filter((e) => e !== playerEntry);

  // Instance ids can genuinely collide between related worlds (pals moved via
  // the game's dimensional storage keep their ids). Colliding pals get a fresh
  // instance id, remapped everywhere; a colliding player character is a real
  // duplicate and aborts.
  const instanceRemap = new Map();
  const newUuid = () => {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[7] = (b[7] & 0x0f) | 0x40;
    b[9] = (b[9] & 0x3f) | 0x80;
    return String(new UUID(b));
  };
  for (const e of moved) {
    const inst = String(e.key.InstanceId.value);
    if (targetInstances.has(inst)) {
      if (e === playerEntry) throw new Error(`this character (instance ${inst}) already exists in the target world`);
      const fresh = newUuid();
      instanceRemap.set(inst, fresh);
      e.key.InstanceId.value = fresh;
    }
    // pals must be keyed to the zero GUID on dedicated servers; the player
    // entry is keyed to their (possibly remapped) uid
    if (e !== playerEntry) {
      e.key.PlayerUId.value = ZERO_UUID;
      if (remap) {
        const sp = saveParamOf(e);
        if (sp?.OwnerPlayerUId && String(sp.OwnerPlayerUId.value) === uidF) sp.OwnerPlayerUId.value = finalUid;
        const olds = sp?.OldOwnerPlayerUIds?.value?.values;
        if (Array.isArray(olds)) {
          for (let i = 0; i < olds.length; i++) if (String(olds[i]) === uidF) olds[i] = finalUid;
        }
      }
    } else {
      e.key.PlayerUId.value = finalUid;
    }
    // characters carry their guild id inside the decoded blob
    const raw = e.value.RawData.value;
    if (raw && "group_id" in raw) raw.group_id = destGuildGuid;
    charMapOf(target).push(e);
  }
  report.push(
    `moved character entries: 1 player + ${palEntries.length} pals` +
    (instanceRemap.size ? ` (${instanceRemap.size} re-instanced to avoid collisions)` : "")
  );

  // ---- move container entries (party, palbox, inventory, equipment)
  let movedChar = 0, movedItem = 0;
  for (const e of sourceWsd.CharacterContainerSaveData.value) {
    if (containerIds.has(containerKeyId(e))) {
      if (targetContainers.has(containerKeyId(e))) throw new Error(`container collision: ${containerKeyId(e)}`);
      // apply pal instance remaps to slot references
      for (const s of e.value.Slots?.value?.values ?? []) {
        const rd = s.RawData?.value;
        if (rd && typeof rd === "object" && "instance_id" in rd) {
          const mapped = instanceRemap.get(String(rd.instance_id));
          if (mapped) rd.instance_id = mapped;
          // placeholder owner refs get pals purged on dedicated servers
          if (remap && String(rd.player_uid) === uidF) rd.player_uid = ZERO_UUID;
        }
      }
      targetWsd.CharacterContainerSaveData.value.push(e);
      movedChar++;
    }
  }
  for (const e of sourceWsd.ItemContainerSaveData.value) {
    if (containerIds.has(containerKeyId(e))) {
      if (targetContainers.has(containerKeyId(e))) throw new Error(`container collision: ${containerKeyId(e)}`);
      targetWsd.ItemContainerSaveData.value.push(e);
      movedItem++;
    }
  }
  report.push(`moved containers: ${movedChar} character (party/palbox), ${movedItem} item (inventory/equipment)`);

  // ---- guild registration
  const sp = saveParamOf(playerEntry);
  const nickname = sp?.NickName?.value ?? "imported player";
  // membership row: reuse the source guild's row for this player when available
  let memberRow = null;
  for (const grp of sourceWsd.GroupSaveDataMap.value) {
    const raw = grp.value.RawData.value;
    if (raw?.guild) {
      const row = raw.guild.tail.players.find((p) => String(p.player_uid) === uidF || String(p.player_uid) === finalUid);
      if (row) { memberRow = row; break; }
    }
  }
  const guild = destGuild.guild;
  const newRow = {
    player_uid: finalUid,
    player_info: {
      last_online_real_time: memberRow?.player_info.last_online_real_time ?? 0n,
      player_name: memberRow?.player_info.player_name ?? nickname,
    },
  };
  if (guild.tail.kind === "post") newRow.role = memberRow?.role ?? 0;
  guild.tail.players.push(newRow);
  destGuild.individual_character_handle_ids.push({ guid: finalUid, instance_id: hostInstance });
  for (const e of palEntries) {
    destGuild.individual_character_handle_ids.push({
      guid: ZERO_UUID,
      instance_id: String(e.key.InstanceId.value),
    });
  }
  report.push(`guild "${guild.guild_name}": added ${newRow.player_info.player_name} + ${palEntries.length} pal handles`);

  const levelSav = await compressSav(target.write(LEVEL_PROPS_FULL), saveType);

  // ---- verification
  const { level: check } = await parseLevelFull(levelSav, ooz);
  const cMap = charMapOf(check);
  if (!cMap.some((e) => String(e.key.PlayerUId.value) === finalUid)) {
    throw new Error("verification failed: imported player not in character map");
  }
  const cGuild = wsdOf(check).GroupSaveDataMap.value.find(
    (g) => !("values" in g.value.RawData.value) && String(g.value.RawData.value.group_id) === destGuildId
  );
  if (!cGuild || !cGuild.value.RawData.value.guild.tail.players.some((p) => String(p.player_uid) === finalUid)) {
    throw new Error("verification failed: player not in destination guild");
  }
  const cContainers = new Set(
    [...wsdOf(check).CharacterContainerSaveData.value, ...wsdOf(check).ItemContainerSaveData.value].map(containerKeyId)
  );
  for (const id of containerIds) {
    if (!cContainers.has(id)) throw new Error(`verification failed: container ${id} missing`);
  }
  report.push("VERIFICATION PASSED");

  return { levelSav, playerFile: playerFileBytes, finalUid, report };
}
