/* Stillframe — text formatting, inline selection styles, kerning, floating toolbar */
(function () {
  "use strict";
  const SF = window.Stillframe;
  if (!SF) return;
  const { $, toast, clamp, round } = SF;

  let toolbarBuilt = false;
  let kernTimer = null;
  let lastSelectionKey = "";

  function doc() { return SF.state.doc; }

  function editingEl() {
    const edit = SF.state.inlineEdit;
    return edit && edit.el ? edit.el : null;
  }

  function selectionActive() {
    const el = editingEl();
    if (!el || !doc()) return false;
    try {
      const sel = doc().getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
      const range = sel.getRangeAt(0);
      return el.contains(range.commonAncestorContainer);
    } catch (_) { return false; }
  }

  function anchorElement() {
    const el = editingEl();
    if (el) {
      try {
        const sel = doc().getSelection();
        let node = sel && sel.anchorNode;
        if (node && node.nodeType !== 1) node = node.parentElement;
        if (node && el.contains(node)) return node;
      } catch (_) {}
      return el;
    }
    return SF.getSelection();
  }

  function computedOf(el, prop) {
    if (!el || !doc()) return "";
    try { return doc().defaultView.getComputedStyle(el).getPropertyValue(prop); } catch (_) { return ""; }
  }

  function selectedOrElement() {
    const el = selectionActive() ? anchorElement() : SF.getSelection();
    return el && el.nodeType === 1 ? el : null;
  }

  function fontSizeOf(el) {
    return parseFloat(computedOf(el, "font-size")) || 16;
  }

  function weightOf(el) {
    return parseInt(computedOf(el, "font-weight"), 10) || 400;
  }

  function trackingValue(el) {
    const ls = computedOf(el, "letter-spacing");
    if (!ls || ls === "normal") return 0;
    const px = parseFloat(ls) || 0;
    return Math.round((px / fontSizeOf(el)) * 1000);
  }

  /* ---------- Selection spans ---------- */
  function cleanup(root) {
    if (!root || !root.querySelectorAll) return;
    try {
      let changed = true;
      while (changed) {
        changed = false;
        root.querySelectorAll("span[data-sf-fmt]").forEach((span) => {
          const child = span.firstElementChild;
          if (!child || child.tagName !== "SPAN" || span.childNodes.length !== 1) return;
          Array.from(child.style).forEach((prop) => {
            span.style.setProperty(prop, child.style.getPropertyValue(prop), child.style.getPropertyPriority(prop));
          });
          while (child.firstChild) span.insertBefore(child.firstChild, child);
          child.remove();
          changed = true;
        });
      }
      root.querySelectorAll("span").forEach((span) => {
        span.removeAttribute("data-sf-kern");
        if (span.attributes.length === 0) {
          const parent = span.parentNode;
          while (span.firstChild) parent.insertBefore(span.firstChild, span);
          span.remove();
        } else if (!span.textContent && !span.querySelector("img,br")) {
          span.remove();
        }
      });
      let node = root.firstElementChild;
      while (node) {
        const next = node.nextElementSibling;
        if (next && node.tagName === "SPAN" && next.tagName === "SPAN" &&
            (node.getAttribute("style") || "") === (next.getAttribute("style") || "")) {
          while (next.firstChild) node.appendChild(next.firstChild);
          next.remove();
        } else {
          node = next;
        }
      }
      root.normalize();
    } catch (_) {}
  }

  function mergeAround(node) {
    if (!node || !node.parentElement) return;
    cleanup(node.parentElement);
  }

  function wrapRange(range, styleText) {
    const d = doc();
    if (!d) return null;
    const span = d.createElement("span");
    if (styleText) span.setAttribute("style", styleText);
    span.setAttribute("data-sf-fmt", "1");
    try {
      span.appendChild(range.extractContents());
      range.insertNode(span);
    } catch (_) { return null; }
    const sel = d.getSelection();
    try {
      const next = d.createRange();
      next.selectNodeContents(span);
      sel.removeAllRanges();
      sel.addRange(next);
    } catch (_) {}
    mergeAround(span);
    return span;
  }

  function exactStyledSpan(range, prop) {
    let node = range.commonAncestorContainer;
    if (node && node.nodeType !== 1) node = node.parentElement;
    if (!node || !node.closest) return null;
    const span = node.closest("span[style]");
    if (!span || !span.style.getPropertyValue(prop)) return null;
    if (range.toString() !== span.textContent) return null;
    return span;
  }

  function applySelectionStyle(prop, value) {
    if (!selectionActive()) {
      const el = SF.getSelection();
      if (el) { el.style.setProperty(prop, value); SF.afterMutation("text-format", true); }
      return false;
    }
    const range = doc().getSelection().getRangeAt(0);
    const existing = exactStyledSpan(range, prop);
    if (existing) {
      existing.style.setProperty(prop, value);
      SF.syncCodeFromDoc();
      SF.scheduleHistory("text-format");
      syncInspector();
      updateToolbar();
      return true;
    }
    const span = wrapRange(range, `${prop}:${value}`);
    if (span) {
      SF.syncCodeFromDoc();
      SF.scheduleHistory("text-format");
      syncInspector();
      updateToolbar();
      return true;
    }
    return false;
  }

  /* ---------- Toggles ---------- */
  function toggleWhole(kind) {
    const el = SF.getSelection();
    if (!el) return;
    const cs = computedOf(el, kind === "italic" ? "font-style" : "font-weight");
    if (kind === "bold") {
      const on = weightOf(el) >= 600;
      el.style.setProperty("font-weight", on ? "400" : "700");
    } else if (kind === "italic") {
      const on = /italic|oblique/.test(cs);
      el.style.setProperty("font-style", on ? "normal" : "italic");
    } else if (kind === "underline" || kind === "strike") {
      const current = computedOf(el, "text-decoration-line") || "none";
      const set = new Set(current.split(/\s+/).filter((v) => v && v !== "none"));
      if (kind === "underline") {
        if (set.has("underline")) set.delete("underline"); else set.add("underline");
      } else {
        if (set.has("line-through")) set.delete("line-through"); else set.add("line-through");
      }
      el.style.setProperty("text-decoration-line", set.size ? Array.from(set).join(" ") : "none");
    }
    SF.afterMutation("format-" + kind, true);
    syncInspector();
  }

  function applyFormat(kind) {
    if (!SF.state.doc) return;
    if (selectionActive()) {
      try {
        doc().execCommand("styleWithCSS", false, true);
        const command = { bold: "bold", italic: "italic", underline: "underline", strike: "strikeThrough" }[kind];
        doc().execCommand(command, false, null);
        const root = editingEl();
        if (root) {
          root.querySelectorAll("span").forEach((span) => {
            if (span.style.fontWeight || span.style.fontStyle || span.style.textDecorationLine || span.style.textDecoration) span.setAttribute("data-sf-fmt", "1");
          });
          cleanup(root);
        }
        SF.scheduleHistory("text-format");
        syncInspector();
        updateToolbar();
      } catch (_) {
        toast("This selection could not be formatted.", true);
      }
      return;
    }
    toggleWhole(kind);
  }

  function applyCase(value) {
    if (selectionActive()) {
      applySelectionStyle("text-transform", value === "none" ? "none" : value);
    } else {
      const el = SF.getSelection();
      if (!el) return;
      if (value === "none") el.style.removeProperty("text-transform");
      else el.style.setProperty("text-transform", value);
      SF.afterMutation("text-case", true);
    }
    syncInspector();
  }

  function setTracking(value, opts = {}) {
    const num = clamp(Math.round(Number(value) || 0), -100, 500);
    const em = (num / 1000) + "em";
    if (selectionActive()) {
      applySelectionStyle("letter-spacing", em);
    } else {
      const el = SF.getSelection();
      if (!el) return;
      el.style.setProperty("letter-spacing", em);
      SF.scheduleHistory("tracking");
      SF.updateOverlay();
    }
    syncInspector();
    updateToolbar();
    if (!opts.silent) SF.syncCodeFromDoc();
  }

  function setKerning(on) {
    const el = SF.getSelection();
    if (!el) return;
    el.style.setProperty("font-kerning", on ? "normal" : "none");
    SF.afterMutation("font-kerning", true);
    syncInspector();
  }

  /* ---------- Inspector events ---------- */
  function bindInspector() {
    SF.els.inspectorBody.addEventListener("click", (e) => {
      const format = e.target.closest("[data-format]");
      if (format) { applyFormat(format.dataset.format); return; }
      const c = e.target.closest("[data-case]");
      if (c) { applyCase(c.dataset.case); return; }
    });
    SF.els.inspectorBody.addEventListener("input", (e) => {
      if (e.target.id === "trackingRange") setTracking(e.target.value);
      else if (e.target.id === "trackingInput") setTracking(e.target.value);
    });
    SF.els.inspectorBody.addEventListener("change", (e) => {
      if (e.target.id === "trackingRange" || e.target.id === "trackingInput") {
        SF.recordHistory("tracking", true);
      } else if (e.target.id === "autoKerning") {
        setKerning(e.target.checked);
      }
    });
    SF.els.inspectorBody.addEventListener("keydown", (e) => {
      if (e.target.id !== "trackingInput") return;
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const step = e.shiftKey ? 50 : 5;
        setTracking(Number(e.target.value) + (e.key === "ArrowUp" ? step : -step));
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.target.blur();
      }
    });
  }

  /* ---------- Floating toolbar ---------- */
  function buildToolbar() {
    const node = $("textToolbar");
    if (!node || toolbarBuilt) return;
    toolbarBuilt = true;
    node.innerHTML = `
      <button type="button" class="tt-font" id="ttFontButton" aria-haspopup="dialog" title="Change font"><span id="ttFontName">Font</span></button>
      <span class="tt-sep"></span>
      <label class="tt-field" title="Font size"><input id="ttSize" type="number" min="1" step="1" aria-label="Font size"><span>px</span></label>
      <span class="tt-sep"></span>
      <button type="button" class="tt-format" data-tt-format="bold" aria-pressed="false" title="Bold (Ctrl+B)" aria-label="Bold"><b>B</b></button>
      <button type="button" class="tt-format" data-tt-format="italic" aria-pressed="false" title="Italic (Ctrl+I)" aria-label="Italic"><i>I</i></button>
      <button type="button" class="tt-format" data-tt-format="underline" aria-pressed="false" title="Underline (Ctrl+U)" aria-label="Underline"><u>U</u></button>
      <button type="button" class="tt-format" data-tt-format="strike" aria-pressed="false" title="Strikethrough" aria-label="Strikethrough"><s>S</s></button>
      <span class="tt-sep"></span>
      <label class="tt-field tt-tracking" title="Tracking (1/1000 em)"><span>T</span><input id="ttTracking" type="number" min="-100" max="500" step="5" aria-label="Tracking"></label>`;
    node.addEventListener("click", (e) => {
      if (e.target.closest("#ttFontButton")) { SF.fonts && SF.fonts.openPicker && SF.fonts.openPicker(); return; }
      const f = e.target.closest("[data-tt-format]");
      if (f) applyFormat(f.dataset.ttFormat);
    });
    node.addEventListener("input", (e) => {
      if (e.target.id === "ttSize") {
        const px = clamp(Number(e.target.value) || 1, 1, 400);
        if (selectionActive()) applySelectionStyle("font-size", px + "px");
        else if (SF.getSelection()) { SF.getSelection().style.setProperty("font-size", px + "px"); SF.scheduleHistory("font-size"); SF.updateOverlay(); }
        return;
      }
      if (e.target.id === "ttTracking") setTracking(e.target.value, { silent: true });
    });
  }

  function elementScreenRect(el) {
    if (!el) return null;
    const frame = SF.els.frame;
    const wrap = SF.els.canvasWrap;
    const fr = frame.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const scale = fr.width / Math.max(1, frame.clientWidth || SF.state.pageWidth || 1);
    return {
      left: fr.left - wr.left + rect.left * scale,
      top: fr.top - wr.top + rect.top * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    };
  }

  function positionToolbar() {
    const node = $("textToolbar");
    const el = editingEl();
    if (!node || node.hidden) return;
    if (!el) { hideToolbar(); return; }
    const rect = elementScreenRect(el);
    if (!rect) return;
    const wrap = SF.els.canvasWrap;
    const width = node.offsetWidth || 320;
    const height = node.offsetHeight || 34;
    let left = rect.left + rect.width / 2 - width / 2;
    left = clamp(left, 8, Math.max(8, wrap.clientWidth - width - 8));
    let top = rect.top - height - 8;
    if (top < 6) top = Math.min(wrap.clientHeight - height - 8, rect.top + rect.height + 8);
    node.style.left = left + "px";
    node.style.top = Math.max(6, top) + "px";
  }

  function showToolbar() {
    buildToolbar();
    const node = $("textToolbar");
    if (!node) return;
    node.hidden = false;
    updateToolbar();
    requestAnimationFrame(positionToolbar);
  }

  function hideToolbar() {
    const node = $("textToolbar");
    if (node) node.hidden = true;
  }

  function updateToolbar() {
    const node = $("textToolbar");
    if (!node || node.hidden) return;
    const el = selectedOrElement() || editingEl();
    if (!el) return;
    const name = $("ttFontName");
    if (name) {
      const family = (computedOf(el, "font-family") || "system-ui").split(",")[0].replace(/["']/g, "").trim();
      name.textContent = family;
    }
    const size = $("ttSize");
    if (size && document.activeElement !== size) size.value = Math.round(fontSizeOf(el));
    const track = $("ttTracking");
    if (track && document.activeElement !== track) track.value = trackingValue(el);
    const bold = weightOf(el) >= 600;
    const italic = /italic|oblique/.test(computedOf(el, "font-style"));
    const deco = computedOf(el, "text-decoration-line") || "none";
    setPressed("bold", bold);
    setPressed("italic", italic);
    setPressed("underline", deco.includes("underline"));
    setPressed("strike", deco.includes("line-through"));
    positionToolbar();
  }

  function setPressed(kind, on) {
    document.querySelectorAll(`[data-format="${kind}"], [data-tt-format="${kind}"]`).forEach((button) => {
      button.setAttribute("aria-pressed", String(!!on));
    });
  }

  /* ---------- Sync from computed styles ---------- */
  function syncInspector() {
    const el = selectedOrElement();
    if (!el) return;
    const cs = computedOf(el, "text-decoration-line") || "none";
    setPressed("bold", weightOf(el) >= 600);
    setPressed("italic", /italic|oblique/.test(computedOf(el, "font-style")));
    setPressed("underline", cs.includes("underline"));
    setPressed("strike", cs.includes("line-through"));
    const transform = computedOf(el, "text-transform") || "none";
    document.querySelectorAll("[data-case]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.case === transform));
    });
    const track = trackingValue(el);
    const range = $("trackingRange");
    const input = $("trackingInput");
    if (range && document.activeElement !== range) range.value = String(track);
    if (input && document.activeElement !== input) input.value = String(track);
    const kern = $("autoKerning");
    if (kern) kern.checked = computedOf(el, "font-kerning") !== "none";
    const badge = $("typographyBadge");
    if (badge) badge.textContent = selectionActive() ? "Selection" : "";
  }

  /* ---------- Manual pair kerning ---------- */
  function showKernLabel(value, range) {
    const wrap = SF.els.canvasWrap;
    if (!wrap) return;
    let label = $("kernLabel");
    if (!label) {
      label = document.createElement("div");
      label.id = "kernLabel";
      label.className = "kern-label";
      wrap.appendChild(label);
    }
    const frame = SF.els.frame;
    const fr = frame.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const scale = fr.width / Math.max(1, frame.clientWidth || SF.state.pageWidth || 1);
    const rect = range.getBoundingClientRect();
    label.textContent = "Kern " + (value >= 0 ? "+" : "") + value;
    label.style.left = (fr.left - wr.left + rect.left * scale) + "px";
    label.style.top = (fr.top - wr.top + rect.top * scale - 22) + "px";
    label.hidden = false;
    clearTimeout(kernTimer);
    kernTimer = setTimeout(() => { if (label) label.hidden = true; }, 1000);
  }

  function previousTextPoint(range, root) {
    let node = range.startContainer;
    let offset = range.startOffset;
    if (node.nodeType === 1) {
      let child = node.childNodes[offset - 1];
      while (child && child.nodeType === 1 && child.lastChild) child = child.lastChild;
      if (child && child.nodeType === 3 && child.textContent.length) {
        node = child;
        offset = child.textContent.length;
      } else {
        return null;
      }
    }
    if (node.nodeType !== 3 || offset <= 0) return null;
    if (!root.contains(node)) return null;
    return { node, offset };
  }

  function kernStep(dir, shift) {
    const el = editingEl();
    if (!el || !doc()) return false;
    const sel = doc().getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const point = previousTextPoint(range, el);
    if (!point) return false;
    const node = point.node;
    const offset = point.offset;

    let span = node.parentElement;
    const existingSpan = span && span.tagName === "SPAN" && span.style.letterSpacing && span.textContent.length <= 2 ? span : null;
    let target = null;
    const step = (shift ? 50 : 10) / 1000;

    if (existingSpan) {
      target = existingSpan;
    } else {
      const charRange = doc().createRange();
      charRange.setStart(node, offset - 1);
      charRange.setEnd(node, offset);
      span = doc().createElement("span");
      span.setAttribute("data-sf-fmt", "1");
      try {
        span.appendChild(charRange.extractContents());
        charRange.insertNode(span);
      } catch (_) { return false; }
      target = span;
    }
    let current = parseFloat(target.style.letterSpacing);
    if (!isFinite(current)) current = 0;
    let next = current + dir * step;
    if (Math.abs(next) < 0.0005) next = 0;
    const units = Math.round(next * 1000);
    let caretNode = target;
    if (next === 0) {
      const parent = target.parentNode;
      while (target.firstChild) parent.insertBefore(target.firstChild, target);
      target.remove();
      if (parent) parent.normalize();
      caretNode = parent;
    } else {
      target.style.letterSpacing = next.toFixed(3) + "em";
    }
    try {
      const after = doc().createRange();
      if (next === 0) { after.setStart(caretNode, caretNode.childNodes.length); }
      else { after.setStartAfter(caretNode); }
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      showKernLabel(units, after);
    } catch (_) {}
    SF.scheduleHistory("kern");
    SF.syncCodeFromDoc();
    updateToolbar();
    return true;
  }

  function bindFrame(doc) {
    if (!doc) return;
    doc.addEventListener("keydown", (e) => {
      if (!SF.state.inlineEdit) return;
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        kernStep(e.key === "ArrowRight" ? 1 : -1, e.shiftKey);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === "b" || key === "i" || key === "u" || key === "s") {
          e.preventDefault();
          const kindMap = { b: "bold", i: "italic", u: "underline", s: "strike" };
          applyFormat(kindMap[key]);
        }
      }
    }, true);
    doc.addEventListener("selectionchange", () => {
      if (!SF.state.inlineEdit) return;
      const key = (() => {
        try { const s = doc.getSelection(); return s && s.rangeCount ? s.anchorNode + ":" + s.anchorOffset + ":" + s.focusOffset : ""; } catch (_) { return ""; }
      })();
      if (key === lastSelectionKey) return;
      lastSelectionKey = key;
      syncInspector();
      updateToolbar();
    });
  }

  function bindGlobal() {
    SF.hooks.inlineEditStart.push(() => {
      lastSelectionKey = "";
      showToolbar();
    });
    SF.hooks.inlineEditEnd.push(() => { hideToolbar(); });
    SF.hooks.overlay.push(() => { if (SF.state.inlineEdit) positionToolbar(); });
    SF.hooks.finalize.push(() => { if (SF.state.inlineEdit) { showToolbar(); } });
    SF.hooks.render.push(bindFrame);
    window.addEventListener("resize", () => { if (SF.state.inlineEdit) positionToolbar(); });
    SF.els.canvasScroll.addEventListener("scroll", () => { if (SF.state.inlineEdit) positionToolbar(); }, { passive: true });
  }

  bindInspector();
  bindGlobal();

  SF.textFormat = {
    selectionActive,
    applySelectionStyle,
    applyFormat,
    syncInspector,
    updateToolbar,
    cleanup,
    showToolbar,
    hideToolbar,
    setTracking,
  };
}());
