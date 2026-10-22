/* Stillframe — before/after compare slider */
(function () {
  "use strict";
  const SF = window.Stillframe;
  if (!SF) return;
  const { $, clamp, escapeHtml } = SF;

  let active = false;
  let split = 50;
  let baselineId = "";
  let baselineHtml = "";
  let beforeFrame = null;
  let shield = null;
  let handle = null;
  let beforePill = null;
  let afterPill = null;
  let dragging = false;
  let dragPointer = null;

  const artboard = () => SF.els.artboard;
  const button = () => $("compareButton");
  const bar = () => $("compareBar");
  const select = () => $("compareBaseline");

  function optionsHtml(selectedId) {
    const list = SF.history && SF.history.list ? SF.history.list() : [];
    const rows = list.map((v) => {
      const label = v.name || (v.kind === "original" ? "Original document" : (v.kind === "auto" ? "Auto-saved" : "Version")) + " · " + new Date(v.createdAt).toLocaleString();
      return `<option value="${escapeHtml(v.id)}" ${v.id === selectedId ? "selected" : ""}>${escapeHtml(label)}</option>`;
    });
    if (!rows.length) rows.push('<option value="__current">Current document</option>');
    return rows.join("");
  }

  function versionById(id) {
    if (!SF.history) return null;
    return SF.history.list().find((v) => v.id === id) || null;
  }

  async function defaultBaseline() {
    try { if (SF.history && SF.history.ready) await SF.history.ready(); } catch (_) {}
    const base = SF.history && SF.history.getBaseline ? SF.history.getBaseline() : null;
    if (base) { baselineId = base.id; baselineHtml = base.html; return; }
    baselineId = "__current";
    baselineHtml = SF.state.doc ? SF.serializeClean() : "";
  }

  async function setBaseline(id, opts = {}) {
    const rec = versionById(id);
    if (rec) {
      baselineId = rec.id;
      baselineHtml = rec.html;
    } else {
      baselineId = "__current";
      baselineHtml = SF.state.doc ? SF.serializeClean() : "";
    }
    const sel = select();
    if (sel) {
      if (!sel.querySelector(`option[value="${baselineId.replace(/"/g, '\\"')}"]`)) sel.innerHTML = optionsHtml(baselineId);
      sel.value = baselineId;
    }
    if (beforeFrame) await loadBefore(beforeFrame, baselineHtml);
    if (!opts.silent) SF.toast("Compare baseline updated.");
  }

  function styleBefore(frame) {
    frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;z-index:2;background:#fff;pointer-events:none";
    frame.className = "compare-before-frame";
  }

  async function loadBefore(frame, html) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      frame.addEventListener("load", finish, { once: true });
      frame.srcdoc = html || "<!doctype html><html><body></body></html>";
      setTimeout(finish, 3500);
    });
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return;
    try { SF.preview.applyPreviewMode(doc, SF.preview.getMode()); } catch (_) {}
    try { if (SF.fonts) await SF.fonts.ensureFonts(doc); } catch (_) {}
  }

  function refreshPreview() {
    if (!beforeFrame) return;
    const doc = beforeFrame.contentDocument;
    if (doc) {
      try { SF.preview.applyPreviewMode(doc, SF.preview.getMode()); } catch (_) {}
      try { if (SF.fonts) SF.fonts.ensureFonts(doc); } catch (_) {}
    }
  }

  function setSplit(value, opts = {}) {
    split = clamp(Number(value) || 0, 0, 100);
    const board = artboard();
    if (board) board.style.setProperty("--split", split + "%");
    if (beforeFrame) beforeFrame.style.clipPath = `inset(0 ${100 - split}% 0 0)`;
    if (handle) {
      handle.style.left = split + "%";
      handle.setAttribute("aria-valuenow", String(Math.round(split)));
      handle.setAttribute("aria-valuetext", Math.round(split) + " percent before");
    }
    if (beforePill) beforePill.classList.toggle("is-hidden", split < 14);
    if (afterPill) afterPill.classList.toggle("is-hidden", split > 86);
    if (opts.announce) {
      const live = $("compareLive");
      if (live) live.textContent = Math.round(split) + "% before";
    }
  }

  function setEditingPaused(on) {
    SF.els.canvasWrap.classList.toggle("compare-active", on);
    if (SF.els.selectionOutline) SF.els.selectionOutline.hidden = on || SF.els.selectionOutline.hidden;
    if (SF.els.hoverOutline) SF.els.hoverOutline.hidden = true;
  }

  function buildLayer() {
    const board = artboard();
    if (!board) return;
    board.style.setProperty("--split", "50%");
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.setAttribute("title", "Before preview");
    frame.setAttribute("aria-hidden", "true");
    styleBefore(frame);
    board.appendChild(frame);
    beforeFrame = frame;

    shield = document.createElement("div");
    shield.className = "compare-shield";
    shield.setAttribute("aria-hidden", "true");
    board.appendChild(shield);

    beforePill = document.createElement("span");
    beforePill.className = "compare-pill is-before";
    beforePill.textContent = "Before";
    afterPill = document.createElement("span");
    afterPill.className = "compare-pill is-after";
    afterPill.textContent = "After";
    board.appendChild(beforePill);
    board.appendChild(afterPill);

    handle = document.createElement("button");
    handle.type = "button";
    handle.className = "compare-handle";
    handle.setAttribute("role", "slider");
    handle.setAttribute("aria-label", "Before and after split");
    handle.setAttribute("aria-valuemin", "0");
    handle.setAttribute("aria-valuemax", "100");
    handle.setAttribute("aria-valuenow", "50");
    handle.innerHTML = '<span class="compare-knob" aria-hidden="true"></span>';
    handle.addEventListener("pointerdown", beginDrag);
    handle.addEventListener("pointermove", moveDrag);
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
    handle.addEventListener("dblclick", (e) => { e.preventDefault(); setSplit(50); });
    handle.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
        e.preventDefault();
        if (e.key === "Home") setSplit(0, { announce: true });
        else if (e.key === "End") setSplit(100, { announce: true });
        else {
          const step = e.shiftKey ? 10 : 2;
          setSplit(split + (e.key === "ArrowRight" ? step : -step), { announce: true });
        }
      }
    });
    board.appendChild(handle);
  }

  function removeLayer() {
    [beforeFrame, shield, handle, beforePill, afterPill].forEach((n) => { if (n && n.parentNode) n.parentNode.removeChild(n); });
    beforeFrame = shield = handle = beforePill = afterPill = null;
    const board = artboard();
    if (board) { board.style.removeProperty("--split"); }
  }

  async function enter(versionId) {
    if (active) {
      if (versionId) await setBaseline(versionId, { silent: true });
      return;
    }
    if (!SF.state.doc) { SF.toast("Load a document before comparing.", true); return; }
    if (SF.state.inlineEdit) SF.finishInlineEdit(false);
    SF.closeMobilePanels();
    active = true;
    setEditingPaused(true);
    buildLayer();
    setSplit(50);
    if (bar()) bar().hidden = false;
    if (button()) button().setAttribute("aria-pressed", "true");
    if (select()) select().innerHTML = optionsHtml(versionId || "");
    if (versionId) await setBaseline(versionId, { silent: true });
    else await defaultBaseline();
    if (select()) select().value = baselineId;
    if (beforeFrame) await loadBefore(beforeFrame, baselineHtml);
    setSplit(50);
    if (handle) handle.focus({ preventScroll: true });
    const live = $("compareLive");
    if (live) live.textContent = "Compare mode: editing is paused. Press Esc to exit.";
  }

  function exit(opts = {}) {
    if (!active) return false;
    active = false;
    dragging = false;
    removeLayer();
    setEditingPaused(false);
    if (bar()) bar().hidden = true;
    if (button()) button().setAttribute("aria-pressed", "false");
    SF.updateOverlay();
    if (!opts.silent) SF.toast("Compare mode closed.");
    return true;
  }

  function toggle() {
    if (active) exit();
    else enter();
  }

  function splitFromPointer(e) {
    const board = artboard();
    if (!board) return split;
    const rect = board.getBoundingClientRect();
    return rect.width > 0 ? ((e.clientX - rect.left) / rect.width) * 100 : 50;
  }

  function beginDrag(e) {
    dragging = true;
    dragPointer = e.pointerId;
    setSplit(splitFromPointer(e), { announce: true });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  }

  function moveDrag(e) {
    if (!dragging || (dragPointer != null && e.pointerId !== dragPointer)) return;
    setSplit(splitFromPointer(e), { announce: true });
  }

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    dragPointer = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
  }

  function bind() {
    const compareButton = button();
    if (compareButton) compareButton.addEventListener("click", toggle);
    const exitButton = $("compareExit");
    if (exitButton) exitButton.addEventListener("click", () => exit());
    const sel = select();
    if (sel) sel.addEventListener("change", () => setBaseline(sel.value));

    const board = artboard();
    if (board) {
      board.addEventListener("pointerdown", (e) => {
        if (!active || !shield || !handle) return;
        if (e.target === handle || handle.contains(e.target)) return;
        if (e.target === shield) beginDrag(e);
      });
      board.addEventListener("pointermove", moveDrag);
      board.addEventListener("pointerup", endDrag);
      board.addEventListener("pointercancel", endDrag);
      board.addEventListener("dblclick", (e) => {
        if (!active) return;
        if (e.target === shield || e.target === handle) { setSplit(50); e.preventDefault(); }
      });
    }

    document.addEventListener("keydown", (e) => {
      if (SF.isTypingTarget(e.target)) return;
      if (e.key.toLowerCase() !== "c" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      toggle();
    });

    SF.escHandlers.push({
      priority: 50,
      fn: () => { if (active) { exit(); return true; } return false; },
    });

    SF.hooks.afterRender.push(() => { if (active) refreshPreview(); });
    SF.hooks.overlay.push(() => {
      if (!active) return;
      if (SF.els.selectionOutline) SF.els.selectionOutline.hidden = true;
      if (SF.els.hoverOutline) SF.els.hoverOutline.hidden = true;
    });
    SF.hooks.documentLoaded.push(() => { if (active) exit({ silent: true }); });
  }

  bind();

  SF.compare = {
    isActive: () => active,
    enter,
    exit,
    toggle,
    setBaseline,
    refreshPreview,
    getSplit: () => split,
    setSplit,
  };
}());
