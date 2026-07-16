"""Full co-op -> dedicated server migration for Palworld 1.0 (PlM/Oodle) saves.

Implements the 4-layer procedure documented by quadrantbs/palworld-hostfix-toolkit
(all logic reviewed), using only the two parsers verified to round-trip our
Level.sav byte-identically; guild blobs are patched with targeted byte surgery.

Run with PYTHONPATH=<...>/tools/vendor so the patched parsers are used.

Usage: python migrate_coop_to_dedicated.py <world_dir> <old_guid32> <new_guid32>
"""

import os
import shutil
import sys

from palworld_save_tools.archive import UUID
from palworld_save_tools.gvas import GvasFile
from palworld_save_tools.palsav import compress_gvas_to_sav, decompress_sav_to_gvas
from palworld_save_tools.paltypes import PALWORLD_CUSTOM_PROPERTIES, PALWORLD_TYPE_HINTS

ZERO = "00000000-0000-0000-0000-000000000000"
NEEDED = {
    ".worldSaveData.CharacterSaveParameterMap.Value.RawData",
    ".worldSaveData.CharacterContainerSaveData.Value.Slots.Slots.RawData",
}
LEVEL_PROPS = {k: v for k, v in PALWORLD_CUSTOM_PROPERTIES.items() if k in NEEDED}


def fmt(guid32):
    g = guid32.lower().replace("-", "")
    return f"{g[:8]}-{g[8:12]}-{g[12:16]}-{g[16:20]}-{g[20:]}"


def load(path, props):
    with open(path, "rb") as f:
        raw, save_type = decompress_sav_to_gvas(f.read())
    return GvasFile.read(raw, PALWORLD_TYPE_HINTS, props, allow_nan=True), raw, save_type


def write(gvas, path, props, save_type):
    with open(path, "wb") as f:
        f.write(compress_gvas_to_sav(gvas.write(props), save_type))


