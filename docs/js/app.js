import { decompress as ooz } from "../vendor/ooz-wasm/index.js";
import { inspectWorld, inspectPlayerFile, migrate, formatGuid } from "./migrate.js";
import { listGuilds, importPlayer } from "./transfer.js";
import { applyLevelEdits, applyPlayerFileEdits, maxPalEdits, MAX_PAL, MAX_PLAYER_LEVEL } from "./edit.js";
import { palMeta, palIcon, ELEMENT_COLORS } from "./palnames.js";
import { PASSIVES } from "./passives.js";
import { PALDEX } from "./paldex.js";
import { addPal } from "./addpal.js";
import { buildZip } from "./zip.js";

const $ = (id) => document.getElementById(id);

// Mouse wheel adjusts number inputs on hover (spinners are hidden via CSS).
document.addEventListener(
  "wheel",
  (e) => {
    const input = e.target.closest?.('input[type="number"]');
    if (!input) return;
    e.preventDefault();
    const step = e.deltaY < 0 ? 1 : -1;
    const min = input.min !== "" ? Number(input.min) : -Infinity;
    const max = input.max !== "" ? Number(input.max) : Infinity;
    input.value = Math.max(min, Math.min(max, (Number(input.value) || 0) + step));
  },
  { passive: false }
);

const state = {
  worldName: null,
  levelBytes: null,
  levelMetaBytes: null,
  playerFiles: new Map(), // GUID32 (upper) -> Uint8Array
  extraFiles: new Map(), // other Players/ files (e.g. <guid>_dps.sav) -> Uint8Array
  info: null,
  result: null,
  importSource: null, // { levelBytes, playerFiles, extraFiles, info }
  editMode: false,
  openPlayer: null, // uid of the expanded player row
  palSort: { key: "level", dir: -1 },
};

function elementChips(meta) {
  if (meta.category === "human") return ' <span class="elchip" style="--elc:#8b95a5">Human</span>';
  return meta.elements
    .map((e) => ` <span class="elchip" style="--elc:${ELEMENT_COLORS[e] ?? "#8b95a5"}">${escapeHtml(e)}</span>`)
    .join("");
}

// working copy of passives while a panel is open in edit mode: instanceId -> [ids]
const palPassives = new Map();

function passiveBadge(id, { removable = false, clickable = false, taken = false } = {}) {
  const info = PASSIVES[id];
  const rank = info?.rank ?? 1;
  const name = info?.name ?? id;
  const cls = rank < 0 ? "neg" : `r${Math.min(rank, 5)}`;
  const arrows = rank < 0 ? "&#9660;".repeat(Math.min(-rank, 3)) : "&#9650;".repeat(Math.min(rank, 3));
  const title = escapeHtml(info?.desc || id);
  return (
    `<span class="pbadge ${cls}${taken ? " taken" : ""}" data-pid="${escapeHtml(id)}" title="${title}"` +
    `${clickable ? ' role="button"' : ""}>${escapeHtml(name)}<span class="arrows">${arrows}</span>` +
    `${removable ? '<span class="rm" data-rm="' + escapeHtml(id) + '">&#215;</span>' : ""}</span>`
  );
}

// ---------- file selection ----------

$("drop").addEventListener("click", () => $("picker").click());
$("picker").addEventListener("change", (e) => ingestFileList([...e.target.files]));

$("drop").addEventListener("dragover", (e) => { e.preventDefault(); $("drop").classList.add("over"); });
$("drop").addEventListener("dragleave", () => $("drop").classList.remove("over"));
$("drop").addEventListener("drop", async (e) => {
  e.preventDefault();
  $("drop").classList.remove("over");
  const files = [];
  const walk = async (entry, path) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      files.push(new File([f], path + f.name));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, path + entry.name + "/");
      }
    }
  };
  for (const item of e.dataTransfer.items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) await walk(entry, "");
  }
  ingestFileList(files);
});

async function readWorldFolder(files) {
  const world = { levelBytes: null, levelMetaBytes: null, playerFiles: new Map(), extraFiles: new Map(), worldName: null };
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, "/");
    if (/(^|\/)backup\//i.test(rel)) continue;
    const base = rel.split("/").pop();
    if (base === "Level.sav") {
      world.levelBytes = new Uint8Array(await f.arrayBuffer());
      const parts = rel.split("/");
      if (parts.length >= 2) world.worldName = parts[parts.length - 2];
    } else if (base === "LevelMeta.sav") {
      world.levelMetaBytes = new Uint8Array(await f.arrayBuffer());
    } else if (/^[0-9A-Fa-f]{32}\.sav$/.test(base) && /(^|\/)Players\//.test(rel)) {
      world.playerFiles.set(base.slice(0, 32).toUpperCase(), new Uint8Array(await f.arrayBuffer()));
    } else if (/(^|\/)Players\//.test(rel) && base.endsWith(".sav")) {
      // dimensional pal storage (<guid>_dps.sav) and future extras — keep verbatim
      world.extraFiles.set(base, new Uint8Array(await f.arrayBuffer()));
    }
  }
  return world;
}

