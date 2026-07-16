// Add / duplicate pals: clone-and-respec. A new pal is never built from
// scratch — an existing entry is deep-cloned (every field arrives valid),
// then species/level/variant are adjusted, a free palbox slot is claimed,
// and the guild gets a handle. Cloning a different species clears the
// learned-move lists so the game re-derives them.

import { GvasFile, UUID, PALWORLD_TYPE_HINTS, ZERO_UUID } from "./gvas.js";
import { LEVEL_PROPS_FULL } from "./transfer.js";
import { decompressSav, compressSav } from "./sav.js";
import { parsePlayer } from "./migrate.js";
import { PALDEX } from "./paldex.js";

const wsdOf = (level) => level.properties.worldSaveData.value;
const charMapOf = (level) => wsdOf(level).CharacterSaveParameterMap.value;

function saveParamOf(entry) {
  const raw = entry.value.RawData.value;
  return raw && "object" in raw ? raw.object.SaveParameter.value : null;
}

function newUuid() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[7] = (b[7] & 0x0f) | 0x40;
  b[9] = (b[9] & 0x3f) | 0x80;
  return String(new UUID(b));
}

// Deep copy that preserves UUID / BigInt / Uint8Array nodes.
function cloneTree(node) {
  if (node === null || typeof node !== "object") return node;
  if (node instanceof UUID) return new UUID(node.rawBytes.slice());
  if (node instanceof Uint8Array) return node.slice();
  if (Array.isArray(node)) return node.map(cloneTree);
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = cloneTree(v);
  return out;
}

const randTalent = () => {
  const b = new Uint8Array(1);
  crypto.getRandomValues(b);
  return b[0] % 101;
};

/**
 * Add a pal to a player's palbox (or duplicate an existing one).
 * @param {Uint8Array} levelBytes
 * @param {Uint8Array} ownerPlayerBytes - the owner's Players/<guid>.sav
 * @param {object} opts
 *   ownerUid: formatted uid of the receiving player
 *   species?: lowercase paldex key (released deck species only) — omit when duplicating
 *   duplicateInstanceId?: instance id of the pal to clone verbatim
 *   level?: number, variant?: 'normal'|'lucky'|'alpha', gender?: 'Male'|'Female'
 * @returns {Promise<{levelSav: Uint8Array, report: string[]}>}
 */
