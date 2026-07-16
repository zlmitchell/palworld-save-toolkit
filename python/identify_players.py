import os
import struct
import sys

import ooz
from palworld_save_tools.gvas import GvasFile
from palworld_save_tools.palsav import decompress_sav_to_gvas
from palworld_save_tools.paltypes import PALWORLD_CUSTOM_PROPERTIES, PALWORLD_TYPE_HINTS


def decompress(data):
    # PlM = Oodle-compressed (2026 save format); PlZ = classic zlib
    if data[8:11] == b"PlM":
        ulen = struct.unpack_from("<I", data)[0]
        return ooz.decompress(data[12:], ulen), data[11]
    return decompress_sav_to_gvas(data)


def load_sav(path):
    with open(path, "rb") as f:
        raw, _ = decompress(f.read())
    return GvasFile.read(raw, PALWORLD_TYPE_HINTS, PALWORLD_CUSTOM_PROPERTIES, allow_nan=True).dump()


def main(world_dir):
    players = {}
    players_dir = os.path.join(world_dir, "Players")
    for name in sorted(os.listdir(players_dir)):
        if not name.endswith(".sav"):
            continue
        guid = name[:-4]
        data = load_sav(os.path.join(players_dir, name))
        sd = data["properties"]["SaveData"]["value"]
        players[guid] = {
            "player_uid": str(sd["PlayerUId"]["value"]),
            "instance_id": str(sd["IndividualId"]["value"]["InstanceId"]["value"]),
        }

    level = load_sav(os.path.join(world_dir, "Level.sav"))
    charmap = level["properties"]["worldSaveData"]["value"]["CharacterSaveParameterMap"]["value"]

    for entry in charmap:
        uid = str(entry["key"]["PlayerUId"]["value"])
        iid = str(entry["key"]["InstanceId"]["value"])
        for guid, info in players.items():
            if iid == info["instance_id"]:
                params = entry["value"]["RawData"]["value"]["object"]["SaveParameter"]["value"]
                info["nickname"] = params.get("NickName", {}).get("value")
                info["level"] = params.get("Level", {}).get("value")
                info["exp"] = params.get("Exp", {}).get("value")
                hp = params.get("Hp") or params.get("HP")
                info["hp"] = hp["value"]["Value"]["value"] if hp else None

    print(f"{'file GUID':34} {'nickname':16} {'lvl':>3}  {'steam id (if steam)':20} in Level.sav")
    for guid, info in players.items():
        steam = ""
        if guid.endswith("0" * 24) and guid != "0" * 31 + "1":
            steam = str(76561197960265728 + int(guid[:8], 16))
        found = "yes" if "nickname" in info else "NO MATCH"
        print(f"{guid:34} {str(info.get('nickname')):16} {str(info.get('level', '')):>3}  {steam:20} {found}")

    # Also list any player-flagged characters in Level.sav with no matching file
    print("\nPlayer characters found in Level.sav:")
    for entry in charmap:
        uid = str(entry["key"]["PlayerUId"]["value"])
        if uid.replace("-", "") == "0" * 32:
            continue  # pals have zero PlayerUId key? (players have non-zero)
        params = entry["value"]["RawData"]["value"]["object"]["SaveParameter"]["value"]
        if params.get("IsPlayer", {}).get("value"):
            iid = str(entry["key"]["InstanceId"]["value"])
            print(f"  uid={uid} instance={iid} name={params.get('NickName', {}).get('value')} lvl={params.get('Level', {}).get('value')}")


if __name__ == "__main__":
    main(sys.argv[1])