async function ingestFileList(files) {
  const world = await readWorldFolder(files);
  if (!world.levelBytes) {
    alert("No Level.sav found in the selected folder.");
    return;
  }
  state.levelBytes = world.levelBytes;
  state.levelMetaBytes = world.levelMetaBytes;
  state.playerFiles = world.playerFiles;
  state.extraFiles = world.extraFiles;
  state.worldName = world.worldName;
  state.result = null;
  state.importSource = null;
  $("drop").textContent = `Loaded: ${world.worldName ?? "world"} — Level.sav (${(state.levelBytes.length / 1024).toFixed(0)} KB), ${state.playerFiles.size} player file(s)`;
  await showInfo();
}

// ---------- inspection ----------

const OLD_HOST = "00000000000000000000000000000001";

async function showInfo() {
  let info;
  try {
    info = await inspectWorld(state.levelBytes, ooz);
  } catch (err) {
    alert(`Could not parse Level.sav: ${err.message}`);
    throw err;
  }
  state.info = info;

  const tbody = $("playersTable").querySelector("tbody");
  tbody.innerHTML = "";
  const hostSelect = $("hostSelect");
  hostSelect.innerHTML = "";
  for (const p of info.players) {
    const guid32 = p.uid.replace(/-/g, "").toUpperCase();
    const isHost = guid32 === OLD_HOST;
    const hasFile = state.playerFiles.has(guid32);
    const tr = document.createElement("tr");
    tr.className = "player-row";
    tr.innerHTML =
      `<td>${escapeHtml(p.nickname)}</td><td>${p.level ?? "?"}</td>` +
      `<td class="mono">${p.uid}</td>` +
      `<td>${hasFile ? "&#10003;" : "&#10007; missing"}</td>` +
      `<td>${isHost ? '<span class="badge host">co-op host — needs fix</span>' : '<span class="badge ok">carries over</span>'}</td>`;
    tr.addEventListener("click", () => togglePlayerDetail(tr, p, guid32));
    tbody.appendChild(tr);
    const opt = document.createElement("option");
    opt.value = guid32;
    opt.textContent = `${p.nickname} (${p.uid})${isHost ? " — co-op host" : ""}`;
    if (isHost) opt.selected = true;
    hostSelect.appendChild(opt);
  }
  $("stats").innerHTML =
    `<span><b>${info.players.length}</b> players</span>` +
    `<span><b>${info.palCount}</b> pals</span>` +
    `<span><b>${info.guilds}</b> guild(s)</span>`;
  $("worldName").textContent = state.worldName ? `Folder: ${state.worldName}` : "";
  $("folderName").value = state.worldName ?? "";

  const hasOldHost = info.players.some((p) => p.uid.replace(/-/g, "").toUpperCase() === OLD_HOST);
  $("infoCard").classList.remove("hidden");
  $("convertCard").classList.remove("hidden");
  $("importCard").classList.remove("hidden");
  $("editWarn").classList.toggle("hidden", state.editMode);
  $("editToolbar").classList.toggle("hidden", !state.editMode);
  if (!hasOldHost) {
    setReport(["No co-op host placeholder (…0001) found — this world may already be converted."], false);
  } else {
    $("report").classList.add("hidden");
  }
  $("downloadBtn").classList.add("hidden");

  // restore the expanded player panel after a re-render
  if (state.openPlayer) {
    const p = info.players.find((x) => x.uid === state.openPlayer);
    if (p) {
      const guid32 = p.uid.replace(/-/g, "").toUpperCase();
      const idx = info.players.indexOf(p);
      const row = tbody.children[idx];
      state.openPlayer = null; // togglePlayerDetail re-sets it
      await togglePlayerDetail(row, p, guid32);
    } else {
      state.openPlayer = null;
    }
  }
}

// ---------- edit mode ----------

$("enableEditBtn").addEventListener("click", () => {
  state.editMode = true;
  $("editWarn").classList.add("hidden");
  $("editToolbar").classList.remove("hidden");
  showInfo();
});

$("maxAllBtn").addEventListener("click", async () => {
  await runEdits({ pals: maxPalEdits(state.info.pals.filter((x) => x.owner)) }, "Maxed ALL owned pals");
});