export async function addPal(levelBytes, ownerPlayerBytes, opts, ooz) {
  const report = [];
  const { ownerUid } = opts;
  const { gvas, saveType } = await decompressSav(levelBytes, ooz);
  const level = GvasFile.read(gvas, PALWORLD_TYPE_HINTS, LEVEL_PROPS_FULL);
  const map = charMapOf(level);

  // ---- pick the template entry
  let template = null;
  let sameSpecies = false;
  if (opts.duplicateInstanceId) {
    template = map.find((e) => String(e.key.InstanceId.value) === opts.duplicateInstanceId);
    if (!template) throw new Error("pal to duplicate not found");
    sameSpecies = true;
  } else {
    const dex = PALDEX[opts.species];
    if (!dex || !dex.no) throw new Error("species must be a released Paldeck entry");
    const wanted = dex.code.toLowerCase();
    for (const e of map) {
      const sp = saveParamOf(e);
      if (!sp || sp.IsPlayer?.value) continue;
      const cid = String(sp.CharacterID?.value ?? "").toLowerCase().replace(/^boss_/, "");
      if (cid === wanted) { template = e; sameSpecies = true; break; }
      if (!template) template = e; // fallback: any pal
    }
    if (!template) throw new Error("no pal in this world to clone from");
  }

  const entry = cloneTree(template);
  const instanceId = newUuid();
  entry.key.InstanceId.value = instanceId;
  entry.key.PlayerUId.value = ZERO_UUID;
  const sp = saveParamOf(entry);
  if (!sp) throw new Error("template pal did not decode");

  if (!opts.duplicateInstanceId) {
    const dex = PALDEX[opts.species];
    const boss = opts.variant === "alpha";
    sp.CharacterID.value = (boss ? "BOSS_" : "") + dex.code;
    if (sp.IsRarePal) sp.IsRarePal.value = opts.variant === "lucky";
    else if (opts.variant === "lucky") sp.IsRarePal = { value: true, id: null, type: "BoolProperty" };
    if (opts.level !== undefined && sp.Level) sp.Level.value.value = Math.max(1, Math.min(65, opts.level));
    if (sp.Exp) sp.Exp.value = 0n;
    delete sp.NickName;
    if (opts.gender && sp.Gender) sp.Gender.value.value = `EPalGenderType::${opts.gender}`;
    for (const t of ["Talent_HP", "Talent_Melee", "Talent_Shot", "Talent_Defense"]) {
      if (sp[t]) sp[t].value.value = randTalent();
      else sp[t] = { id: null, value: { type: "None", value: randTalent() }, type: "ByteProperty" };
    }
    if (!sameSpecies) {
      // wrong-species move lists would be nonsense; the game re-derives them
      for (const k of ["EquipWaza", "MasteredWaza"]) {
        if (sp[k]?.value) sp[k].value.values = [];
      }
      report.push("cloned from a different species — move lists cleared for the game to refill");
    }
  }

  // ---- ownership
  const ownerF = ownerUid.toLowerCase();
  if (sp.OwnerPlayerUId) sp.OwnerPlayerUId.value = ownerF;
  const olds = sp.OldOwnerPlayerUIds?.value;
  if (olds) olds.values = [ownerF];

  // ---- palbox slot
  const { player } = await parsePlayer(ownerPlayerBytes, ooz);
  const sd = player.properties.SaveData.value;
  if (String(sd.PlayerUId.value) !== ownerF) {
    throw new Error(`player file is for ${sd.PlayerUId.value}, expected ${ownerF}`);
  }
  const boxId = String(sd.PalStorageContainerId.value.ID.value);
  const container = wsdOf(level).CharacterContainerSaveData.value.find(
    (c) => String(c.key?.ID?.value ?? "") === boxId
  );
  if (!container) throw new Error("owner's palbox container not found in this world");
  // The Slots array stores only occupied slots (each with its own SlotIndex);
  // capacity is SlotNum. A free slot is an unused index, and filling it means
  // appending a new slot entry cloned from an existing one's shape.
  const slots = container.value.Slots?.value?.values ?? [];
  const capacity = container.value.SlotNum?.value ?? slots.length;
  const used = new Set(slots.map((s) => s.SlotIndex?.value));
  let slotIndex = -1;
  for (let i = 0; i < capacity; i++) {
    if (!used.has(i)) { slotIndex = i; break; }
  }
  if (slotIndex === -1) throw new Error(`owner's palbox is full (${slots.length}/${capacity})`);
  const templateSlot = slots.find((s) => {
    const rd = s.RawData?.value;
    return rd && typeof rd === "object" && "instance_id" in rd;
  });
  if (!templateSlot) throw new Error("no existing palbox slot to model the new one on");
  const newSlot = cloneTree(templateSlot);
  newSlot.SlotIndex.value = slotIndex;
  newSlot.RawData.value.player_uid = ZERO_UUID;
  newSlot.RawData.value.instance_id = instanceId;
  slots.push(newSlot);
  if (sp.SlotId?.value) {
    sp.SlotId.value.ContainerId.value.ID.value = boxId;
    sp.SlotId.value.SlotIndex.value = slotIndex;
  }

  // ---- guild handle + group id
  const raw = entry.value.RawData.value;
  const ownerEntry = map.find(
    (e) => saveParamOf(e)?.IsPlayer?.value && String(e.key.PlayerUId.value) === ownerF
  );
  const groupId = ownerEntry ? String(ownerEntry.value.RawData.value.group_id) : null;
  if (groupId) {
    if ("group_id" in raw) raw.group_id = groupId;
    for (const grp of wsdOf(level).GroupSaveDataMap.value) {
      const g = grp.value.RawData.value;
      if (!("values" in g) && String(g.group_id) === groupId) {
        g.individual_character_handle_ids.push({ guid: ZERO_UUID, instance_id: instanceId });
        break;
      }
    }
  }

  map.push(entry);
  const spName = String(sp.CharacterID?.value ?? "?");
  report.push(`added ${spName} lvl ${sp.Level?.value?.value ?? "?"} to palbox slot ${slotIndex} (instance ${instanceId})`);

  const levelSav = await compressSav(level.write(LEVEL_PROPS_FULL), saveType);

  // ---- verification
  const { gvas: cg } = await decompressSav(levelSav, ooz);
  const check = GvasFile.read(cg, PALWORLD_TYPE_HINTS, LEVEL_PROPS_FULL);
  if (!charMapOf(check).some((e) => String(e.key.InstanceId.value) === instanceId)) {
    throw new Error("verification failed: new pal not present after rewrite");
  }
  report.push("VERIFICATION PASSED");
  return { levelSav, report };
}
