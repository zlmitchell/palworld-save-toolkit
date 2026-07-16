// Palworld 1.0 GroupSaveDataMap parser (guilds, organizations).
// Ported from oMaN-Rod/uesave-rs branch palworld-v1 (games/palworld/groups.rs),
// the layout used by palworld-save-pal in production. Unknown group types and
// undecodable blobs are preserved as raw bytes; encoders skip re-encoding
// anything still raw, so round-trips stay lossless.

import { FWriter } from "./gvas.js";

const GUILD = "EPalGroupType::Guild";
const INDEPENDENT = "EPalGroupType::IndependentGuild";
const ORGANIZATION = "EPalGroupType::Organization";

// ---- blob readers -----------------------------------------------------

function readPlayerInfoDetails(r) {
  return { last_online_real_time: r.i64(), player_name: r.fstring() };
}

function readPlayerInfo(r) {
  return { player_uid: r.guid(), player_info: readPlayerInfoDetails(r) };
}

function readGuildMarker(r) {
  return {
    marker_id: r.guid(),
    icon_location: { x: r.f64(), y: r.f64(), z: r.f64() },
    icon_type: r.i32(),
    owner_player_uid: r.guid(),
  };
}

function readRolePermission(r) {
  const role = r.byte();
  const n = r.u32();
  return { role, permissions: [...r.byteList(n)] };
}

function readTailPostUpdate(r) {
  const chestRoleCount = r.u32();
  if (chestRoleCount > 64) throw new Error("implausible chest role count");
  const guild_chest_allowed_roles = [...r.byteList(chestRoleCount)];
  const unknown_i32 = r.i32();
  const admin_player_uid = r.guid();
  const playerCount = r.u32();
  if (playerCount > 10000) throw new Error("implausible player count");
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    const p = readPlayerInfo(r);
    p.role = r.byte();
    players.push(p);
  }
  const permCount = r.u32();
  if (permCount > 64) throw new Error("implausible permission count");
  const role_permissions = [];
  for (let i = 0; i < permCount; i++) role_permissions.push(readRolePermission(r));
  const trailing_bytes = [...r.read(4)];
  return { kind: "post", guild_chest_allowed_roles, unknown_i32, admin_player_uid, players, role_permissions, trailing_bytes };
}

function readTailPreUpdate(r) {
  const admin_player_uid = r.guid();
  const playerCount = r.u32();
  if (playerCount > 10000) throw new Error("implausible player count");
  const players = [];
  for (let i = 0; i < playerCount; i++) players.push(readPlayerInfo(r));
  const trailing_bytes = [...r.read(4)];
  return { kind: "pre", admin_player_uid, players, trailing_bytes };
}

function readGuildGroup(r) {
  const g = {
    org_type: r.byte(),
    leading_bytes: [...r.read(4)],
    base_ids: [],
    unknown_1: 0,
    base_camp_level: 0,
    map_object_instance_ids_base_camp_points: [],
    guild_name: "",
    last_guild_name_modifier_player_uid: null,
    guild_markers: [],
    tail: null,
  };
  const baseCount = r.u32();
  for (let i = 0; i < baseCount; i++) g.base_ids.push(r.guid());
  g.unknown_1 = r.i32();
  g.base_camp_level = r.i32();
  const pointCount = r.u32();
  for (let i = 0; i < pointCount; i++) g.map_object_instance_ids_base_camp_points.push(r.guid());
  g.guild_name = r.fstring();
  g.last_guild_name_modifier_player_uid = r.guid();
  const markerCount = r.u32();
  for (let i = 0; i < markerCount; i++) g.guild_markers.push(readGuildMarker(r));
  // Tail: try PostUpdate (must consume exactly to EOF); fall back to PreUpdate.
  const tailStart = r.pos;
  try {
    const tail = readTailPostUpdate(r);
    if (r.eof()) { g.tail = tail; return g; }
  } catch { /* fall through */ }
  r.pos = tailStart;
  g.tail = readTailPreUpdate(r);
  return g;
}

function readIndependentGuild(r) {
  return {
    org_type: r.byte(),
    base_camp_level: r.i32(),
    map_object_instance_ids_base_camp_points: Array.from({ length: r.u32() }, () => r.guid()),
    guild_name: r.fstring(),
    player_uid: r.guid(),
    guild_name_2: r.fstring(),
    player_info: readPlayerInfoDetails(r),
  };
}

function readOrganization(r) {
  return { org_type: r.byte(), trailing_bytes: [...r.read(12)] };
}