$("downloadWorldBtn").addEventListener("click", () => {
  const folder = (state.worldName ?? "world").replace(/[\\/]+/g, "");
  const entries = [{ name: `${folder}/Level.sav`, data: state.levelBytes }];
  if (state.levelMetaBytes) entries.push({ name: `${folder}/LevelMeta.sav`, data: state.levelMetaBytes });
  for (const [guid, data] of state.playerFiles) entries.push({ name: `${folder}/Players/${guid}.sav`, data });
  for (const [name, data] of state.extraFiles) entries.push({ name: `${folder}/Players/${name}`, data });
  const blob = new Blob([buildZip(entries)], { type: "application/zip" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${folder}-edited.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- import players from another world ----------

$("importDrop").addEventListener("click", () => $("importPicker").click());
$("importPicker").addEventListener("change", async (e) => {
  const world = await readWorldFolder([...e.target.files]);
  if (!world.levelBytes) {
    alert("No Level.sav found in the selected folder.");
    return;
  }
  $("importDrop").textContent = "Reading world…";
  let info;
  try {
    info = await inspectWorld(world.levelBytes, ooz);
  } catch (err) {
    $("importDrop").textContent = `Could not parse that world: ${err.message}`;
    return;
  }
  state.importSource = { ...world, info };
  $("importDrop").textContent =
    `Loaded: ${world.worldName ?? "world"} — ${info.players.length} player(s), ${info.palCount} pals`;

  const existing = new Set(state.info.players.map((p) => p.uid));
  const tbody = $("importTable").querySelector("tbody");
  tbody.innerHTML = "";
  for (const p of info.players) {
    const guid32 = p.uid.replace(/-/g, "").toUpperCase();
    const isCoopHost = guid32 === OLD_HOST;
    const already = existing.has(p.uid);
    const hasFile = world.playerFiles.has(guid32);
    const palCount = info.pals.filter((x) => x.owner === p.uid).length;
    const tr = document.createElement("tr");
    let nameCell = escapeHtml(p.nickname);
    if (isCoopHost) {
      // co-op host placeholder: must be imported under a real GUID — suggest a
      // target player with the same character name
      const match = state.info.players.find((tp) => tp.nickname === p.nickname);
      const prefill = match ? match.uid.replace(/-/g, "").toUpperCase() : "";
      nameCell +=
        ' <span class="tag host">CO-OP HOST</span><br>' +
        `<input class="edit-num" style="width:300px;margin-top:4px" data-newuid-for="${guid32}" ` +
        `placeholder="import as GUID (32 hex, from the server's Players folder)" value="${prefill}" spellcheck="false">` +
        (match ? ` <span class="iv">matched "${escapeHtml(match.nickname)}" in this world</span>` : "");
    } else if (already) {
      nameCell += ' <span class="tag alpha" title="This player already exists here — importing REPLACES their character, pals and inventory with this world’s version.">REPLACES EXISTING</span>';
    }
    if (!hasFile) nameCell += ' <span class="iv">(no player file)</span>';
    tr.innerHTML =
      `<td><input type="checkbox" data-import="${guid32}" data-uid="${p.uid}" data-replace="${already}" data-coophost="${isCoopHost}" ${!hasFile ? "disabled" : ""}></td>` +
      `<td>${nameCell}</td>` +
      `<td>${p.level ?? "?"}</td><td class="mono">${p.uid}</td><td>${palCount}</td>`;
    tbody.appendChild(tr);
  }

  const guilds = await listGuilds(state.levelBytes, ooz);
  const sel = $("importGuild");
  sel.innerHTML = "";
  for (const g of guilds) {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = `${g.name} (${g.members.join(", ")})`;
    sel.appendChild(opt);
  }
  if (!guilds.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "no usable guild found in this world";
    sel.appendChild(opt);
  }
  $("importList").classList.remove("hidden");
});

$("importBtn").addEventListener("click", async () => {
  const checked = [...document.querySelectorAll('#importTable input[data-import]:checked')];
  const rep = $("importReport");
  rep.classList.remove("hidden");
  if (!checked.length) { rep.textContent = "No players selected."; return; }
  const destGuildId = $("importGuild").value;
  if (!destGuildId) { rep.textContent = "No destination guild available."; return; }
  $("importBtn").disabled = true;
  const lines = [];
  try {
    for (const box of checked) {
      const guid32 = box.dataset.import;
      const uid = box.dataset.uid;
      let newUid = null;
      if (box.dataset.coophost === "true") {
        const input = document.querySelector(`[data-newuid-for="${guid32}"]`);
        newUid = (input?.value ?? "").trim().replace(/-/g, "").replace(/\.sav$/i, "");
        if (!/^[0-9A-Fa-f]{32}$/.test(newUid)) {
          throw new Error(`co-op host needs a real GUID to import as (32 hex characters) — get it from the server's Players folder or pick the matching player in this world`);
        }
      }
      const finalGuid32 = (newUid ?? guid32).toUpperCase();
      const replace = state.info.players.some((tp) => tp.uid.replace(/-/g, "").toUpperCase() === finalGuid32);
      lines.push(`— importing ${uid}${newUid ? ` as ${finalGuid32}` : ""}${replace ? " (replacing existing)" : ""} —`);
      rep.textContent = lines.join("\n");
      const { levelSav, playerFile, report } = await importPlayer({
        targetLevelBytes: state.levelBytes,
        sourceLevelBytes: state.importSource.levelBytes,
        sourcePlayerBytes: state.importSource.playerFiles.get(guid32),
        playerUid: uid,
        destGuildId,
        replace,
        targetPlayerBytes: state.playerFiles.get(finalGuid32) ?? null,
        newUid,
      }, ooz);
      state.levelBytes = levelSav;
      state.playerFiles.set(finalGuid32, playerFile);
      const dps = `${guid32}_dps.sav`;
      if (state.importSource.extraFiles.has(dps)) {
        state.extraFiles.set(`${finalGuid32}_dps.sav`, state.importSource.extraFiles.get(dps));
      }
      lines.push(...report);
      rep.textContent = lines.join("\n");
    }
    lines.push("Import complete. Download the world (or convert it) to save the result.");
    rep.innerHTML = lines.map(escapeHtml).map((l) => (/VERIFICATION PASSED|complete/.test(l) ? `<span class="good">${l}</span>` : l)).join("\n");
    state.result = null;
    $("downloadBtn").classList.add("hidden");
    await showInfo();
  } catch (err) {
    lines.push(`Import failed: ${err.message} — the world was left as it was before this player.`);
    rep.innerHTML = lines.map(escapeHtml).map((l) => (/failed/.test(l) ? `<span class="bad">${l}</span>` : l)).join("\n");
  } finally {
    $("importBtn").disabled = false;
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------- per-player detail drill-down ----------

async function togglePlayerDetail(row, p, guid32) {
  const existing = row.nextElementSibling;
  if (existing?.classList.contains("detail-row")) {
    existing.remove();
    row.classList.remove("open");
    state.openPlayer = null;
    return;
  }
  document.querySelectorAll("#playersTable .detail-row").forEach((r) => r.remove());
  document.querySelectorAll("#playersTable .player-row.open").forEach((r) => r.classList.remove("open"));
  row.classList.add("open");
  state.openPlayer = p.uid;

  // fresh working copy of passives for this panel
  palPassives.clear();
  for (const pal of state.info.pals ?? []) {
    if (pal.owner === p.uid) palPassives.set(pal.instanceId, [...pal.passives]);
  }

  const detail = document.createElement("tr");
  detail.className = "detail-row";
  const td = document.createElement("td");
  td.colSpan = 5;
  td.innerHTML = "Loading…";
  detail.appendChild(td);
  row.after(detail);
  await renderPlayerDetail(td, p, guid32);
}

function sortedPals(uid) {
  const { key, dir } = state.palSort;
  const owned = (state.info.pals ?? []).filter((pal) => pal.owner === uid);
  const keyFn = {
    no: (x) => palMeta(x).no ?? 9999,
    name: (x) => palMeta(x).displayName.toLowerCase(),
    level: (x) => x.level,
    stars: (x) => x.rank,
    ivs: (x) => x.talents.hp + x.talents.melee + x.talents.shot + x.talents.defense,
    friendship: (x) => x.friendship,
  }[key] ?? ((x) => x.level);
  return owned.sort((a, b) => {
    const ka = keyFn(a), kb = keyFn(b);
    return (ka < kb ? -1 : ka > kb ? 1 : 0) * dir;
  });
}

async function renderPlayerDetail(td, p, guid32) {
  const chips = [];
  const edit = state.editMode;
  const numChip = (label, id, value, max) =>
    `<span class="chip">${label} <input class="edit-num" id="${id}" type="number" min="0" max="${max}" value="${value ?? 0}"></span>`;

  chips.push(edit ? numChip("Level", "editPlayerLevel", p.level, MAX_PLAYER_LEVEL) : `Level <b>${p.level ?? "?"}</b>`);
  if (p.exp !== null && !edit) chips.push(`Exp <b>${p.exp.toLocaleString()}</b>`);
  if (p.hp !== null && !edit) chips.push(`HP <b>${Math.round(p.hp).toLocaleString()}</b>`);
  if (p.fullStomach !== null && !edit) chips.push(`Food <b>${p.fullStomach.toFixed(0)}</b>`);
  chips.push(
    edit
      ? numChip("Unspent stat points", "editStatPoints", p.unusedStatusPoints ?? 0, 9999)
      : p.unusedStatusPoints
        ? `Unspent stat points <b>${p.unusedStatusPoints}</b>`
        : null
  );

  let pf = null;
  if (state.playerFiles.has(guid32)) {
    try {
      pf = await inspectPlayerFile(state.playerFiles.get(guid32), ooz);
      if (pf.platform) chips.push(`Platform <b>${escapeHtml(pf.platform)}</b>`);
      chips.push(
        edit
          ? numChip("Tech points", "editTechPoints", pf.techPoints ?? 0, 99999)
          : `Tech points <b>${pf.techPoints ?? 0}</b>`
      );
      chips.push(
        edit
          ? numChip("Ancient tech points", "editAncientPoints", pf.ancientTechPoints ?? 0, 99999)
          : `Ancient tech points <b>${pf.ancientTechPoints ?? 0}</b>`
      );
      if (!edit) chips.push(`Technologies unlocked <b>${pf.unlockedTech}</b>`);
      if (pf.lastOnline && !edit) chips.push(`Last online <b>${pf.lastOnline.toLocaleString()}</b>`);
    } catch (err) {
      chips.push(`player file unreadable: ${escapeHtml(err.message)}`);
    }
  } else {
    chips.push("no player file in selection");
  }

  const owned = sortedPals(p.uid);
  const arrow = (key) => (state.palSort.key === key ? (state.palSort.dir === 1 ? " ▲" : " ▼") : "");

  let palsHtml;
  if (owned.length === 0) {
    palsHtml = `<p class="hint">No pals owned by this player.</p>`;
  } else {
    const head =
      `<thead><tr>` +
      `<th class="sortable" data-sort="no">#${arrow("no")}</th>` +
      `<th class="sortable" data-sort="name">Pal (${owned.length})${arrow("name")}</th>` +
      `<th></th>` +
      `<th class="sortable" data-sort="level">Lvl${arrow("level")}</th>` +
      `<th class="sortable" data-sort="stars">Stars${arrow("stars")}</th>` +
      `<th class="sortable" data-sort="ivs">IVs${arrow("ivs")}</th>` +
      `<th>Passive skills</th>${edit ? "<th>Variant</th><th></th>" : ""}</tr></thead>`;
    const rows = owned
      .map((pal) => {
        const meta = palMeta(pal);
        const iid = pal.instanceId;
        const icon = palIcon(meta);
        const iconImg = icon ? `<img class="palicon" src="${icon}" alt="" loading="lazy" onerror="this.remove()">` : "";
        const nameBits = iconImg + (pal.nickname
          ? `${escapeHtml(pal.nickname)} <span class="iv">(${escapeHtml(meta.displayName)})</span>`
          : escapeHtml(meta.displayName));
        const tags =
          (pal.alpha ? '<span class="tag alpha">BOSS</span>' : "") +
          (pal.lucky && !edit ? '<span class="tag lucky">LUCKY</span>' : "");
        const el = elementChips(meta);
        const gender = pal.gender === "Male" ? "&#9794;" : pal.gender === "Female" ? "&#9792;" : "";
        const foreign =
          pal.originalOwner && pal.originalOwner !== p.uid
            ? ' <span class="iv" title="originally caught by another player">(traded)</span>'
            : "";
        const no = meta.no ?? "?";
        if (!edit) {
          const stars = pal.rank > 1 ? "&#9733;".repeat(Math.min(pal.rank - 1, 4)) : "";
          const ivs = `${pal.talents.hp}/${pal.talents.melee}/${pal.talents.shot}/${pal.talents.defense}`;
          const passives = pal.passives.length
            ? pal.passives.map((id) => passiveBadge(id)).join("")
            : '<span class="iv">—</span>';
          return `<tr><td class="iv">${no}</td><td>${nameBits}${tags}${el}${foreign}</td><td>${gender}</td>` +
            `<td>${pal.level}</td><td>${stars}</td><td class="iv" title="HP / Melee / Shot / Defense IVs">${ivs}</td>` +
            `<td>${passives}</td></tr>`;
        }
        const ivIn = (k) =>
          `<input class="edit-num edit-iv" data-pal="${iid}" data-field="${k}" type="number" min="0" max="100" value="${pal.talents[k]}">`;
        const current = palPassives.get(iid) ?? pal.passives;
        const passiveCell =
          current.map((id) => passiveBadge(id, { removable: true })).join("") +
          (current.length < 4
            ? `<span class="pbadge addbtn" data-add="${iid}" role="button">+ add</span>`
            : "");
        return (
          `<tr data-palrow="${iid}"><td class="iv">${no}</td><td>${nameBits}${tags}${el}${foreign}</td><td>${gender}</td>` +
          `<td><input class="edit-num" style="width:46px" data-pal="${iid}" data-field="level" type="number" min="1" max="${MAX_PAL.level}" value="${pal.level}"></td>` +
          `<td><select class="edit-num" style="width:46px" data-pal="${iid}" data-field="stars">` +
          [0, 1, 2, 3, 4].map((s) => `<option value="${s}" ${pal.rank - 1 === s ? "selected" : ""}>${s}</option>`).join("") +
          `</select></td>` +
          `<td>${ivIn("hp")}${ivIn("melee")}${ivIn("shot")}${ivIn("defense")}</td>` +
          `<td>${passiveCell}</td>` +
          `<td><select class="edit-num" style="width:76px" data-pal="${iid}" data-field="variant">` +
          [["normal", "Normal"], ["lucky", "Lucky"], ["alpha", "Boss"]].map(([v, label]) => {
            const cur = pal.alpha ? "alpha" : pal.lucky ? "lucky" : "normal";
            return `<option value="${v}" ${cur === v ? "selected" : ""}>${label}</option>`;
          }).join("") +
          `</select></td>` +
          `<td><button class="dupbtn" data-dup="${iid}" title="Duplicate this pal">&#10697;</button></td></tr>`
        );
      })
      .join("");
    palsHtml = `<table class="pals-table">${head}<tbody>${rows}</tbody></table>`;
  }

  const applyBar = edit
    ? `<div class="applybar">` +
      `<button id="applyEditsBtn">Apply edits for ${escapeHtml(p.nickname)}</button>` +
      `<button id="maxPlayerPalsBtn" class="warnaction">Max ${escapeHtml(p.nickname)}'s pals</button>` +
      (state.playerFiles.has(guid32) ? `<button id="addPalBtn" class="warnaction">+ Add pal</button>` : "") +
      `<span class="hint" style="margin:0">Souls are set to ${MAX_PAL.souls}/stat by the Max buttons.</span>` +
      `</div>`
    : "";

  td.innerHTML =
    `<div class="chips">${chips.filter(Boolean).map((c) => (c.startsWith("<span") ? c : `<span class="chip">${c}</span>`)).join("")}</div>` +
    palsHtml + applyBar;

  td.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      state.palSort = { key, dir: state.palSort.key === key ? -state.palSort.dir : key === "name" || key === "no" ? 1 : -1 };
      renderPlayerDetail(td, p, guid32);
    });
  });

  if (edit) {
    td.querySelector("#applyEditsBtn")?.addEventListener("click", () => applyPanelEdits(td, p, guid32, pf));
    td.querySelector("#maxPlayerPalsBtn")?.addEventListener("click", async () => {
      await runEdits({ pals: maxPalEdits(state.info.pals.filter((x) => x.owner === p.uid)) },
        `Maxed ${escapeHtml(p.nickname)}'s pals`);
    });
    td.querySelectorAll(".pbadge .rm").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const iid = el.closest("tr").dataset.palrow;
        const list = palPassives.get(iid) ?? [];
        palPassives.set(iid, list.filter((x) => x !== el.dataset.rm));
        renderPlayerDetail(td, p, guid32);
      });
    });
    td.querySelectorAll(".pbadge.addbtn").forEach((el) => {
      el.addEventListener("click", () => openPassivePicker(el.dataset.add, () => renderPlayerDetail(td, p, guid32)));
    });
    td.querySelector("#addPalBtn")?.addEventListener("click", () => openAddPalModal(p, guid32));
    td.querySelectorAll("[data-dup]").forEach((el) => {
      el.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await runAddPal({ ownerUid: p.uid, duplicateInstanceId: el.dataset.dup }, guid32,
          "Duplicated pal");
      });
    });
  }
}

