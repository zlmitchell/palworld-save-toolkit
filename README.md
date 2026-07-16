# Palworld Save Toolkit

A browser-based workshop for Palworld saves. Works with post-1.0 saves
(Oodle-compressed `PlM` format, 2026 "Tides of Terraria" update and later).

**[▶ Use it in your browser](https://zlmitchell.github.io/palworld-save-toolkit/)** —
everything runs client-side. Your save files never leave your computer.

- **Convert** a local co-op world into a dedicated-server world — host
  character, pals, guild membership and all (the 4-layer fix below).
- **Inspect** worlds: players with stats/platform/tech, every pal with real
  species names, Paldeck numbers, icons, element types, IVs, and passive
  skills rendered with the game's tier colors.
- **Edit** (behind a "this can take the fun out of the game" gate): player
  levels and stat/tech points; pal levels, IVs, rank stars, souls,
  Normal/Lucky/Boss variant, and passives via a searchable picker; max
  buttons per player or world-wide.
- **Add pals**: clone-and-respec any released Paldeck species into a player's
  palbox, or duplicate an existing pal.
- **Import players between worlds**: character, pals, party/palbox, full
  inventory and guild membership move together; existing players can be
  replaced; co-op hosts are fixed onto their real GUID during the merge.

## Why this exists

Copying a co-op world onto a dedicated server *almost* works: guests keep their
characters, but the **host's character is lost** (co-op stores the host under a
placeholder GUID the server doesn't recognize), and after the classic
rename-style fix the server **silently deletes every pal** on load. Palworld
1.0 changed both the save compression (zlib → Oodle) and several binary
structures, breaking the older community tools.

This toolkit implements the full 4-layer fix:

| Layer | What it fixes | Without it |
|---|---|---|
| 0 | Host character file + world entry re-keyed to the server GUID | Host spawns as a fresh character |
| 1+2 | Pals re-keyed to the zero GUID; ownership fields retargeted | **Server purges all pals on load** |
| 3 | Guild membership handles corrected | Guild dissolves, pals purged |
| 4 | Stale per-slot owner refs cleared in party/palbox containers | Pals garbage-collected from boxes |

The output is verified by re-parsing before you get it, and files are written
in the zlib (`PlZ`) format, which the game and server still accept.

## The procedure

1. Copy your co-op world folder from
   `%LOCALAPPDATA%\Pal\Saved\SaveGames\<steam-id>\<world-id>` somewhere safe
   (always keep a backup!).
2. Upload it to the server once (or start the server with a fresh world), then
   have the **host join once** and create a character. The new file that
   appears in the server's `Pal/Saved/SaveGames/0/<world>/Players/` folder is
   the host's real GUID. **Player GUIDs cannot be computed from Steam IDs since
   Palworld 1.0** — the join-once step is required.
3. Open the [web app](https://zlmitchell.github.io/palworld-save-toolkit/),
   select your co-op world folder, then select the server's world folder to
   **auto-detect the host's new GUID** (it's the player file that doesn't match
   any co-op player) — or type it in manually. Convert, download.
4. Replace the world folder on the server with the zip contents (delete the
   old `Players/00000000...0001.sav`), fix file ownership, start the server.
5. **Verify everyone's characters, pals and guild within the first minutes.**
   The server autosaves every ~30 s — if something is wrong, stop it before an
   autosave overwrites your upload.

## Python CLI

The `python/` directory has the same logic as a script (this is what the web
app was ported from — their outputs are byte-identical):

```
pip install palworld-save-tools==0.24.0 pyooz
PYTHONPATH=python/vendor python python/migrate_coop_to_dedicated.py <world_dir> <old_guid> <new_guid>
PYTHONPATH=python/vendor python python/identify_players.py <world_dir>
```

`<old_guid>` is virtually always `00000000000000000000000000000001`.

## How it's tested

`test/parity.test.mjs` runs the JavaScript implementation against real 1.0
saves and asserts:

- parse → rewrite reproduces the decompressed `Level.sav` **byte-identically**;
- the JS migration output is **byte-identical** to the Python implementation's
  output for the same inputs.

Run it with `node test/parity.test.mjs <coop-world> <server-world> <old-guid> <new-guid>`.

## Built on

- [palworld-save-tools](https://github.com/cheahjs/palworld-save-tools) (MIT) — GVAS format base
- [palworld-hostfix-toolkit](https://github.com/quadrantbs/palworld-hostfix-toolkit) (MIT) — the 4-layer fix procedure and 1.0-format parsers
- [xNul/palworld-host-save-fix](https://github.com/xNul/palworld-host-save-fix) (MIT) — the original host fix
- [ooz-wasm](https://www.npmjs.com/package/ooz-wasm) (GPL-3.0) / [pyooz](https://pypi.org/project/pyooz/) — open-source Oodle Kraken decompression ([powzix/ooz](https://github.com/powzix/ooz))

Pal icons (`docs/icons/`) are © Pocketpair, Inc., sourced via
[palworld.wiki.gg](https://palworld.wiki.gg/) and included under fair use for
this non-commercial fan tool. Species/passive data compiled from the game by
the community projects credited above.

Licensed **GPL-3.0** (required by the bundled ooz-wasm; game assets and data
excluded). Not affiliated with Pocketpair — edit save files at your own risk,
with backups.