export function decodeGroupBytes(parentReader, bytes, groupType) {
  const r = parentReader.internalCopy(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
  const data = {
    group_type: groupType,
    group_id: r.guid(),
    group_name: r.fstring(),
    individual_character_handle_ids: [],
  };
  const handleCount = r.u32();
  for (let i = 0; i < handleCount; i++) {
    data.individual_character_handle_ids.push({ guid: r.guid(), instance_id: r.guid() });
  }
  if (groupType === GUILD) data.guild = readGuildGroup(r);
  else if (groupType === INDEPENDENT) data.independent = readIndependentGuild(r);
  else if (groupType === ORGANIZATION) data.organization = readOrganization(r);
  else data.remaining_data = [...r.readToEnd()];
  if (!r.eof()) throw new Error(`group blob has ${r.size - r.pos} unparsed bytes`);
  return data;
}

// ---- blob writers -----------------------------------------------------

function writePlayerInfo(w, p) {
  w.guid(p.player_uid);
  w.i64(p.player_info.last_online_real_time);
  w.fstring(p.player_info.player_name);
}

function writeGuildGroup(w, g) {
  w.byte(g.org_type);
  w.write(Uint8Array.from(g.leading_bytes));
  w.u32(g.base_ids.length);
  for (const id of g.base_ids) w.guid(id);
  w.i32(g.unknown_1);
  w.i32(g.base_camp_level);
  w.u32(g.map_object_instance_ids_base_camp_points.length);
  for (const id of g.map_object_instance_ids_base_camp_points) w.guid(id);
  w.fstring(g.guild_name);
  w.guid(g.last_guild_name_modifier_player_uid);
  w.u32(g.guild_markers.length);
  for (const m of g.guild_markers) {
    w.guid(m.marker_id);
    w.f64(m.icon_location.x); w.f64(m.icon_location.y); w.f64(m.icon_location.z);
    w.i32(m.icon_type);
    w.guid(m.owner_player_uid);
  }
  const t = g.tail;
  if (t.kind === "post") {
    w.u32(t.guild_chest_allowed_roles.length);
    w.write(Uint8Array.from(t.guild_chest_allowed_roles));
    w.i32(t.unknown_i32);
    w.guid(t.admin_player_uid);
    w.u32(t.players.length);
    for (const p of t.players) { writePlayerInfo(w, p); w.byte(p.role); }
    w.u32(t.role_permissions.length);
    for (const rp of t.role_permissions) {
      w.byte(rp.role);
      w.u32(rp.permissions.length);
      w.write(Uint8Array.from(rp.permissions));
    }
    w.write(Uint8Array.from(t.trailing_bytes));
  } else {
    w.guid(t.admin_player_uid);
    w.u32(t.players.length);
    for (const p of t.players) writePlayerInfo(w, p);
    w.write(Uint8Array.from(t.trailing_bytes));
  }
}

export function encodeGroupBytes(data) {
  const w = new FWriter();
  w.guid(data.group_id);
  w.fstring(data.group_name);
  w.u32(data.individual_character_handle_ids.length);
  for (const h of data.individual_character_handle_ids) {
    w.guid(h.guid);
    w.guid(h.instance_id);
  }
  if (data.guild) writeGuildGroup(w, data.guild);
  else if (data.independent) {
    const g = data.independent;
    w.byte(g.org_type);
    w.i32(g.base_camp_level);
    w.u32(g.map_object_instance_ids_base_camp_points.length);
    for (const id of g.map_object_instance_ids_base_camp_points) w.guid(id);
    w.fstring(g.guild_name);
    w.guid(g.player_uid);
    w.fstring(g.guild_name_2);
    w.i64(g.player_info.last_online_real_time);
    w.fstring(g.player_info.player_name);
  } else if (data.organization) {
    w.byte(data.organization.org_type);
    w.write(Uint8Array.from(data.organization.trailing_bytes));
  } else {
    w.write(Uint8Array.from(data.remaining_data ?? []));
  }
  return w.bytes();
}

// ---- MapProperty-level custom property (same shape as paldata.js) -----

export const groups = {
  decode(reader, typeName, size, path) {
    if (typeName !== "MapProperty") throw new Error(`Expected MapProperty, got ${typeName}`);
    const value = reader.property(typeName, size, path, path);
    for (const group of value.value) {
      const groupType = group.value.GroupType.value.value;
      const raw = group.value.RawData.value;
      try {
        group.value.RawData.value = decodeGroupBytes(reader, raw.values, groupType);
      } catch (e) {
        reader.warnings.push(`failed to decode group ${groupType}, keeping raw bytes: ${e.message}`);
      }
    }
    return value;
  },
  encode(writer, propertyType, property) {
    if (propertyType !== "MapProperty") throw new Error(`Expected MapProperty, got ${propertyType}`);
    delete property.custom_type;
    for (const group of property.value) {
      const raw = group.value.RawData.value;
      if ("values" in raw) continue; // still raw — write back verbatim
      group.value.RawData.value = { values: encodeGroupBytes(raw) };
    }
    return writer.propertyInner(propertyType, property);
  },
};
