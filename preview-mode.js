/* Stillframe — design preview (Auto / Light / Dark) */
(function () {
  "use strict";
  const SF = window.Stillframe;
  if (!SF) return;

  const STORAGE_KEY = "stillframe-preview-mode";
  const docState = new WeakMap();
  let mode = "auto";
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "auto") mode = saved;
  } catch (_) {}

  function stateFor(doc) {
    let info = docState.get(doc);
    if (!info) {
      info = {
        mediaRules: new Map(),
        original: null,
        classDark: false,
      };
      docState.set(doc, info);
    }
    if (info.original === null) {
      const html = doc.documentElement;
      info.original = {
        style: html.getAttribute("style"),
        className: html.getAttribute("class"),
        theme: html.getAttribute("data-theme"),
        bsTheme: html.getAttribute("data-bs-theme"),
      };
      info.classDark = detectClassBasedDark(doc);
    }
    return info;
  }

  function detectClassBasedDark(doc) {
    try {
      if (doc.documentElement.classList && doc.documentElement.classList.contains("dark")) return true;
      const htmlText = doc.documentElement.outerHTML;
      if (/(^|[\s,{])\.dark\b/.test(htmlText)) return true;
      if (/class\s*=\s*["'][^"']*\bdark\b/.test(htmlText)) return true;
      if (/\[data-(?:bs-)?theme\b/.test(htmlText)) return true;
      if (/\bdata-(?:bs-)?theme\s*=/.test(htmlText)) return true;
    } catch (_) {}
    return false;
  }

  function isMediaRule(rule) {
    return !!(rule && rule.media && typeof rule.media.mediaText === "string" && rule.cssRules);
  }

  function walkRules(rules, info, forced) {
    if (!rules) return;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (isMediaRule(rule)) {
        if (!info.mediaRules.has(rule)) info.mediaRules.set(rule, rule.media.mediaText);
        const originalText = String(info.mediaRules.get(rule) || "").toLowerCase();
        if (originalText.includes("prefers-color-scheme")) {
          if (forced === "auto") {
            rule.media.mediaText = info.mediaRules.get(rule);
          } else {
            const wantsDark = originalText.includes("dark");
            const wantsLight = originalText.includes("light");
            const match = (forced === "dark" && wantsDark) || (forced === "light" && wantsLight);
            rule.media.mediaText = match ? "all" : "not all";
          }
        }
        try { walkRules(rule.cssRules, info, forced); } catch (_) {}
      } else if (rule && rule.cssRules) {
        try { walkRules(rule.cssRules, info, forced); } catch (_) {}
      }
    }
  }

  function applyPreviewMode(doc, nextMode) {
    if (!doc || !doc.documentElement) return;
    const forced = nextMode === "light" || nextMode === "dark" ? nextMode : "auto";
    const info = stateFor(doc);
    const html = doc.documentElement;

    // 1. color-scheme on the design document only.
    try {
      if (forced === "auto") {
        if (info.original && info.original.style !== null) html.setAttribute("style", info.original.style);
        else html.removeAttribute("style");
        info.appliedColorScheme = false;
      } else {
        html.style.setProperty("color-scheme", forced);
        info.appliedColorScheme = true;
      }
    } catch (_) {}

    // 2. Rewrite prefers-color-scheme media rules in same-origin sheets.
    let sheets = [];
    try { sheets = Array.from(doc.styleSheets || []); } catch (_) {}
    sheets.forEach((sheet) => {
      let rules = null;
      try { rules = sheet.cssRules; } catch (_) { return; }
      walkRules(rules, info, forced);
    });

    // 3. Class/attribute based dark mode, only when the page uses it.
    if (info.classDark) {
      if (forced === "auto") {
        if (info.original) {
          if (info.original.className === null) html.removeAttribute("class");
          else html.setAttribute("class", info.original.className);
          if (info.original.theme === null) html.removeAttribute("data-theme");
          else html.setAttribute("data-theme", info.original.theme);
          if (info.original.bsTheme === null) html.removeAttribute("data-bs-theme");
          else html.setAttribute("data-bs-theme", info.original.bsTheme);
        }
      } else {
        if (forced === "dark") html.classList.add("dark");
        else html.classList.remove("dark");
        html.setAttribute("data-theme", forced);
        html.setAttribute("data-bs-theme", forced);
      }
    }
  }

  function stripClone(clone, sourceDoc) {
    if (!clone || !sourceDoc) return;
    const info = docState.get(sourceDoc);
    if (!info || !info.original) return;
    const orig = info.original;
    if (orig.style === null) clone.removeAttribute("style");
    else clone.setAttribute("style", orig.style);
    if (orig.className === null) clone.removeAttribute("class");
    else clone.setAttribute("class", orig.className);
    if (orig.theme === null) clone.removeAttribute("data-theme");
    else clone.setAttribute("data-theme", orig.theme);
    if (orig.bsTheme === null) clone.removeAttribute("data-bs-theme");
    else clone.setAttribute("data-bs-theme", orig.bsTheme);
  }

  function currentDoc() {
    try { return SF.getDoc(); } catch (_) { return null; }
  }

  function updateToolbar() {
    document.querySelectorAll("[data-preview]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.preview === mode));
    });
  }

  function updateBadge() {
    const badge = SF.$("exportPreviewBadge");
    if (!badge) return;
    if (mode === "auto") {
      badge.hidden = true;
      badge.textContent = "";
    } else {
      badge.hidden = false;
      badge.textContent = mode === "dark" ? "Dark preview" : "Light preview";
    }
  }

  function setMode(next, opts = {}) {
    if (next !== "light" && next !== "dark" && next !== "auto") next = "auto";
    mode = next;
    try { localStorage.setItem(STORAGE_KEY, mode); } catch (_) {}
    updateToolbar();
    updateBadge();
    const doc = currentDoc();
    if (doc) applyPreviewMode(doc, mode);
    if (SF.compare && SF.compare.refreshPreview) SF.compare.refreshPreview();
    if (!opts.silent) {
      const label = mode === "auto" ? "Design preview: Auto" : `Design preview: ${mode[0].toUpperCase() + mode.slice(1)}`;
      if (SF.toast) SF.toast(label);
    }
  }

  function afterRender(doc) {
    if (!doc) return;
    applyPreviewMode(doc, mode);
    updateToolbar();
    updateBadge();
  }

  SF.hooks.afterRender.push(afterRender);
  SF.hooks.render.push(afterRender);
  SF.hooks.overlay.push(updateBadge);

  document.querySelectorAll("[data-preview]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.preview));
  });

  const exportButton = SF.$("exportButton");
  if (exportButton) exportButton.addEventListener("click", () => setTimeout(updateBadge, 0));

  updateToolbar();
  updateBadge();

  SF.preview = {
    applyPreviewMode,
    stripClone,
    getMode: () => mode,
    setMode,
    refresh: () => afterRender(currentDoc()),
    storageKey: STORAGE_KEY,
  };
}());
