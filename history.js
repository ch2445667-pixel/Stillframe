/* Stillframe — version history (IndexedDB + UI) */
(function () {
  "use strict";
  const SF = window.Stillframe;
  if (!SF) return;
  const { $, escapeHtml, toast, toastAction } = SF;

  const DB_NAME = "stillframe";
  const DB_VERSION = 1;
  const AUTO_LIMIT = 40;
  const AUTO_IDLE_MS = 10000;
  const AUTO_MIN_GAP_MS = 60000;

  let dbPromise = null;
  let memoryMode = false;
  let memoryWarned = false;
  let versions = [];
  let loaded = false;
  let loadPromise = null;
  let autoTimer = null;
  let lastAutoAt = 0;
  let currentHash = "";
  let currentOriginalId = null;
  let pendingRestore = false;
  const pendingDeletes = new Map();
  const thumbQueue = [];
  let thumbBusy = false;

  function toastMemoryFallback() {
    if (memoryWarned) return;
    memoryWarned = true;
    toast("History won't be saved after you close this tab.", true);
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
      let settled = false;
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { reject(err); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("versions")) db.createObjectStore("versions", { keyPath: "id" });
        if (!db.objectStoreNames.contains("fonts")) db.createObjectStore("fonts", { keyPath: "id" });
      };
      req.onsuccess = () => {
        if (settled) return;
        settled = true;
        const db = req.result;
        db.onversionchange = () => { try { db.close(); } catch (_) {} };
        resolve(db);
      };
      req.onerror = () => { if (!settled) { settled = true; reject(req.error || new Error("IndexedDB error")); } };
      req.onblocked = () => { if (!settled) { settled = true; reject(new Error("IndexedDB blocked")); } };
      setTimeout(() => { if (!settled) { settled = true; reject(new Error("IndexedDB timeout")); } }, 4000);
    });
    return dbPromise;
  }

  async function dbGetAll(storeName) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPut(storeName, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB put failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB put aborted"));
    });
  }

  async function dbDelete(storeName, id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbGet(storeName, id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  SF.db = { open: openDb, getAll: dbGetAll, put: dbPut, delete: dbDelete, get: dbGet, getName: () => DB_NAME };

  function djb2(str) {
    let h = 5381;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  function newId() {
    return "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function sortVersions(list) {
    return list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async function ensureLoaded() {
    if (loaded) return versions;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        const rows = await dbGetAll("versions");
        versions = sortVersions((rows || []).filter(Boolean));
      } catch (_) {
        memoryMode = true;
        versions = sortVersions(versions);
        toastMemoryFallback();
      }
      loaded = true;
      const newestAuto = versions.find((v) => v.kind === "auto");
      if (newestAuto && newestAuto.createdAt) lastAutoAt = newestAuto.createdAt;
      currentHash = SF.serializeClean() ? djb2(SF.serializeClean()) : "";
      return versions;
    })();
    return loadPromise;
  }

  async function persist(record) {
    if (memoryMode) return record;
    try {
      await dbPut("versions", record);
      return record;
    } catch (err) {
      // Quota or other failure: prune oldest unpinned autos and retry once.
      const autos = versions.filter((v) => v.kind === "auto" && !v.pinned).sort((a, b) => a.createdAt - b.createdAt);
      const victims = autos.slice(0, 6);
      for (const victim of victims) {
        try { await dbDelete("versions", victim.id); } catch (_) {}
        versions = versions.filter((v) => v.id !== victim.id);
      }
      try {
        await dbPut("versions", record);
        toast("Cleared old auto-saves to make room for the new version.", true);
        return record;
      } catch (_) {
        memoryMode = true;
        toastMemoryFallback();
        return record;
      }
    }
  }

  function scheduleAuto() {
    ensureLoaded().then(() => {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(() => { maybeAuto(false); }, AUTO_IDLE_MS);
    });
  }

  async function maybeAuto(force) {
    await ensureLoaded();
    if (!SF.state.ready || !SF.state.doc) return;
    const html = SF.serializeClean();
    if (!html) return;
    const hash = djb2(html);
    if (versions[0] && versions[0].hash === hash) return;
    if (!force && Date.now() - lastAutoAt < AUTO_MIN_GAP_MS) {
      scheduleAuto();
      return;
    }
    const rec = await snapshot("auto", null, { force: true, html });
    if (rec) lastAutoAt = rec.createdAt;
  }

  async function pruneAutos() {
    const autos = versions.filter((v) => v.kind === "auto" && !v.pinned).sort((a, b) => a.createdAt - b.createdAt);
    const overflow = autos.length - AUTO_LIMIT;
    if (overflow <= 0) return;
    for (const victim of autos.slice(0, overflow)) {
      versions = versions.filter((v) => v.id !== victim.id);
      if (!memoryMode) { try { await dbDelete("versions", victim.id); } catch (_) {} }
    }
  }

  async function snapshot(kind, name, opts = {}) {
    await ensureLoaded();
    const html = opts.html != null ? String(opts.html) : (SF.state.ready && SF.state.doc ? SF.serializeClean() : "");
    if (!html.trim()) return null;
    const hash = djb2(html);
    const newest = versions[0];
    if (newest && newest.hash === hash && !opts.force) {
      if (kind === "original") {
        const found = versions.find((v) => v.kind === "original" && v.hash === hash);
        if (found) { currentOriginalId = found.id; return found; }
      }
      return null;
    }
    if (kind === "original") {
      const existing = versions.find((v) => v.kind === "original" && v.hash === hash);
      if (existing) { currentOriginalId = existing.id; return existing; }
    }
    const record = {
      id: newId(),
      name: name ? String(name).slice(0, 120) : "",
      createdAt: Date.now(),
      html,
      thumb: "",
      pinned: opts.pinned != null ? !!opts.pinned : kind === "original",
      kind: kind || "manual",
      hash,
    };
    await persist(record);
    versions = sortVersions(versions.concat(record));
    if (kind === "auto") await pruneAutos();
    if (kind === "original") currentOriginalId = record.id;
    if (kind === "manual") toast("Version saved.");
    renderHistory();
    enqueueThumb(record);
    return record;
  }

  /* ---------- Thumbnails ---------- */
  function idle(fn) {
    if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 1800 });
    else setTimeout(fn, 250);
  }

  function enqueueThumb(record) {
    if (!record || !record.html) return;
    thumbQueue.push(record);
    idle(pumpThumbs);
  }

  async function pumpThumbs() {
    if (thumbBusy) return;
    thumbBusy = true;
    try {
      while (thumbQueue.length) {
        const rec = thumbQueue.shift();
        try {
          const thumb = await renderThumb(rec.html);
          if (thumb) {
            rec.thumb = thumb;
            const row = versions.find((v) => v.id === rec.id);
            if (row) row.thumb = thumb;
            if (!memoryMode) { try { await dbPut("versions", rec); } catch (_) {} }
            renderHistory();
          }
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 60));
      }
    } finally {
      thumbBusy = false;
    }
  }

  async function renderThumb(html) {
    if (!SF.ensureH2I()) return "";
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;left:-12000px;top:0;width:780px;height:800px;overflow:hidden;pointer-events:none;opacity:0";
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.style.cssText = "width:780px;height:800px;border:0;background:#fff";
    wrap.appendChild(frame);
    document.body.appendChild(wrap);
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = () => {};
    console.error = () => {};
    try {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        frame.addEventListener("load", finish, { once: true });
        frame.srcdoc = html;
        setTimeout(finish, 3500);
      });
      const doc = frame.contentDocument;
      if (!doc || !doc.body) return "";
      try { SF.preview.applyPreviewMode(doc, SF.preview.getMode()); } catch (_) {}
      try { if (SF.fonts) await SF.fonts.ensureFonts(doc); } catch (_) {}
      try { await Promise.race([doc.fonts.ready, new Promise((r) => setTimeout(r, 1500))]); } catch (_) {}
      await new Promise((r) => setTimeout(r, 300));
      const height = Math.min(2400, Math.max(240, doc.body.scrollHeight || 800));
      frame.style.height = height + "px";
      await new Promise((r) => setTimeout(r, 40));
      const data = await window.htmlToImage.toJpeg(doc.body, {
        quality: 0.6,
        width: 780,
        height,
        pixelRatio: 240 / 780,
        backgroundColor: "#ffffff",
        skipAutoScale: true,
      });
      return data && data.startsWith("data:image/") ? data : "";
    } catch (_) {
      return "";
    } finally {
      wrap.remove();
    }
  }

  /* ---------- UI ---------- */
  function timeOf(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch (_) { return ""; }
  }

  function dayKey(ts) {
    const d = new Date(ts);
    const n = new Date();
    const start = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (day === start) return "Today";
    if (day === start - 86400000) return "Yesterday";
    try { return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === n.getFullYear() ? undefined : "numeric" }); }
    catch (_) { return d.toDateString(); }
  }

  const KIND_LABEL = {
    original: "Original",
    auto: "Auto",
    manual: "Saved",
    "before-restore": "Before restore",
    "before-import": "Before import",
  };

  function displayName(rec) {
    if (rec.name) return rec.name;
    if (rec.kind === "auto") return "Auto-saved " + timeOf(rec.createdAt);
    if (rec.kind === "original") return "Original document";
    if (rec.kind === "before-restore") return "Before restore";
    if (rec.kind === "before-import") return "Before import";
    return "Version " + timeOf(rec.createdAt);
  }

  function currentVersionId() {
    if (!SF.state.ready || !SF.state.doc) return null;
    const hash = djb2(SF.serializeClean());
    currentHash = hash;
    const match = versions.find((v) => v.hash === hash);
    return match ? match.id : null;
  }

  function renderHistory(force) {
    const list = $("historyList");
    if (!list) return;
    if (!force && document.activeElement && document.activeElement.classList.contains("history-rename")) return;
    if (!loaded) {
      list.innerHTML = '<div class="history-empty">Loading versions…</div>';
      return;
    }
    if (!versions.length) {
      list.innerHTML = '<div class="history-empty">No versions yet. Save one before a big change, or keep editing — an auto-save will appear after a pause.</div>';
      return;
    }
    const currentId = currentVersionId();
    let lastDay = "";
    const rows = [];
    versions.forEach((rec) => {
      const day = dayKey(rec.createdAt);
      if (day !== lastDay) {
        rows.push(`<div class="history-day">${escapeHtml(day)}</div>`);
        lastDay = day;
      }
      const isCurrent = rec.id === currentId;
      const thumb = rec.thumb
        ? `<img class="history-thumb" src="${rec.thumb}" alt="" loading="lazy">`
        : `<span class="history-thumb is-empty" aria-hidden="true"><svg width="14" height="14"><use href="#i-history"/></svg></span>`;
      rows.push(`<div class="history-row ${isCurrent ? "is-current" : ""}" data-version-id="${escapeHtml(rec.id)}" tabindex="0">
        ${thumb}
        <div class="history-main">
          <span class="history-name-text" data-name>${escapeHtml(displayName(rec))}</span>
          <span class="history-meta"><span class="kind-badge kind-${escapeHtml(rec.kind)}">${escapeHtml(KIND_LABEL[rec.kind] || "Version")}</span>${rec.pinned ? `<span class="pin-mark" title="Pinned">Pinned</span>` : ""}${isCurrent ? '<span class="current-mark">Current</span>' : ""}</span>
        </div>
        <div class="history-actions">
          <button type="button" data-action="restore" title="Restore this version" aria-label="Restore ${escapeHtml(displayName(rec))}">Restore</button>
          <button type="button" data-action="compare" title="Compare with this version" aria-label="Compare with ${escapeHtml(displayName(rec))}">Compare</button>
          <button type="button" data-action="rename" title="Rename version" aria-label="Rename ${escapeHtml(displayName(rec))}">Rename</button>
          <button type="button" data-action="pin" title="${rec.pinned ? "Unpin" : "Pin"} version" aria-label="${rec.pinned ? "Unpin" : "Pin"} ${escapeHtml(displayName(rec))}">${rec.pinned ? "Unpin" : "Pin"}</button>
          <button type="button" class="is-danger" data-action="delete" title="Delete version" aria-label="Delete ${escapeHtml(displayName(rec))}">Delete</button>
        </div>
      </div>`);
    });
    list.innerHTML = rows.join("");
  }

  function findVersion(id) {
    return versions.find((v) => v.id === id) || null;
  }

  async function restoreVersion(id) {
    const rec = findVersion(id);
    if (!rec) return;
    if (SF.state.inlineEdit) { try { SF.state.inlineEdit = null; } catch (_) {} }
    await snapshot("before-restore", "Before restore", { force: true });
    pendingRestore = true;
    SF.loadDocument(rec.html, {
      resetHistory: false,
      pushHistory: "restore",
      selectionPath: [],
      original: false,
      loadingText: "Restoring version…",
      documentLoad: true,
    });
  }

  function deleteVersion(id) {
    const rec = findVersion(id);
    if (!rec) return;
    versions = versions.filter((v) => v.id !== id);
    renderHistory();
    const timer = setTimeout(async () => {
      pendingDeletes.delete(id);
      if (!memoryMode) { try { await dbDelete("versions", id); } catch (_) {} }
    }, 5000);
    pendingDeletes.set(id, { rec, timer });
    toastAction("Version deleted.", "Undo", () => {
      const pending = pendingDeletes.get(id);
      if (pending) clearTimeout(pending.timer);
      pendingDeletes.delete(id);
      versions = sortVersions(versions.concat(rec));
      renderHistory();
    }, { duration: 5200 });
  }

  async function renameVersion(id, name) {
    const rec = findVersion(id);
    if (!rec) return;
    const previous = rec.name || "";
    const next = String(name || "").trim().slice(0, 120);
    if (next === previous) return;
    rec.name = next;
    if (!memoryMode) { try { await dbPut("versions", rec); } catch (_) {} }
    renderHistory(true);
    toastAction("Version renamed.", "Undo", async () => {
      rec.name = previous;
      if (!memoryMode) { try { await dbPut("versions", rec); } catch (_) {} }
      renderHistory();
    });
  }

  async function togglePin(id) {
    const rec = findVersion(id);
    if (!rec) return;
    const previous = !!rec.pinned;
    rec.pinned = !previous;
    if (!memoryMode) { try { await dbPut("versions", rec); } catch (_) {} }
    renderHistory();
    toastAction(rec.pinned ? "Version pinned." : "Version unpinned.", "Undo", async () => {
      rec.pinned = previous;
      if (!memoryMode) { try { await dbPut("versions", rec); } catch (_) {} }
      renderHistory();
    });
  }

  function startRename(row) {
    const rec = findVersion(row.dataset.versionId);
    if (!rec) return;
    const nameEl = row.querySelector("[data-name]");
    if (!nameEl || row.querySelector(".history-rename")) return;
    const input = document.createElement("input");
    input.className = "history-rename";
    input.value = rec.name || displayName(rec);
    input.setAttribute("aria-label", "Version name");
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) renameVersion(rec.id, input.value);
      else renderHistory(true);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  function bindUi() {
    const list = $("historyList");
    if (list) {
      list.addEventListener("click", (e) => {
        const action = e.target.closest("[data-action]");
        if (!action) return;
        const row = action.closest("[data-version-id]");
        if (!row) return;
        const id = row.dataset.versionId;
        const kind = action.dataset.action;
        if (kind === "restore") restoreVersion(id);
        else if (kind === "compare") { if (SF.compare) SF.compare.enter(id); }
        else if (kind === "rename") startRename(row);
        else if (kind === "pin") togglePin(id);
        else if (kind === "delete") deleteVersion(id);
      });
      list.addEventListener("keydown", (e) => {
        const row = e.target.closest("[data-version-id]");
        if (!row || e.target !== row) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          restoreVersion(row.dataset.versionId);
        }
      });
    }

    const saveButton = $("saveVersionButton");
    const form = $("versionNameForm");
    const input = $("versionNameInput");
    if (saveButton && form && input) {
      saveButton.addEventListener("click", () => {
        form.hidden = false;
        saveButton.hidden = true;
        input.value = "";
        input.focus();
      });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        form.hidden = true;
        saveButton.hidden = false;
        await snapshot("manual", name || ("Version " + timeOf(Date.now())), { force: true });
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          form.hidden = true;
          saveButton.hidden = false;
          saveButton.focus();
        }
      });
    }

    SF.hooks.historyTab.push(() => { ensureLoaded().then(renderHistory); });
    SF.hooks.afterMutation.push(() => {
      scheduleAuto();
      if (!$("historyView") || $("historyView").hidden) return;
      clearTimeout(renderHistory._timer);
      renderHistory._timer = setTimeout(renderHistory, 180);
    });
    SF.hooks.documentLoaded.push((info) => {
      currentHash = SF.serializeClean() ? djb2(SF.serializeClean()) : "";
      ensureLoaded().then(async () => {
        if (info && info.original) {
          const rec = await snapshot("original", SF.state.fileName, { pinned: true });
          if (rec) currentOriginalId = rec.id;
        }
        renderHistory();
      });
    });
    SF.hooks.finalize.push(() => {
      if (!pendingRestore) return;
      pendingRestore = false;
      toastAction("Restored version.", "Undo", () => SF.undo(), { duration: 6000 });
    });
    SF.hooks.afterRender.push(() => {
      ensureLoaded().then(() => {
        if (!$("historyView") || $("historyView").hidden) return;
        renderHistory();
      });
    });
  }

  bindUi();
  ensureLoaded().then(renderHistory);

  SF.history = {
    snapshot,
    ready: () => ensureLoaded(),
    list: () => versions.slice(),
    get: findVersion,
    restore: restoreVersion,
    flushForTest: async () => {
      await ensureLoaded();
      clearTimeout(autoTimer);
      await maybeAuto(true);
      renderHistory();
      return versions.slice();
    },
    getBaseline: () => {
      const hash = SF.serializeClean() ? djb2(SF.serializeClean()) : "";
      return versions.find((v) => v.kind === "original" && v.hash === hash) ||
        versions.find((v) => v.id === currentOriginalId) ||
        versions.find((v) => v.kind === "original") ||
        versions[versions.length - 1] || null;
    },
    getCurrentOriginalId: () => currentOriginalId,
    hash: djb2,
    render: renderHistory,
    _resetForTest: () => { versions = []; loaded = true; },
  };
}());
