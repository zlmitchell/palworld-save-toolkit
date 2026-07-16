import { decompress as ooz } from "../vendor/ooz-wasm/index.js";
import { inspectWorld, migrate, formatGuid } from "./migrate.js";
import { buildZip } from "./zip.js";

const $ = (id) => document.getElementById(id);

const state = {
  worldName: null,
  levelBytes: null,
  levelMetaBytes: null,
  playerFiles: new Map(), // GUID32 (upper) -> Uint8Array
  info: null,
  result: null,
};

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

async function ingestFileList(files) {
  state.levelBytes = state.levelMetaBytes = null;
  state.playerFiles.clear();
  state.result = null;
  let worldName = null;
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, "/");
    if (/(^|\/)backup\//i.test(rel)) continue;
    const base = rel.split("/").pop();
    if (base === "Level.sav") {
      state.levelBytes = new Uint8Array(await f.arrayBuffer());
      const parts = rel.split("/");
      if (parts.length >= 2) worldName = parts[parts.length - 2];
    } else if (base === "LevelMeta.sav") {
      state.levelMetaBytes = new Uint8Array(await f.arrayBuffer());
    } else if (/^[0-9A-Fa-f]{32}\.sav$/.test(base) && /(^|\/)Players\//.test(rel)) {
      state.playerFiles.set(base.slice(0, 32).toUpperCase(), new Uint8Array(await f.arrayBuffer()));
    }
  }
  if (!state.levelBytes) {
    alert("No Level.sav found in the selected folder.");
    return;
  }
  state.worldName = worldName;
  $("drop").textContent = `Loaded: ${worldName ?? "world"} — Level.sav (${(state.levelBytes.length / 1024).toFixed(0)} KB), ${state.playerFiles.size} player file(s)`;
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
    tr.innerHTML =
      `<td>${escapeHtml(p.nickname)}</td><td>${p.level ?? "?"}</td>` +
      `<td class="mono">${p.uid}</td>` +
      `<td>${hasFile ? "&#10003;" : "&#10007; missing"}</td>` +
      `<td>${isHost ? '<span class="badge host">co-op host — needs fix</span>' : '<span class="badge ok">carries over</span>'}</td>`;
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
  if (!hasOldHost) {
    setReport(["No co-op host placeholder (…0001) found — this world may already be converted."], false);
  } else {
    $("report").classList.add("hidden");
  }
  $("downloadBtn").classList.add("hidden");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
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
  const blob = new Blob([buildZip(entries)], { type: "application/zip" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${folder}-converted.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
});