// ---------- add / duplicate pals ----------

async function runAddPal(opts, guid32, label) {
  const rep = $("editReport");
  rep.classList.remove("hidden");
  rep.textContent = "Adding pal…";
  try {
    const { levelSav, report } = await addPal(state.levelBytes, state.playerFiles.get(guid32), opts, ooz);
    state.levelBytes = levelSav;
    rep.innerHTML = `<span class="good">${escapeHtml(label)}</span>\n` + report.map(escapeHtml).join("\n") +
      `\n<span class="good">Remember: nothing is saved until you download.</span>`;
    state.result = null;
    $("downloadBtn").classList.add("hidden");
    await showInfo();
  } catch (err) {
    rep.innerHTML = `<span class="bad">Add pal failed: ${escapeHtml(err.message)} — no changes kept.</span>`;
  }
}

function openAddPalModal(p, guid32) {
  // released Paldeck species only (unreleased/datamined species are excluded)
  const species = Object.entries(PALDEX)
    .filter(([, v]) => v.no !== null)
    .sort((a, b) => a[1].no - b[1].no || a[1].name.localeCompare(b[1].name));
  let selected = null;

  const overlay = document.createElement("div");
  overlay.className = "picker-overlay";
  overlay.innerHTML =
    `<div class="picker"><h3>Add pal to ${escapeHtml(p.nickname)}'s palbox</h3>` +
    `<input type="text" placeholder="Search species by name or number…">` +
    `<div class="list"></div>` +
    `<div class="applybar" style="flex-wrap:wrap">` +
    `<label style="margin:0">Level <input id="addPalLevel" class="edit-num" type="number" min="1" max="${MAX_PAL.level}" value="1"></label>` +
    `<label style="margin:0">Variant <select id="addPalVariant" class="edit-num" style="width:80px">` +
    `<option value="normal">Normal</option><option value="lucky">Lucky</option><option value="alpha">Boss</option></select></label>` +
    `<label style="margin:0">Gender <select id="addPalGender" class="edit-num" style="width:80px">` +
    `<option value="Female">Female</option><option value="Male">Male</option></select></label>` +
    `<button class="ok" disabled>Add</button>` +
    `<button class="cancel" style="background:var(--border);color:var(--text)">Cancel</button>` +
    `</div></div>`;
  document.body.appendChild(overlay);

  const render = (filter = "") => {
    const f = filter.toLowerCase();
    const list = species
      .filter(([k, v]) => !f || v.name.toLowerCase().includes(f) || String(v.no) === f.replace(/^#/, ""))
      .map(([k, v]) =>
        `<span class="pbadge${selected === k ? " r4" : ""}" data-species="${k}" role="button" ` +
        `style="cursor:pointer${selected === k ? ";outline:2px solid var(--accent)" : ""}">` +
        `<img class="palicon" src="icons/${k}.png" alt="" loading="lazy" onerror="this.remove()">` +
        `#${v.no} ${escapeHtml(v.name)}${v.el.length ? ` <span class="iv">${v.el.join("/")}</span>` : ""}</span>`)
      .join("");
    overlay.querySelector(".list").innerHTML = list || '<span class="hint">No matches.</span>';
    overlay.querySelectorAll("[data-species]").forEach((b) => {
      b.addEventListener("click", () => {
        selected = b.dataset.species;
        overlay.querySelector(".ok").disabled = false;
        render(overlay.querySelector("input[type=text]").value);
      });
    });
  };
  render();
  overlay.querySelector("input[type=text]").addEventListener("input", (e) => render(e.target.value));
  overlay.querySelector("input[type=text]").focus();
  overlay.querySelector(".ok").addEventListener("click", async () => {
    const opts = {
      ownerUid: p.uid,
      species: selected,
      level: Number(overlay.querySelector("#addPalLevel").value) || 1,
      variant: overlay.querySelector("#addPalVariant").value,
      gender: overlay.querySelector("#addPalGender").value,
    };
    overlay.remove();
    await runAddPal(opts, guid32, `Added ${PALDEX[selected].name}`);
  });
  overlay.querySelector(".cancel").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}

// ---------- passive skill picker ----------

function openPassivePicker(instanceId, onDone) {
  const selected = new Set(palPassives.get(instanceId) ?? []);
  const overlay = document.createElement("div");
  overlay.className = "picker-overlay";
  const ids = Object.keys(PASSIVES);

  const render = (filter = "") => {
    const f = filter.toLowerCase();
    const full = selected.size >= 4;
    const list = ids
      .filter((id) => !f || PASSIVES[id].name.toLowerCase().includes(f) || id.toLowerCase().includes(f))
      .map((id) => passiveBadge(id, { clickable: true, taken: !selected.has(id) && full }))
      .join("");
    overlay.querySelector(".list").innerHTML = list || '<span class="hint">No matches.</span>';
    overlay.querySelectorAll(".list .pbadge").forEach((b) => {
      const id = b.dataset.pid;
      if (selected.has(id)) b.style.outline = "2px solid var(--accent)";
      b.addEventListener("click", () => {
        if (selected.has(id)) selected.delete(id);
        else if (selected.size < 4) selected.add(id);
        render(overlay.querySelector("input").value);
        overlay.querySelector(".count").textContent = `${selected.size}/4 selected`;
      });
    });
  };

  overlay.innerHTML =
    `<div class="picker"><h3>Passive skills <span class="count hint" style="font-weight:400">${selected.size}/4 selected</span></h3>` +
    `<p class="hint" style="margin:0 0 8px">Search by in-game name (e.g. “Demon God”, “Diamond Body”, “Legend”). ` +
    `Lucky and Alpha aren’t passive skills — use the Variant selector in the pal table.</p>` +
    `<input type="text" placeholder="Search by name or internal id…">` +
    `<div class="list"></div>` +
    `<div class="applybar"><button class="ok">Done</button><button class="cancel" style="background:var(--border);color:var(--text)">Cancel</button></div></div>`;
  document.body.appendChild(overlay);
  render();
  overlay.querySelector("input").addEventListener("input", (e) => render(e.target.value));
  overlay.querySelector("input").focus();
  overlay.querySelector(".ok").addEventListener("click", () => {
    palPassives.set(instanceId, [...selected]);
    overlay.remove();
    onDone();
  });
  overlay.querySelector(".cancel").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}

async function applyPanelEdits(td, p, guid32, pf) {
  const playerEdit = { uid: p.uid };
  const lvl = td.querySelector("#editPlayerLevel");
  if (lvl) playerEdit.level = Number(lvl.value);
  const spts = td.querySelector("#editStatPoints");
  if (spts) playerEdit.unusedStatusPoints = Number(spts.value);

  const palEdits = new Map();
  td.querySelectorAll("[data-pal]").forEach((el) => {
    const id = el.dataset.pal;
    const e = palEdits.get(id) ?? { instanceId: id, talents: null };
    const f = el.dataset.field;
    if (f === "level") e.level = Number(el.value);
    else if (f === "stars") e.stars = Number(el.value);
    else if (f === "variant") {
      // Lucky and Alpha are mutually exclusive in-game; the selector enforces it
      e.lucky = el.value === "lucky";
      e.alpha = el.value === "alpha";
    } else {
      e.talents = e.talents ?? {};
      e.talents[f] = Number(el.value);
    }
    palEdits.set(id, e);
  });
  for (const [iid, passives] of palPassives) {
    const e = palEdits.get(iid) ?? { instanceId: iid, talents: null };
    e.passives = passives;
    palEdits.set(iid, e);
  }
  // fill talent gaps from current values so partial objects don't zero fields
  for (const e of palEdits.values()) {
    if (e.talents) {
      const cur = state.info.pals.find((x) => x.instanceId === e.instanceId)?.talents ?? {};
      e.talents = { ...cur, ...e.talents };
    } else {
      delete e.talents;
    }
  }

  const fileEdits = {};
  const tech = td.querySelector("#editTechPoints");
  if (tech) fileEdits.techPoints = Number(tech.value);
  const ancient = td.querySelector("#editAncientPoints");
  if (ancient) fileEdits.ancientTechPoints = Number(ancient.value);

  await runEdits(
    { players: [playerEdit], pals: [...palEdits.values()] },
    `Applied edits for ${escapeHtml(p.nickname)}`,
    Object.keys(fileEdits).length ? { guid32, fileEdits } : null
  );
}

async function runEdits(edits, label, playerFileEdit = null) {
  const rep = $("editReport");
  rep.classList.remove("hidden");
  rep.textContent = "Applying edits…";
  try {
    const { levelSav, report } = await applyLevelEdits(state.levelBytes, edits, ooz);
    state.levelBytes = levelSav;
    if (playerFileEdit) {
      const updated = await applyPlayerFileEdits(
        state.playerFiles.get(playerFileEdit.guid32), playerFileEdit.fileEdits, ooz);
      state.playerFiles.set(playerFileEdit.guid32, updated);
      report.push("player file updated");
    }
    rep.innerHTML = `<span class="good">${label}</span>\n` + report.map(escapeHtml).join("\n") +
      `\n<span class="good">Remember: nothing is saved until you download.</span>`;
    state.result = null; // stale conversion result, if any
    $("downloadBtn").classList.add("hidden");
    await showInfo(); // re-inspect from the edited bytes; reopens the panel
  } catch (err) {
    rep.innerHTML = `<span class="bad">Edit failed: ${escapeHtml(err.message)} — no changes kept.</span>`;
  }
}

function setReport(lines, isError) {
  const el = $("report");
  el.classList.remove("hidden");
  el.innerHTML = lines
    .map((l) => {
      const cls = /FAILED|failed|Error/.test(l) ? "bad" : /PASSED/.test(l) ? "good" : "";
      return cls ? `<span class="${cls}">${escapeHtml(l)}</span>` : escapeHtml(l);
    })
    .join("\n");
  if (isError) el.innerHTML = `<span class="bad">${el.innerHTML}</span>`;
}

// ---------- auto-detect new GUID from server Players folder ----------

$("serverDrop").addEventListener("click", () => $("serverPicker").click());
$("serverPicker").addEventListener("change", (e) => {
  const files = [...e.target.files];
  const known = new Set(state.playerFiles.keys()); // co-op GUIDs incl. ...0001
  const candidates = [];
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, "/");
    if (/(^|\/)backup\//i.test(rel)) continue;
    const base = rel.split("/").pop();
    const m = /^([0-9A-Fa-f]{32})\.sav$/.exec(base);
    if (!m || !/(^|\/)Players\//.test(rel)) continue;
    const guid = m[1].toUpperCase();
    if (!known.has(guid)) candidates.push({ guid, mtime: f.lastModified, size: f.size });
  }
  const status = $("detectStatus");
  if (candidates.length === 0) {
    status.textContent =
      "No new player file found on the server — the host needs to join the server once (creating a fresh character) first.";
    return;
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  $("newGuid").value = candidates[0].guid;
  if (candidates.length === 1) {
    status.textContent = `Detected host GUID: ${candidates[0].guid}`;
  } else {
    status.textContent =
      `Found ${candidates.length} unknown player files — filled in the most recent (${candidates[0].guid}). ` +
      `Others: ${candidates.slice(1).map((c) => c.guid).join(", ")}. ` +
      "If several people joined fresh, pick the host's by join time.";
  }
});

// ---------- conversion ----------

$("convertBtn").addEventListener("click", async () => {
  const oldGuid = $("hostSelect").value;
  const newGuid = $("newGuid").value.trim().replace(/-/g, "").replace(/\.sav$/i, "");
  if (!/^[0-9A-Fa-f]{32}$/.test(newGuid)) {
    setReport(["Error: the new GUID must be 32 hex characters (the server-side player filename without .sav)."], true);
    return;
  }
  if (!state.playerFiles.has(oldGuid)) {
    setReport([`Error: no Players/${oldGuid}.sav in the selected folder.`], true);
    return;
  }
  $("convertBtn").disabled = true;
  setReport(["Converting…"], false);
  try {
    const result = await migrate(state.levelBytes, state.playerFiles.get(oldGuid), oldGuid, newGuid, ooz);
    state.result = { ...result, oldGuid, newGuid: newGuid.toUpperCase() };
    setReport(result.report, false);
    $("downloadBtn").classList.remove("hidden");
  } catch (err) {
    setReport([`Conversion failed: ${err.message}`, "No files were produced."], true);
  } finally {
    $("convertBtn").disabled = false;
  }
});

$("downloadBtn").addEventListener("click", () => {
  const folder = ($("folderName").value.trim() || state.worldName || "world").replace(/[\\/]+/g, "");
  const entries = [{ name: `${folder}/Level.sav`, data: state.result.levelSav }];
  if (state.levelMetaBytes) entries.push({ name: `${folder}/LevelMeta.sav`, data: state.levelMetaBytes });
  entries.push({ name: `${folder}/Players/${state.result.newGuid}.sav`, data: state.result.playerSav });
  for (const [guid, data] of state.playerFiles) {
    if (guid !== state.result.oldGuid && guid !== state.result.newGuid) {
      entries.push({ name: `${folder}/Players/${guid}.sav`, data });
    }
  }
  for (const [name, data] of state.extraFiles) {
    if (!name.startsWith(state.result.oldGuid)) entries.push({ name: `${folder}/Players/${name}`, data });
  }
  const blob = new Blob([buildZip(entries)], { type: "application/zip" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${folder}-converted.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
});
