/* Stillframe — drag and drop files, image placement, HTML import */
(function () {
  "use strict";
  const SF = window.Stillframe;
  if (!SF) return;
  const { $, toast, toastAction } = SF;

  const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"];
  const FONT_EXT = ["ttf", "otf", "woff", "woff2"];
  let dragDepth = 0;
  let overlayVisible = false;
  let frameCounter = 0;

  function extOf(name) {
    const parts = String(name || "").toLowerCase().split(".");
    return parts.length > 1 ? parts.pop() : "";
  }

  function hasFiles(e) {
    const dt = e.dataTransfer;
    if (!dt) return false;
    try { return Array.from(dt.types || []).includes("Files"); } catch (_) { return false; }
  }

  function overlay() { return $("dropOverlay"); }

  function showOverlay() {
    const node = overlay();
    if (!node || overlayVisible) return;
    overlayVisible = true;
    node.hidden = false;
  }

  function hideOverlay() {
    const node = overlay();
    overlayVisible = false;
    dragDepth = 0;
    if (node) node.hidden = true;
  }

  function overCanvas(e) {
    const wrap = SF.els.canvasWrap;
    if (!wrap) return false;
    const r = wrap.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  function pointFromClient(clientX, clientY) {
    const frame = SF.els.frame;
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    const scale = rect.width / Math.max(1, frame.clientWidth || SF.state.pageWidth || rect.width);
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale,
    };
  }

  function setSpinner(on, label) {
    SF.setLoading(on, label || "Processing file…");
  }

  async function withSpinner(task) {
    let timer = null;
    let shown = false;
    timer = setTimeout(() => {
      shown = true;
      setSpinner(true);
    }, 300);
    try {
      return await task({
        stop() {
          clearTimeout(timer);
          if (shown) { shown = false; setSpinner(false); }
        },
      });
    } finally {
      clearTimeout(timer);
      if (shown) setSpinner(false);
    }
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = src;
    });
  }

  async function maybeDownscale(dataUri, file, ext) {
    if (ext === "svg" || ext === "gif") return dataUri;
    try {
      const img = await loadImage(dataUri);
      const biggest = Math.max(img.naturalWidth, img.naturalHeight);
      if (biggest <= 2048 && file.size <= 3 * 1024 * 1024) return dataUri;
      const scale = Math.min(1, 2048 / biggest);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const keepAlpha = ext === "png" || ext === "webp" || ext === "avif";
      return canvas.toDataURL(keepAlpha ? "image/png" : "image/jpeg", 0.9);
    } catch (_) {
      return dataUri;
    }
  }

  function selectAndCommit(el, key) {
    try { SF.selectElement(el, { silent: true }); } catch (_) {}
    SF.afterMutation(key, true);
  }

  function insertImage(dataUri, point) {
    const doc = SF.state.doc;
    if (!doc || !doc.body) { toast("Open a document before adding an image.", true); return null; }
    let target = null;
    if (point) {
      const x = Math.max(0, Math.min(doc.documentElement.clientWidth - 1, point.x));
      const y = Math.max(0, Math.min(doc.documentElement.clientHeight - 1, point.y));
      try { target = doc.elementFromPoint(x, y); } catch (_) {}
    }
    if (!target) target = SF.getSelection() || doc.body;
    if (target && (target.ownerDocument !== doc || !target.isConnected)) target = doc.body;
    if (target === doc.documentElement) target = doc.body;
    if (target && target.tagName === "IMG") {
      target.src = dataUri;
      selectAndCommit(target, "drop-image");
      toast("Image replaced.");
      return target;
    }
    if (!target) target = doc.body;
    if (target.tagName === "HTML") target = doc.body;
    const img = doc.createElement("img");
    img.src = dataUri;
    img.alt = "";
    img.setAttribute("style", "max-width:100%;height:auto;display:block");
    target.appendChild(img);
    selectAndCommit(img, "drop-image");
    toast("Image added.");
    return img;
  }

  function flashOpened(name) {
    let done = false;
    const show = () => {
      if (done) return;
      done = true;
      const i = SF.hooks.finalize.indexOf(show);
      if (i >= 0) SF.hooks.finalize.splice(i, 1);
      toastAction("Opened " + name + ".", "Undo", () => SF.undo());
    };
    SF.hooks.finalize.push(show);
    setTimeout(show, 5000);
  }

  async function importHtml(file) {
    let text = "";
    try { text = await file.text(); } catch (_) {
      toast("That file could not be read.", true);
      return;
    }
    if (!text.trim()) {
      toast("That file is empty.", true);
      return;
    }
    if (SF.state.ready && SF.history) {
      try { await SF.history.snapshot("before-import", "Before import", { force: true }); } catch (_) {}
    }
    const name = file.name || "imported.html";
    flashOpened(name);
    SF.loadDocument(text, {
      filename: name,
      resetHistory: false,
      pushHistory: "import",
      selectionPath: [],
      original: true,
      loadingText: "Opening HTML…",
    });
    if (window.innerWidth <= 900) SF.closeMobilePanels();
  }

  async function importImage(file, point) {
    const ext = extOf(file.name);
    let uri;
    try { uri = await readAsDataURL(file); } catch (_) {
      toast("That image couldn't be read: " + file.name, true);
      return;
    }
    uri = await maybeDownscale(uri, file, ext);
    insertImage(uri, point);
  }

  async function handleFiles(fileList, point) {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    hideOverlay();
    await withSpinner(async (spinner) => {
      let openedHtml = false;
      for (const file of files) {
        const ext = extOf(file.name);
        const type = String(file.type || "").toLowerCase();
        if (!openedHtml && (ext === "html" || ext === "htm" || type === "text/html")) {
          openedHtml = true;
          spinner.stop();
          await importHtml(file);
          continue;
        }
        if (type.startsWith("image/") || IMAGE_EXT.includes(ext)) {
          await importImage(file, point);
          continue;
        }
        if (FONT_EXT.includes(ext)) {
          if (SF.fonts && SF.fonts.uploadFiles) await SF.fonts.uploadFiles([file]);
          else toast("Fonts are not available in this build.", true);
          continue;
        }
        if (type === "text/plain" || ext === "txt") {
          toast("Unsupported file: " + file.name, true);
          continue;
        }
        toast("Unsupported file: " + file.name, true);
      }
    });
  }

  function attachFrame(doc) {
    if (!doc || !doc.documentElement) return;
    const enter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      showOverlay();
    };
    const over = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
      showOverlay();
    };
    const leave = (e) => {
      if (!hasFiles(e)) return;
      dragDepth--;
      if (dragDepth <= 0) hideOverlay();
    };
    const drop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const point = pointFromClient(e.clientX, e.clientY);
      hideOverlay();
      handleFiles(e.dataTransfer.files, point);
    };
    doc.addEventListener("dragenter", enter, true);
    doc.addEventListener("dragover", over, true);
    doc.addEventListener("dragleave", leave, true);
    doc.addEventListener("drop", drop, true);
  }

  function bind() {
    window.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      showOverlay();
    }, true);
    window.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
      showOverlay();
    }, true);
    window.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      dragDepth--;
      if (dragDepth <= 0) hideOverlay();
    }, true);
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const point = overCanvas(e) ? pointFromClient(e.clientX, e.clientY) : null;
      hideOverlay();
      handleFiles(e.dataTransfer.files, point);
    }, true);

    const input = $("sf-file-input");
    if (input) {
      input.addEventListener("change", () => {
        const files = input.files ? Array.from(input.files) : [];
        input.value = "";
        handleFiles(files, null);
      });
    }

    SF.escHandlers.push({
      priority: 90,
      fn: () => {
        if (!overlayVisible) return false;
        hideOverlay();
        return true;
      },
    });

    SF.hooks.render.push(attachFrame);
  }

  bind();

  SF.dropzone = {
    handleFiles,
    attachFrame,
    pointFromClient,
    isOverlayVisible: () => overlayVisible,
  };
}());
