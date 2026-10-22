/* Stillframe — Google Fonts picker, live loading, embedding, uploaded fonts */
(function () {
  "use strict";
  const SF = window.Stillframe;
  if (!SF) return;
  const { $, escapeHtml, toast, toastAction, clamp } = SF;

  const SANS_GENERIC = "sans-serif";
  const RECENT_KEY = "stillframe-recent-fonts";
  const CUSTOM_KEY = "stillframe-custom-fonts";
  const SYSTEM_FONTS = ["system-ui", "-apple-system", "Segoe UI", "Arial", "Helvetica", "Verdana", "Tahoma", "Trebuchet MS", "Georgia", "Times New Roman", "Courier New", "Consolas", "Menlo", "Monaco"];
  const CATEGORY_GENERIC = {
    "sans-serif": "sans-serif",
    serif: "serif",
    display: "sans-serif",
    handwriting: "cursive",
    monospace: "monospace",
  };

  const cssCache = new Map();
  const fileCache = new Map();
  const rowFontsLoaded = new Set();
  let customFonts = [];
  let recentFonts = [];
  let uploadedFaces = [];
  let appFontStyle = null;
  let pickerState = { tab: "google", category: "all", query: "", visible: 40, highlight: 0 };
  let observer = null;
  let previewOriginal = null;
  let previewElement = null;
  let popoverOpen = false;
  let embedWarned = false;
  let applyingFamily = false;

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  customFonts = readJson(CUSTOM_KEY, []);
  if (!Array.isArray(customFonts)) customFonts = [];
  recentFonts = readJson(RECENT_KEY, []);
  if (!Array.isArray(recentFonts)) recentFonts = [];

  const catalogue = (SF.fontsData || []).slice();

  function normFamily(name) {
    return String(name || "").split(",")[0].replace(/["']/g, "").trim();
  }

  function findGoogle(family) {
    const key = normFamily(family).toLowerCase();
    return catalogue.find((f) => f.family.toLowerCase() === key) ||
      customFonts.find((f) => f.family.toLowerCase() === key) || null;
  }

  function findUploadedFamily(family) {
    const key = normFamily(family).toLowerCase();
    return uploadedFaces.filter((f) => f.family.toLowerCase() === key);
  }

  function isKnownFamily(family) {
    return !!(findGoogle(family) || findUploadedFamily(family).length);
  }

  function genericFor(family) {
    const g = findGoogle(family);
    if (g) return CATEGORY_GENERIC[g.category] || SANS_GENERIC;
    return SANS_GENERIC;
  }

  function familyCss(family) {
    return `'${String(family).replace(/'/g, "\\'")}', ${genericFor(family)}`;
  }

  function quote(name) {
    return "'" + String(name).replace(/['\\]/g, "\\$&") + "'";
  }

  /* ---------- Computed font usage ---------- */
  function usedFamilies(doc) {
    const map = new Map();
    if (!doc || !doc.body) return map;
    const nodes = [doc.body].concat(Array.from(doc.body.querySelectorAll("*"))).slice(0, 500);
    nodes.forEach((el) => {
      let cs;
      try { cs = doc.defaultView.getComputedStyle(el); } catch (_) { return; }
      const family = normFamily(cs.fontFamily);
      if (!family) return;
      const key = family.toLowerCase();
      if (!map.has(key)) map.set(key, { family, weights: new Set(), italic: false });
      const rec = map.get(key);
      const w = parseInt(cs.fontWeight, 10) || 400;
      rec.weights.add(w);
      if (/italic|oblique/.test(cs.fontStyle)) rec.italic = true;
    });
    return map;
  }

  function css2Url(entries) {
    const parts = entries.map((entry) => {
      const weights = Array.from(entry.weights || [400]).filter((n) => n >= 100 && n <= 900).sort((a, b) => a - b);
      const italic = !!entry.italic;
      if ((!weights.length || (weights.length === 1 && weights[0] === 400)) && !italic) {
        return "family=" + encodeURIComponent(entry.family).replace(/%20/g, "+");
      }
      const axes = [];
      weights.forEach((w) => axes.push("0," + w));
      if (italic) weights.forEach((w) => axes.push("1," + w));
      if (!axes.length) axes.push("0,400");
      return "family=" + encodeURIComponent(entry.family).replace(/%20/g, "+") + ":ital,wght@" + axes.join(";");
    });
    return "https://fonts.googleapis.com/css2?" + parts.join("&") + "&display=swap";
  }

  function uploadedCss(families) {
    const wanted = families ? new Set(families.map((f) => f.toLowerCase())) : null;
    return uploadedFaces
      .filter((face) => !wanted || wanted.has(face.family.toLowerCase()))
      .map((face) => `@font-face{font-family:"${face.family.replace(/"/g, '\\"')}";src:url(${face.dataUri}) format("${face.format || "truetype"}");font-weight:${face.weight || 400};font-style:${face.style || "normal"};font-display:swap;}`)
      .join("");
  }

  function injectUploadedCss(families) {
    const css = uploadedCss(families);
    if (!css) return;
    let style = appFontStyle;
    if (!style) {
      style = document.createElement("style");
      style.setAttribute("data-sf-app-font", "1");
      document.head.appendChild(style);
      appFontStyle = style;
    }
    style.textContent = css;
  }

  async function ensureFonts(doc) {
    if (!doc || !doc.head) return;
    const used = usedFamilies(doc);
    const googleNeeded = [];
    const uploadedNeeded = [];
    const loads = [];
    const existingLinks = Array.from(doc.querySelectorAll('link[href*="fonts.googleapis.com"]'));
    const styleText = Array.from(doc.querySelectorAll("style")).map((n) => n.textContent || "").join("\n");

    used.forEach((rec) => {
      const family = rec.family;
      const google = findGoogle(family);
      const uploads = findUploadedFamily(family);
      if (uploads.length) {
        uploadedNeeded.push(family);
        return;
      }
      if (!google) return;
      const key = family.toLowerCase();
      const alreadyLinked = existingLinks.some((link) => {
        const href = decodeURIComponent(link.getAttribute("href") || "").replace(/\+/g, " ");
        return href.toLowerCase().includes(key);
      });
      const alreadyFace = new RegExp("@font-face[^}]*font-family\\s*:\\s*[\"']?" + family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(styleText);
      if (!alreadyLinked && !alreadyFace) googleNeeded.push({ family, weights: rec.weights, italic: rec.italic });
    });

    try {
      doc.querySelectorAll("link[data-sf-font], style[data-sf-font]").forEach((n) => n.remove());
      if (googleNeeded.length) {
        const link = doc.createElement("link");
        link.rel = "stylesheet";
        link.setAttribute("data-sf-font", "1");
        link.href = css2Url(googleNeeded);
        doc.head.appendChild(link);
        googleNeeded.forEach((entry) => {
          const weight = Array.from(entry.weights)[0] || 400;
          loads.push(doc.fonts.load(`${weight} 16px ${quote(entry.family)}`).catch(() => {}));
        });
      }
      const css = uploadedCss(uploadedNeeded);
      if (css) {
        const style = doc.createElement("style");
        style.setAttribute("data-sf-font", "1");
        style.setAttribute("id", "__sf-preview-fonts");
        style.textContent = css;
        doc.head.appendChild(style);
        uploadedNeeded.forEach((family) => {
          loads.push(doc.fonts.load(`16px ${quote(family)}`).catch(() => {}));
        });
      }
      used.forEach((rec) => {
        if (!googleNeeded.some((g) => g.family === rec.family)) {
          loads.push(doc.fonts.load(`16px ${quote(rec.family)}`).catch(() => {}));
        }
      });
    } catch (_) {}
    await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 4000))]);
  }

  function loadInApp(family) {
    if (!family) return;
    const key = family.toLowerCase();
    if (rowFontsLoaded.has(key)) return;
    rowFontsLoaded.add(key);
    if (findUploadedFamily(family).length) { injectUploadedCss([family]); return; }
    if (!findGoogle(family)) {
      // System and unknown families are previewed locally; no network request is useful.
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.setAttribute("data-sf-row-font", family);
    link.href = "https://fonts.googleapis.com/css2?" + "family=" + encodeURIComponent(family).replace(/%20/g, "+") + "&text=" + encodeURIComponent(family) + "&display=swap";
    document.head.appendChild(link);
  }

  /* ---------- Embedding for export ---------- */
  async function fetchText(url) {
    if (cssCache.has(url)) return cssCache.get(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error("CSS fetch failed");
    const text = await res.text();
    cssCache.set(url, text);
    return text;
  }

  function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function fetchFontDataUri(url) {
    if (fileCache.has(url)) return fileCache.get(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error("Font fetch failed");
    const data = await blobToDataUri(await res.blob());
    fileCache.set(url, data);
    return data;
  }

  function parseRanges(block) {
    const m = block.match(/unicode-range\s*:\s*([^;}]+)/i);
    if (!m) return null;
    const ranges = [];
    m[1].split(",").forEach((part) => {
      const text = part.trim().replace(/^U\+/i, "");
      if (!text) return;
      if (text.includes("?")) {
        const lo = parseInt(text.replace(/\?/g, "0"), 16);
        const hi = parseInt(text.replace(/\?/g, "F"), 16);
        if (isFinite(lo) && isFinite(hi)) ranges.push([lo, hi]);
      } else if (text.includes("-")) {
        const [a, b] = text.split("-").map((x) => parseInt(x, 16));
        if (isFinite(a) && isFinite(b)) ranges.push([a, b]);
      } else {
        const n = parseInt(text, 16);
        if (isFinite(n)) ranges.push([n, n]);
      }
    });
    return ranges.length ? ranges : null;
  }

  function docCodePoints(text) {
    const set = new Set();
    const s = String(text || "");
    for (let i = 0; i < s.length && set.size < 6000; i++) {
      const cp = s.codePointAt(i);
      set.add(cp);
      if (cp > 0xffff) i++;
    }
    return set;
  }

  function blockCovers(block, codepoints) {
    const ranges = parseRanges(block);
    if (!ranges) return true;
    for (const cp of codepoints) {
      for (const [lo, hi] of ranges) {
        if (cp >= lo && cp <= hi) return true;
      }
    }
    return false;
  }

  async function cssWithEmbeddedFonts(cssText, codepoints) {
    const blocks = cssText.match(/@font-face\s*{[^}]*}/g) || [];
    const out = [];
    let failed = false;
    for (const block of blocks) {
      if (!blockCovers(block, codepoints)) continue;
      let next = block;
      const urls = Array.from(block.matchAll(/url\((https?:\/\/[^)]+)\)/g)).map((m) => m[1]);
      for (const url of urls) {
        try {
          const data = await fetchFontDataUri(url);
          next = next.split(url).join(data);
        } catch (_) {
          failed = true;
        }
      }
      out.push(next);
    }
    return { css: out.join("\n"), failed };
  }

  function usedFamilyNames(doc) {
    const set = new Set();
    usedFamilies(doc).forEach((rec) => set.add(rec.family));
    return set;
  }

  function addUploadedFaces(css, text, families) {
    const lower = String(text || "").toLowerCase();
    const wanted = families ? Array.from(families).filter((f) => lower.includes(f.toLowerCase()) || families.has(f)) : null;
    if (!wanted || !wanted.length) return css;
    const extra = uploadedCss(wanted);
    return css + (extra ? "\n" + extra : "");
  }

  async function loadFamilies(doc, families) {
    const loads = [];
    families.forEach((family) => {
      if (doc.fonts && doc.fonts.load) loads.push(doc.fonts.load(`16px ${quote(family)}`).catch(() => {}));
    });
    try { if (doc.fonts && doc.fonts.ready) await doc.fonts.ready; } catch (_) {}
    await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 5000))]);
  }

  async function prepareExport(doc) {
    if (!doc || !doc.head) return null;
    const links = Array.from(doc.querySelectorAll('link[href*="fonts.googleapis.com"]'));
    const families = usedFamilyNames(doc);
    if (!links.length && !uploadedFaces.length) return null;
    const text = (doc.body && (doc.body.innerText || doc.body.textContent)) || "";
    const codepoints = docCodePoints(text);
    const style = doc.createElement("style");
    style.setAttribute("data-sf-embedded", "1");
    let css = "";
    let failed = false;
    for (const link of links) {
      try {
        const result = await cssWithEmbeddedFonts(await fetchText(link.href), codepoints);
        css += result.css + "\n";
        failed = failed || result.failed;
      } catch (_) {
        failed = true;
      }
    }
    css = addUploadedFaces(css, text, families);
    if (!css) {
      if (failed) warnEmbedFailure();
      return null;
    }
    style.textContent = css;
    const removed = links.map((link) => ({ link, parent: link.parentNode, next: link.nextSibling }));
    removed.forEach(({ link }) => { try { link.remove(); } catch (_) {} });
    doc.head.appendChild(style);
    await loadFamilies(doc, Array.from(families));
    if (failed) warnEmbedFailure();
    return function restore() {
      try { style.remove(); } catch (_) {}
      removed.forEach(({ link, parent, next }) => {
        try { parent.insertBefore(link, next && next.parentNode === parent ? next : null); } catch (_) {}
      });
    };
  }

  function warnEmbedFailure() {
    if (embedWarned) return;
    embedWarned = true;
    toast("Some fonts couldn't be embedded, so the image may use a fallback font.", true);
  }

  function familiesInHtml(doc) {
    const found = new Set();
    const add = (value) => {
      String(value || "").split(",").forEach((part) => {
        const family = normFamily(part);
        if (family) found.add(family);
      });
    };
    doc.querySelectorAll("[style]").forEach((el) => {
      const style = el.getAttribute("style") || "";
      const m = style.match(/font-family\s*:\s*([^;]+)/i);
      if (m) add(m[1]);
    });
    doc.querySelectorAll("style").forEach((styleEl) => {
      const css = styleEl.textContent || "";
      const re = /font-family\s*:\s*([^;}]+)/gi;
      let m;
      while ((m = re.exec(css))) add(m[1]);
    });
    return found;
  }

  async function embedHtml(html) {
    let doc;
    try { doc = new DOMParser().parseFromString(html, "text/html"); } catch (_) { return html; }
    const links = Array.from(doc.querySelectorAll('link[href*="fonts.googleapis.com"]'));
    const text = doc.body ? doc.body.textContent || "" : "";
    const codepoints = docCodePoints(text);
    const used = familiesInHtml(doc);
    const needed = [];
    used.forEach((family) => {
      if (!findGoogle(family)) return;
      const already = links.some((link) => decodeURIComponent(link.getAttribute("href") || "").replace(/\+/g, " ").toLowerCase().includes(family.toLowerCase()));
      if (!already) needed.push({ family, weights: [400, 600, 700], italic: false });
    });
    if (!links.length && !needed.length && !uploadedFaces.length) return html;
    let css = "";
    let failed = false;
    const sources = links.map((link) => link.href);
    if (needed.length) sources.push(css2Url(needed));
    for (const href of sources) {
      try {
        const result = await cssWithEmbeddedFonts(await fetchText(href), codepoints);
        css += result.css + "\n";
        failed = failed || result.failed;
      } catch (_) { failed = true; }
    }
    links.forEach((link) => link.remove());
    const usedUploaded = new Set(Array.from(used).filter((family) => findUploadedFamily(family).length));
    css = addUploadedFaces(css, text, usedUploaded);
    if (css) {
      const style = doc.createElement("style");
      style.textContent = css;
      doc.head.appendChild(style);
    }
    if (failed) warnEmbedFailure();
    return "<!doctype html>\n" + doc.documentElement.outerHTML;
  }

  function usedUploadedInText(text) {
    const lower = String(text || "").toLowerCase();
    return new Set(uploadedFamilies().filter((f) => lower.includes(f.family.toLowerCase())).map((f) => f.family));
  }

  /* ---------- Applying fonts ---------- */
  function currentFamily() {
    const el = SF.getSelection();
    if (!el || !SF.state.doc) return "";
    try { return normFamily(SF.state.doc.defaultView.getComputedStyle(el).fontFamily); } catch (_) { return ""; }
  }

  function currentWeight() {
    const el = SF.getSelection();
    if (!el || !SF.state.doc) return 400;
    try { return parseInt(SF.state.doc.defaultView.getComputedStyle(el).fontWeight, 10) || 400; } catch (_) { return 400; }
  }

  function nearestWeight(family, weight) {
    const weights = familyWeights(family);
    if (!weights.length) return weight;
    return weights.reduce((best, w) => Math.abs(w - weight) < Math.abs(best - weight) ? w : best, weights[0]);
  }

  function familyWeights(family) {
    const google = findGoogle(family);
    if (google) return google.weights.slice();
    const faces = findUploadedFamily(family);
    if (faces.length) return Array.from(new Set(faces.map((f) => f.weight || 400))).sort((a, b) => a - b);
    return [300, 400, 500, 600, 700, 800];
  }

  function hasItalic(family) {
    const google = findGoogle(family);
    if (google) return !!google.italic;
    const faces = findUploadedFamily(family);
    if (faces.length) return faces.some((f) => f.style === "italic");
    return true;
  }

  function addRecent(family) {
    recentFonts = [family].concat(recentFonts.filter((f) => f.toLowerCase() !== family.toLowerCase())).slice(0, 6);
    writeJson(RECENT_KEY, recentFonts);
  }

  async function applyFamily(family, opts = {}) {
    if (applyingFamily) return false;
    applyingFamily = true;
    try {
      restorePreview();
      const el = SF.getSelection();
      if (!el || !SF.state.doc) { toast("Select a text element first.", true); return false; }
      const generic = genericFor(family);
      const weight = currentWeight();
      const weightToUse = nearestWeight(family, weight);
      raiseRow(family, true);
      const loaded = await ensureFamilyLoaded(family, weightToUse);
      raiseRow(family, false);
      if (!loaded) {
        toast("Couldn't load this font. Check your connection.", true);
        return false;
      }
      restorePreview();
      const css = `'${String(family).replace(/'/g, "\\'")}', ${generic}`;
      try {
        if (SF.textFormat && SF.textFormat.selectionActive && SF.textFormat.selectionActive()) {
          SF.textFormat.applySelectionStyle("font-family", css);
        } else {
          el.style.setProperty("font-family", css);
          el.style.setProperty("font-weight", String(weightToUse));
        }
      } catch (_) {}
      addRecent(family);
      SF.afterMutation("font-family", true);
      if (SF.renderInspector) SF.renderInspector();
      toast("Font applied: " + family);
      closePicker();
      return true;
    } finally {
      applyingFamily = false;
    }
  }

  async function ensureFamilyLoaded(family, weight) {
    const doc = SF.state.doc;
    if (!doc) return false;
    const uploaded = findUploadedFamily(family);
    if (uploaded.length) {
      const css = uploadedCss([family]);
      if (css) {
        let style = doc.querySelector("style[data-sf-font]");
        if (!style) { style = doc.createElement("style"); style.setAttribute("data-sf-font", "1"); doc.head.appendChild(style); }
        if (!style.textContent.includes(`"${family}"`)) style.textContent += css;
      }
    } else if (findGoogle(family)) {
      const existing = Array.from(doc.querySelectorAll('link[data-sf-font], link[href*="fonts.googleapis.com"]'));
      const key = family.toLowerCase();
      if (!existing.some((link) => decodeURIComponent(link.href).toLowerCase().includes(key))) {
        const link = doc.createElement("link");
        link.rel = "stylesheet";
        link.setAttribute("data-sf-font", "1");
        link.href = css2Url([{ family, weights: [weight || 400], italic: false }]);
        doc.head.appendChild(link);
      }
    } else {
      return true; // system / in-document family
    }
    try {
      const result = await Promise.race([
        doc.fonts.load(`${weight || 400} 16px ${quote(family)}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 6000)),
      ]);
      return !!(result && result.length) || doc.fonts.check(`${weight || 400} 16px ${quote(family)}`);
    } catch (_) {
      return false;
    }
  }

  /* ---------- Popover ---------- */
  function allGoogle() {
    const map = new Map();
    catalogue.concat(customFonts).forEach((f) => {
      const key = f.family.toLowerCase();
      if (!map.has(key)) map.set(key, f);
    });
    return Array.from(map.values());
  }

  function inDocumentFonts() {
    const set = new Set();
    usedFamilies(SF.state.doc).forEach((rec) => set.add(rec.family));
    return Array.from(set).filter((f) => !SYSTEM_FONTS.some((s) => s.toLowerCase() === f.toLowerCase())).sort();
  }

  function uploadedFamilies() {
    const map = new Map();
    uploadedFaces.forEach((face) => {
      const key = face.family.toLowerCase();
      if (!map.has(key)) map.set(key, { family: face.family, faces: [] });
      map.get(key).faces.push(face);
    });
    return Array.from(map.values()).sort((a, b) => a.family.localeCompare(b.family));
  }

  function filteredFonts() {
    const q = pickerState.query.trim().toLowerCase();
    let rows = [];
    if (pickerState.tab === "google") {
      rows = allGoogle().filter((f) => pickerState.category === "all" || f.category === pickerState.category);
    } else if (pickerState.tab === "uploaded") {
      rows = uploadedFamilies().map((f) => ({ family: f.family, category: "uploaded", weights: f.faces.map((x) => x.weight), italic: f.faces.some((x) => x.style === "italic"), uploaded: true }));
    } else if (pickerState.tab === "document") {
      rows = inDocumentFonts().map((f) => ({ family: f, category: "in document", weights: [400, 700], italic: true, inDoc: true }));
    } else {
      rows = SYSTEM_FONTS.map((f) => ({ family: f, category: "system", weights: [400, 700], italic: true, system: true }));
    }
    if (q) rows = rows.filter((f) => f.family.toLowerCase().includes(q));
    return rows.sort((a, b) => a.family.localeCompare(b.family));
  }

  function rowFontFamily(family) {
    return "'" + String(family).replace(/'/g, "\\'") + "', " + genericFor(family);
  }

  function renderPicker() {
    const pop = $("fontPopover");
    if (!pop) return;
    const tabs = [
      ["google", "Google"],
      ["uploaded", "Uploaded"],
      ["document", "In document"],
      ["system", "System"],
    ];
    const categories = [
      ["all", "All"], ["sans-serif", "Sans"], ["serif", "Serif"], ["display", "Display"], ["handwriting", "Handwriting"], ["monospace", "Mono"],
    ];
    const rows = filteredFonts();
    const shown = rows.slice(0, pickerState.visible);
    const recent = pickerState.tab === "google" ? recentFonts.filter((f) => allGoogle().some((g) => g.family.toLowerCase() === f.toLowerCase())) : [];
    const list = shown.map((font, i) => {
      const active = i === pickerState.highlight;
      const current = currentFamily().toLowerCase() === font.family.toLowerCase();
      return `<button type="button" class="font-row ${active ? "is-active" : ""} ${current ? "is-current" : ""}" data-font-family="${escapeHtml(font.family)}" role="option" aria-selected="${active}" tabindex="-1">
        <span class="font-row-name" data-row-font="${escapeHtml(font.family)}" style="font-family:${rowFontFamily(font.family)}">${escapeHtml(font.family)}</span>
        <span class="font-row-meta">${escapeHtml(font.category)}</span>
        ${current ? '<span class="font-current">Current</span>' : ""}
        <span class="spinner font-row-spinner" hidden aria-hidden="true"></span>
      </button>`;
    }).join("");
    const uploadedTab = pickerState.tab === "uploaded";
    const manager = uploadedTab ? uploadedManagerHtml() : "";
    pop.innerHTML = `
      <div class="font-head">
        <input id="fontSearch" class="font-search" type="search" placeholder="Search fonts" aria-label="Search fonts" autocomplete="off" spellcheck="false" value="${escapeHtml(pickerState.query)}">
        <button class="icon-button" id="fontClose" aria-label="Close font picker"><svg width="15" height="15"><use href="#i-x"/></svg></button>
      </div>
      <div class="font-chips" role="group" aria-label="Font category">
        ${categories.map(([value, label]) => `<button type="button" data-font-category="${value}" aria-pressed="${pickerState.category === value}">${label}</button>`).join("")}
      </div>
      <div class="font-tabs" role="tablist" aria-label="Font source">
        ${tabs.map(([value, label]) => `<button type="button" role="tab" data-font-tab="${value}" aria-selected="${pickerState.tab === value}" tabindex="${pickerState.tab === value ? 0 : -1}">${label}</button>`).join("")}
      </div>
      ${recent.length ? `<div class="font-recent"><span>Recent</span>${recent.map((f) => `<button type="button" data-recent-font="${escapeHtml(f)}">${escapeHtml(f)}</button>`).join("")}</div>` : ""}
      <div class="font-list" id="fontList" role="listbox" aria-label="Fonts">
        ${list || '<div class="font-empty">No fonts match. Try another search.</div>'}
      </div>
      ${manager}
      <div class="font-add">
        <input id="fontAddName" type="text" placeholder="Add any Google font by name" aria-label="Google font name" spellcheck="false">
        <button class="mini-button" id="fontAddButton">Add</button>
      </div>
      <div class="font-foot">
        <button class="mini-button" id="uploadFontButton"><svg width="12" height="12"><use href="#i-plus"/></svg>Upload font</button>
        <button class="italic-toggle" id="fontItalicToggle" title="Italic preview" aria-pressed="false" ${hasItalic(currentFamily()) ? "" : "disabled"}>Italic</button>
        <span class="font-availability">${hasItalic(currentFamily()) ? "Italic available" : "No italic cut"}</span>
      </div>
      <input type="file" id="fontFileInput" accept=".ttf,.otf,.woff,.woff2" multiple hidden>`;
    observeRows();
    const search = $("fontSearch");
    if (search) {
      search.addEventListener("input", () => {
        pickerState.query = search.value;
        pickerState.visible = 40;
        pickerState.highlight = 0;
        renderListOnly();
      });
      search.addEventListener("keydown", onSearchKeydown);
    }
  }

  function renderListOnly() {
    const list = $("fontList");
    if (!list) return;
    const rows = filteredFonts();
    const shown = rows.slice(0, pickerState.visible);
    list.innerHTML = shown.length ? shown.map((font, i) => {
      const active = i === pickerState.highlight;
      const current = currentFamily().toLowerCase() === font.family.toLowerCase();
      return `<button type="button" class="font-row ${active ? "is-active" : ""} ${current ? "is-current" : ""}" data-font-family="${escapeHtml(font.family)}" role="option" aria-selected="${active}" tabindex="-1">
        <span class="font-row-name" data-row-font="${escapeHtml(font.family)}" style="font-family:${rowFontFamily(font.family)}">${escapeHtml(font.family)}</span>
        <span class="font-row-meta">${escapeHtml(font.category)}</span>
        ${current ? '<span class="font-current">Current</span>' : ""}
        <span class="spinner font-row-spinner" hidden aria-hidden="true"></span>
      </button>`;
    }).join("") : '<div class="font-empty">No fonts match. Try another search.</div>';
    observeRows();
    const active = list.querySelector(".font-row.is-active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function uploadedManagerHtml() {
    const families = uploadedFamilies();
    if (!families.length) {
      return '<div class="font-manage"><p class="section-note">No uploaded fonts yet. Drop a .ttf, .otf, .woff or .woff2 file, or use Upload font.</p></div>';
    }
    return `<div class="font-manage">${families.map((fam) => `<div class="font-family-block" data-family-block="${escapeHtml(fam.family)}">
      <button type="button" class="font-family-apply" data-font-family="${escapeHtml(fam.family)}">${escapeHtml(fam.family)}</button>
      ${fam.faces.map((face) => `<div class="font-face-row" data-face-id="${escapeHtml(face.id)}">
        <input data-face-family value="${escapeHtml(face.family)}" aria-label="Font family name" spellcheck="false">
        <select data-face-weight aria-label="Weight">${[100,200,300,400,500,600,700,800,900].map((w) => `<option value="${w}" ${Number(face.weight) === w ? "selected" : ""}>${w}</option>`).join("")}</select>
        <select data-face-style aria-label="Style"><option value="normal" ${face.style !== "italic" ? "selected" : ""}>Normal</option><option value="italic" ${face.style === "italic" ? "selected" : ""}>Italic</option></select>
        <button type="button" class="layer-eye font-face-delete" data-delete-face="${escapeHtml(face.id)}" aria-label="Delete ${escapeHtml(face.family)}" title="Delete face"><svg width="12" height="12"><use href="#i-trash"/></svg></button>
      </div>`).join("")}
    </div>`).join("")}</div>`;
  }

  function observeRows() {
    if (observer) observer.disconnect();
    const list = $("fontList");
    if (!list || !window.IntersectionObserver) return;
    observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const family = entry.target.dataset.rowFont;
        if (family) loadInApp(family);
        observer.unobserve(entry.target);
      });
    }, { root: list, rootMargin: "80px" });
    list.querySelectorAll("[data-row-font]").forEach((node) => observer.observe(node));
  }

  function onSearchKeydown(e) {
    const rows = filteredFonts();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      pickerState.highlight = clamp((pickerState.highlight || 0) + delta, 0, Math.max(0, rows.length - 1));
      if (pickerState.highlight >= pickerState.visible) pickerState.visible = pickerState.highlight + 8;
      renderListOnly();
      highlightPreview(rows[pickerState.highlight]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const font = rows[pickerState.highlight];
      if (font) applyFamily(font.family);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePicker();
    }
  }

  function highlightPreview(font) {
    if (!font || applyingFamily) return;
    const el = SF.getSelection();
    if (!el) return;
    if (previewElement !== el) restorePreview();
    previewElement = el;
    if (previewOriginal === null) previewOriginal = { value: el.style.getPropertyValue("font-family"), priority: el.style.getPropertyPriority("font-family") };
    el.style.setProperty("font-family", rowFontFamily(font.family));
    loadInApp(font.family);
  }

  function restorePreview() {
    if (previewElement && previewOriginal !== null) {
      try {
        if (previewOriginal.value) previewElement.style.setProperty("font-family", previewOriginal.value, previewOriginal.priority);
        else previewElement.style.removeProperty("font-family");
      } catch (_) {}
    }
    previewElement = null;
    previewOriginal = null;
  }

  function openPicker() {
    const pop = $("fontPopover");
    if (!pop) return;
    if (!SF.getSelection()) { toast("Select a text element first.", true); return; }
    pickerState.tab = "google";
    pickerState.category = "all";
    pickerState.query = "";
    pickerState.visible = 40;
    pickerState.highlight = 0;
    pop.hidden = false;
    popoverOpen = true;
    renderPicker();
    const button = $("fontPickerButton");
    if (button) button.setAttribute("aria-expanded", "true");
    const search = $("fontSearch");
    if (search) search.focus({ preventScroll: true });
  }

  function closePicker() {
    const pop = $("fontPopover");
    if (!pop || pop.hidden) return;
    restorePreview();
    pop.hidden = true;
    popoverOpen = false;
    const button = $("fontPickerButton");
    if (button) { button.setAttribute("aria-expanded", "false"); button.focus({ preventScroll: true }); }
  }

  function isPickerOpen() { return popoverOpen; }

  function currentRow(family) {
    const list = $("fontList");
    if (!list) return null;
    return Array.from(list.querySelectorAll("[data-font-family]")).find((row) => row.dataset.fontFamily === family) || null;
  }

  function raiseRow(family, on) {
    const row = currentRow(family);
    if (!row) return;
    const spinner = row.querySelector(".font-row-spinner");
    if (spinner) spinner.hidden = !on;
    row.classList.toggle("is-loading", on);
  }

  /* ---------- Uploaded fonts ---------- */
  function formatFromName(name) {
    const ext = String(name).toLowerCase().split(".").pop();
    if (ext === "otf") return { mime: "font/otf", format: "opentype" };
    if (ext === "woff") return { mime: "font/woff", format: "woff" };
    if (ext === "woff2") return { mime: "font/woff2", format: "woff2" };
    return { mime: "font/ttf", format: "truetype" };
  }

  function guessFamily(name) {
    let base = String(name || "").replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/, "");
    base = base.replace(/[-_]+/g, " ");
    base = base.replace(/\b(regular|bold|italic|oblique|light|medium|semibold|semi bold|extrabold|extra bold|black|thin|heavy|book|roman)\b/gi, " ");
    base = base.replace(/\s+/g, " ").trim();
    if (!base) base = "Uploaded font";
    return base.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function guessWeight(name) {
    const n = String(name).toLowerCase();
    if (/thin|hairline/.test(n)) return 100;
    if (/extralight|extra light|ultralight/.test(n)) return 200;
    if (/light/.test(n)) return 300;
    if (/medium/.test(n)) return 500;
    if (/semibold|semi bold|demibold/.test(n)) return 600;
    if (/extrabold|extra bold|ultrabold/.test(n)) return 800;
    if (/black|heavy/.test(n)) return 900;
    if (/bold/.test(n)) return 700;
    return 400;
  }

  function guessStyle(name) {
    return /italic|oblique/i.test(String(name)) ? "italic" : "normal";
  }

  function bufferToDataUri(buffer, mime) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return "data:" + mime + ";base64," + btoa(binary);
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let installed = 0;
    for (const file of files) {
      const ext = String(file.name).toLowerCase().split(".").pop();
      if (!["ttf", "otf", "woff", "woff2"].includes(ext)) {
        toast("Unsupported font file: " + file.name, true);
        continue;
      }
      let buffer;
      try { buffer = await file.arrayBuffer(); } catch (_) { toast("This font file couldn't be read: " + file.name, true); continue; }
      try {
        const test = new FontFace("sf-test-" + Math.random().toString(36).slice(2), buffer.slice(0));
        await test.load();
      } catch (_) {
        toast("This font file couldn't be read: " + file.name, true);
        continue;
      }
      if (file.size > 5 * 1024 * 1024) toast("That font is large (" + Math.round(file.size / 1024 / 1024) + " MB). It is installed, but may slow exports.", true);
      const meta = formatFromName(file.name);
      const face = {
        id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        family: guessFamily(file.name),
        weight: guessWeight(file.name),
        style: guessStyle(file.name),
        dataUri: bufferToDataUri(buffer, meta.mime),
        format: meta.format,
        createdAt: Date.now(),
      };
      uploadedFaces.push(face);
      try { await SF.db.put("fonts", face); } catch (_) { toast("The font was installed for this tab only.", true); }
      installed++;
    }
    if (installed) {
      injectUploadedCss();
      if (SF.state.doc) ensureFonts(SF.state.doc);
      if (popoverOpen) renderPicker();
      toast(installed === 1 ? "Font installed." : installed + " fonts installed.");
    }
  }

  async function loadUploaded() {
    try {
      const rows = await SF.db.getAll("fonts");
      uploadedFaces = (rows || []).filter((f) => f && f.family && f.dataUri);
      injectUploadedCss();
    } catch (_) {
      uploadedFaces = [];
    }
  }

  async function deleteFace(id) {
    const index = uploadedFaces.findIndex((f) => f.id === id);
    if (index < 0) return;
    const face = uploadedFaces[index];
    uploadedFaces.splice(index, 1);
    try { await SF.db.delete("fonts", id); } catch (_) {}
    injectUploadedCss();
    if (SF.state.doc) ensureFonts(SF.state.doc);
    if (popoverOpen) renderPicker();
    toastAction("Font deleted.", "Undo", async () => {
      uploadedFaces.push(face);
      try { await SF.db.put("fonts", face); } catch (_) {}
      injectUploadedCss();
      if (SF.state.doc) ensureFonts(SF.state.doc);
      if (popoverOpen) renderPicker();
    }, { duration: 5200 });
  }

  async function updateFace(faceId, patch) {
    const face = uploadedFaces.find((f) => f.id === faceId);
    if (!face) return;
    if (Object.keys(patch).every((key) => face[key] === patch[key])) return;
    const previous = {};
    Object.keys(patch).forEach((key) => { previous[key] = face[key]; });
    Object.assign(face, patch);
    try { await SF.db.put("fonts", face); } catch (_) {}
    injectUploadedCss();
    if (SF.state.doc) ensureFonts(SF.state.doc);
    if (popoverOpen) renderPicker();
    toastAction("Font updated.", "Undo", async () => {
      Object.assign(face, previous);
      try { await SF.db.put("fonts", face); } catch (_) {}
      injectUploadedCss();
      if (SF.state.doc) ensureFonts(SF.state.doc);
      if (popoverOpen) renderPicker();
    });
  }

  function bindPicker() {
    const pop = $("fontPopover");
    if (!pop) return;
    pop.addEventListener("click", (e) => {
      if (e.target.closest("#fontClose")) { closePicker(); return; }
      const tab = e.target.closest("[data-font-tab]");
      if (tab) {
        pickerState.tab = tab.dataset.fontTab;
        pickerState.visible = 40;
        pickerState.highlight = 0;
        pickerState.query = "";
        renderPicker();
        const search = $("fontSearch");
        if (search) search.focus();
        return;
      }
      const cat = e.target.closest("[data-font-category]");
      if (cat) {
        pickerState.category = cat.dataset.fontCategory;
        pickerState.visible = 40;
        pickerState.highlight = 0;
        renderPicker();
        const search = $("fontSearch");
        if (search) search.focus();
        return;
      }
      const recent = e.target.closest("[data-recent-font]");
      if (recent) { applyFamily(recent.dataset.recentFont); return; }
      const row = e.target.closest("[data-font-family]");
      if (row) { applyFamily(row.dataset.fontFamily); return; }
      if (e.target.closest("#fontAddButton")) { addCustomFont(); return; }
      if (e.target.closest("#uploadFontButton")) { const input = $("fontFileInput"); if (input) input.click(); return; }
      if (e.target.closest("#fontItalicToggle")) {
        const el = SF.getSelection();
        if (!el) return;
        const on = e.target.getAttribute("aria-pressed") === "true";
        el.style.setProperty("font-style", on ? "normal" : "italic");
        e.target.setAttribute("aria-pressed", String(!on));
        SF.afterMutation("font-style", true);
        return;
      }
      const del = e.target.closest("[data-delete-face]");
      if (del) { deleteFace(del.dataset.deleteFace); return; }
    });

    pop.addEventListener("change", (e) => {
      const faceRow = e.target.closest("[data-face-id]");
      if (!faceRow) return;
      const id = faceRow.dataset.faceId;
      if (e.target.matches("[data-face-family]")) updateFace(id, { family: e.target.value.trim() || "Uploaded font" });
      else if (e.target.matches("[data-face-weight]")) updateFace(id, { weight: Number(e.target.value) });
      else if (e.target.matches("[data-face-style]")) updateFace(id, { style: e.target.value });
    });

    pop.addEventListener("keydown", (e) => {
      const tab = e.target.closest && e.target.closest("[data-font-tab]");
      if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const tabs = Array.from(pop.querySelectorAll("[data-font-tab]"));
        const index = tabs.indexOf(tab);
        const nextIndex = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        const next = tabs[nextIndex];
        if (next) {
          const value = next.dataset.fontTab;
          next.click();
          const fresh = pop.querySelector(`[data-font-tab="${value}"]`);
          if (fresh) fresh.focus();
        }
        return;
      }
      if (e.target && e.target.id === "fontAddName" && e.key === "Enter") {
        e.preventDefault();
        addCustomFont();
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePicker(); }
    });

    document.addEventListener("click", (e) => {
      if (!popoverOpen) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      if (path.includes(pop) || pop.contains(e.target)) return;
      if (e.target.closest && (e.target.closest("#fontPickerButton") || e.target.closest("#ttFontButton"))) return;
      closePicker();
    });

    pop.addEventListener("mouseover", (e) => {
      const row = e.target.closest("[data-font-family]");
      if (!row || row.classList.contains("font-family-apply")) return;
      highlightPreview({ family: row.dataset.fontFamily });
    });
    pop.addEventListener("mouseout", (e) => {
      const row = e.target.closest("[data-font-family]");
      if (!row) return;
      const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest("[data-font-family]") : null;
      if (to !== row) restorePreview();
    });

    pop.addEventListener("scroll", () => {}, true);
    const list = $("fontList");
    if (list) {
      list.addEventListener("scroll", () => {
        if (list.scrollTop + list.clientHeight >= list.scrollHeight - 40) {
          if (pickerState.visible < filteredFonts().length) {
            pickerState.visible += 40;
            renderListOnly();
          }
        }
      });
    }

    window.addEventListener("scroll", () => { if (popoverOpen) restorePreview(); }, true);

    SF.escHandlers.push({
      priority: 100,
      fn: () => { if (popoverOpen) { closePicker(); return true; } return false; },
    });

    SF.els.inspectorBody.addEventListener("click", (e) => {
      if (!e.target.closest("#fontPickerButton")) return;
      if (popoverOpen) closePicker(); else openPicker();
    });
    SF.els.inspectorBody.addEventListener("keydown", (e) => {
      if (!e.target.closest("#fontPickerButton")) return;
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
    });
  }

  async function addCustomFont() {
    const input = $("fontAddName");
    if (!input) return;
    const family = input.value.trim().replace(/\s+/g, " ");
    if (!family) { input.focus(); return; }
    const exists = allGoogle().some((f) => f.family.toLowerCase() === family.toLowerCase());
    if (exists) { toast("That font is already in the list."); pickerState.query = family; renderPicker(); return; }
    const url = "https://fonts.googleapis.com/css2?family=" + encodeURIComponent(family).replace(/%20/g, "+") + ":wght@400;700&display=swap";
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("not found");
      const text = await res.text();
      if (!/font-family/i.test(text)) throw new Error("not found");
      customFonts.push({ family, category: "sans-serif", weights: [400, 700], italic: false, custom: true });
      writeJson(CUSTOM_KEY, customFonts);
      toast("Added " + family + " to Google fonts.");
      pickerState.tab = "google";
      pickerState.category = "all";
      pickerState.query = family;
      pickerState.visible = 40;
      pickerState.highlight = 0;
      renderPicker();
      loadInApp(family);
    } catch (_) {
      toast("Couldn't find that Google font. Check the spelling.", true);
    }
  }

  /* ---------- Inspector sync ---------- */
  function syncInspector() {
    const button = $("fontPickerButton");
    if (!button) return;
    const family = currentFamily() || "system-ui";
    const name = $("fontPickerName");
    if (name) {
      name.textContent = family;
      name.style.fontFamily = rowFontFamily(family);
    }
    loadInApp(family);
    const weightSelect = $("fontWeightSelect");
    if (weightSelect) {
      const weights = familyWeights(family);
      const current = currentWeight();
      const nearest = nearestWeight(family, current);
      weightSelect.innerHTML = weights.map((w) => `<option value="${w}" ${w === nearest ? "selected" : ""}>${w}</option>`).join("");
      weightSelect.value = String(nearest);
    }
    const italic = $("fontItalicToggle");
    if (italic) italic.disabled = !hasItalic(family);
  }

  function init() {
    bindPicker();
    const input = $("fontFileInput");
    if (input) {
      input.addEventListener("change", () => {
        const files = input.files ? Array.from(input.files) : [];
        input.value = "";
        uploadFiles(files);
      });
    }
    // Uploaded tab input is recreated on each render; delegate from the popover.
    const pop = $("fontPopover");
    if (pop) {
      pop.addEventListener("change", (e) => {
        if (e.target.id === "fontFileInput") {
          const files = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = "";
          uploadFiles(files);
        }
      });
    }
    SF.hooks.finalize.push((doc) => { ensureFonts(doc); if (popoverOpen) syncInspector(); });
    SF.hooks.documentLoaded.push(() => loadUploaded().then(() => { if (popoverOpen) renderPicker(); }));
    loadUploaded();
    syncInspector();
  }

  init();

  SF.fonts = {
    ensureFonts,
    prepareExport,
    embedHtml,
    uploadFiles,
    syncInspector,
    isPickerOpen,
    openPicker,
    closePicker,
    applyFamily,
    catalogue: allGoogle,
    uploaded: () => uploadedFaces.slice(),
    __renderPicker: renderPicker,
  };
}());