def main(world_dir, old_guid, new_guid):
    old_f, new_f = fmt(old_guid), fmt(new_guid)
    old_b = UUID.from_str(old_f).raw_bytes
    new_b = UUID.from_str(new_f).raw_bytes
    level_path = os.path.join(world_dir, "Level.sav")
    old_sav = os.path.join(world_dir, "Players", old_guid.upper() + ".sav")
    new_sav = os.path.join(world_dir, "Players", new_guid.upper() + ".sav")

    shutil.copy2(level_path, level_path + ".bak")
    shutil.copy2(old_sav, old_sav + ".bak")

    # ---- Layer 0a: player file
    player, praw, pst = load(old_sav, PALWORLD_CUSTOM_PROPERTIES)
    sd = player.properties["SaveData"]["value"]
    sd["PlayerUId"]["value"] = new_f
    sd["IndividualId"]["value"]["PlayerUId"]["value"] = new_f
    host_instance = str(sd["IndividualId"]["value"]["InstanceId"]["value"])
    write(player, new_sav, PALWORLD_CUSTOM_PROPERTIES, pst)
    os.remove(old_sav)
    print(f"[0a] player file -> {os.path.basename(new_sav)} (host instance {host_instance})")

    level, lraw, lst = load(level_path, LEVEL_PROPS)
    wsd = level.properties["worldSaveData"]["value"]
    char_map = wsd["CharacterSaveParameterMap"]["value"]

    # If the host already joined the server, a throwaway character exists under
    # the new GUID. Its player file was just overwritten above; drop its
    # character entry too so the real character is the only one on that GUID.
    throwaway = [e for e in char_map if str(e["key"]["PlayerUId"]["value"]) == new_f]
    if throwaway:
        char_map[:] = [e for e in char_map if str(e["key"]["PlayerUId"]["value"]) != new_f]
        print(f"[0-] throwaway character entries removed: {len(throwaway)}")

    # ---- Layer 0b: host character map key (matched by instance id)
    host_keyed = 0
    for e in char_map:
        if str(e["key"]["InstanceId"]["value"]) == host_instance:
            e["key"]["PlayerUId"]["value"] = new_f
            host_keyed += 1
    print(f"[0b] host character keys patched: {host_keyed}")
    assert host_keyed == 1, f"expected exactly 1 host character entry, got {host_keyed}"

    # ---- Layers 1+2: pals re-keyed to zero, owners retargeted
    rekeyed = owner_fixed = old_owner_fixed = players_kept = raw_entries = 0
    pal_instances = []
    for e in char_map:
        raw = e["value"]["RawData"]["value"]
        if not isinstance(raw, dict) or "object" not in raw:
            raw_entries += 1
            continue
        sp = raw["object"].get("SaveParameter", {}).get("value", {})
        if sp.get("IsPlayer", {}).get("value", False):
            players_kept += 1
            continue
        pal_instances.append(str(e["key"]["InstanceId"]["value"]))
        if str(e["key"]["PlayerUId"]["value"]) != ZERO:
            e["key"]["PlayerUId"]["value"] = ZERO
            rekeyed += 1
        owner = sp.get("OwnerPlayerUId", {})
        if str(owner.get("value", "")) == old_f:
            owner["value"] = new_f
            owner_fixed += 1
        vals = sp.get("OldOwnerPlayerUIds", {}).get("value", {}).get("values")
        if isinstance(vals, list):
            for i, v in enumerate(vals):
                if str(v) == old_f:
                    vals[i] = new_f
                    old_owner_fixed += 1
    print(f"[1+2] players kept: {players_kept}, pals re-keyed to zero: {rekeyed}, "
          f"owners retargeted: {owner_fixed}, old-owners retargeted: {old_owner_fixed}, "
          f"undecoded entries: {raw_entries}")
    assert raw_entries == 0, "some character entries failed to decode; aborting"

    # ---- Layer 3: guild blobs — zero the owner guid paired before each pal instance id
    handles_zeroed = host_refs = 0
    for grp in wsd["GroupSaveDataMap"]["value"]:
        v = grp["value"]
        raw = v["RawData"]["value"]
        if v["GroupType"]["value"]["value"] != "EPalGroupType::Guild" or "values" not in raw:
            continue
        b = bytearray(bytes(raw["values"]))
        for inst in pal_instances:
            ib = UUID.from_str(inst).raw_bytes
            idx = bytes(b).find(ib)
            if idx >= 16 and bytes(b[idx - 16:idx]) != b"\x00" * 16:
                b[idx - 16:idx] = b"\x00" * 16
                handles_zeroed += 1
        # ---- Layer 3.5: remaining old-guid refs (host handle, admin, member entry)
        host_refs += bytes(b).count(old_b)
        b = bytearray(bytes(b).replace(old_b, new_b))
        raw["values"] = list(bytes(b))
    print(f"[3] pal guild handles zeroed: {handles_zeroed}, host guild refs updated: {host_refs}")

    # ---- Layer 4: container slot player_uid old -> zero
    slots_fixed = 0
    for c in wsd["CharacterContainerSaveData"]["value"]:
        for s in c["value"].get("Slots", {}).get("value", {}).get("values", []):
            rd = s.get("RawData", {}).get("value", {})
            if isinstance(rd, dict) and str(rd.get("player_uid", "")) == old_f:
                rd["player_uid"] = ZERO
                slots_fixed += 1
    print(f"[4] container slots zeroed: {slots_fixed}")

    write(level, level_path, LEVEL_PROPS, lst)
    print("Level.sav written.")

    # ---- Verification
    check, _, _ = load(level_path, LEVEL_PROPS)
    wsd = check.properties["worldSaveData"]["value"]
    from collections import Counter
    keys = Counter(str(e["key"]["PlayerUId"]["value"]) for e in wsd["CharacterSaveParameterMap"]["value"])
    print("char map keys by uid:", dict(keys))
    assert keys.get(old_f, 0) == 0, "old guid still keyed in char map"
    assert keys.get(new_f, 0) == 1, "host character not keyed to new guid"
    # Only Guild groups are validated: the tested procedure leaves Organization
    # groups untouched (their old-guid refs are dangling handles to characters
    # that no longer exist in the character map — inert).
    for grp in wsd["GroupSaveDataMap"]["value"]:
        v = grp["value"]
        raw = v["RawData"]["value"]
        if v["GroupType"]["value"]["value"] == "EPalGroupType::Guild" and "values" in raw:
            assert old_b not in bytes(raw["values"]), "old guid bytes remain in a guild blob"
    for c in wsd["CharacterContainerSaveData"]["value"]:
        for s in c["value"].get("Slots", {}).get("value", {}).get("values", []):
            rd = s.get("RawData", {}).get("value", {})
            if isinstance(rd, dict):
                assert str(rd.get("player_uid", "")) != old_f, "old guid remains in a container slot"
    pcheck, _, _ = load(new_sav, PALWORLD_CUSTOM_PROPERTIES)
    assert str(pcheck.properties["SaveData"]["value"]["PlayerUId"]["value"]) == new_f
    print("VERIFICATION PASSED")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
