/*
 * Stillframe feature suite — runs directly against index.html over file://.
 *
 * Run with:
 *   node tests/features.spec.js
 *
 * Uses playwright-core (installed next to this project or in the usual
 * Playwright temp folder) and a local Chrome install. Screenshots are written
 * to tests/screenshots/.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const APP_URL = pathToFileURL(path.join(ROOT, "index.html")).href;
const FIXTURES = path.join(__dirname, "fixtures");
const SHOTS = path.join(__dirname, "screenshots");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "stillframe-tests-"));
fs.mkdirSync(SHOTS, { recursive: true });

function loadPlaywrightCore() {
  try { return require("playwright-core"); } catch (_) {}
  const fallback = path.join(os.tmpdir(), "stillframe-pw", "node_modules", "playwright-core");
  return require(fallback);
}
const { chromium } = loadPlaywrightCore();

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

let browser;
let passed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || "values differ"} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function includes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) throw new Error(`${message || "missing text"} (${JSON.stringify(needle)})`);
}
function excludes(haystack, needle, message) {
  if (String(haystack).includes(needle)) throw new Error(`${message || "unexpected text"} (${JSON.stringify(needle)})`);
}
function near(actual, expected, tolerance, message) {
  if (Math.abs(Number(actual) - Number(expected)) > tolerance) throw new Error(`${message || "not near"} (expected ${expected} ±${tolerance}, got ${actual})`);
}

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`FAIL  ${name}\n      ${err && err.stack ? err.stack.split("\n").slice(0, 5).join("\n      ") : err}`);
  }
}

function collectErrors(page, label) {
  const errors = [];
  page.on("pageerror", (err) => errors.push(`${label}: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Chrome emits this for sandboxed srcdoc thumbnails when a snapshot has a
    // user <script>; it is a browser notice, not an app failure.
    if (/Blocked script execution in 'about:srcdoc'/.test(text)) return;
    errors.push(`${label}: ${text}`);
  });
  return errors;
}

async function newContext(viewport = { width: 1440, height: 900 }) {
  return browser.newContext({ viewport, acceptDownloads: true });
}

async function openApp(context, opts = {}) {
  const page = await context.newPage();
  const errors = collectErrors(page, opts.label || "app");
  await page.goto(APP_URL);
  await page.waitForFunction(() => window.Stillframe && Stillframe.state, null, { timeout: 20000 });
  if (opts.empty) {
    await page.waitForSelector("#emptyState:not([hidden])", { timeout: 5000 });
  } else {
    await page.locator("#loadSample").click();
    await page.waitForFunction(() => Stillframe.state.ready, null, { timeout: 20000 });
  }
  await page.waitForTimeout(500);
  page._featureErrors = errors;
  return page;
}

async function resumeApp(page) {
  await page.waitForFunction(() => window.Stillframe && Stillframe.state, null, { timeout: 20000 });
  await page.waitForFunction(() => Stillframe.state.ready || !document.getElementById("emptyState").hidden, null, { timeout: 5000 });
  if (await page.locator("#emptyState").isVisible()) {
    await page.locator("#loadSample").click();
    await page.waitForFunction(() => Stillframe.state.ready, null, { timeout: 20000 });
  }
  await page.waitForTimeout(500);
}

function frame(page) {
  return page.locator("#previewFrame").contentFrame();
}

async function importHtml(page, html, name = "test-page.html") {
  const file = path.join(TEMP, `${Date.now()}-${Math.random().toString(16).slice(2)}-${name}`);
  fs.writeFileSync(file, html);
  await page.locator("#sf-file-input").setInputFiles(file);
  await page.waitForTimeout(1500);
  return file;
}

async function selectFrameElement(page, selector) {
  const locator = frame(page).locator(selector).first();
  await locator.click();
  await page.waitForTimeout(250);
  return locator;
}

async function openExport(page) {
  if (!(await page.locator("#exportPopover").isVisible())) {
    await page.locator("#exportButton").click();
    await page.waitForTimeout(220);
  }
}

async function clearToasts(page) {
  await page.evaluate(() => document.querySelectorAll(".toast").forEach((node) => node.remove()));
  await page.waitForTimeout(100);
}

async function closeExport(page) {
  if (await page.locator("#exportPopover").isVisible()) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
}

async function appState(page) {
  return page.evaluate(() => ({
    ready: Stillframe.state.ready,
    sel: Stillframe.state.selectionEl && Stillframe.state.selectionEl.tagName,
    histLength: Stillframe.state.history.length,
    histIndex: Stillframe.state.historyIndex,
  }));
}

const SCHEME_HTML = `<!doctype html>
<html class="dark" data-theme="dark">
<head><meta charset="utf-8">
<style>
body{background:#ffffff;color:#111;font-family:Arial,sans-serif;margin:20px}
.box{padding:20px;border:2px solid #ccc}
@media (prefers-color-scheme: light){body{background:#fafafa;color:#111}}
@media (prefers-color-scheme: dark){body{background:#101010;color:#f5f5f5}}
html.dark body{background:#202020}
[data-theme="dark"] .box{border-color:#444}
</style></head>
<body><h1>Scheme test</h1><div class="box">Box content</div></body></html>`;

const UPLOADED_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body{background:#fff;color:#111;font-family:"Brand Custom",sans-serif;margin:20px}
h1{font-size:40px}
</style></head><body><h1>Uploaded font page</h1><p>Brand Custom is used here.</p></body></html>`;

const IMPORTED_HTML = `<!doctype html>
<html class="dark"><head><meta charset="utf-8"><style>
body{background:#111;color:#fff;font-family:Georgia,serif}
h1{font-size:42px}
@media (prefers-color-scheme: light){body{background:#fafafa;color:#111}}
@media (prefers-color-scheme: dark){body{background:#101418;color:#f5f5f5}}
</style></head><body><h1>Imported page</h1><p>Hello there.</p></body></html>`;

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=";

const CHART_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0} body{background:#101010}
svg{display:block;width:420px;height:220px}
.grid{stroke:#2b2b2b;stroke-width:1}
.area{fill:url(#areaFill)}
.line{fill:none;stroke:#ff4d1f;stroke-width:4;stroke-linecap:round}
.dot{fill:#20d98c}
.pill{fill:#20d98c}
.label{fill:#fff;font:bold 14px Arial}
.stop-a{stop-color:#ff4d1f;stop-opacity:.45} .stop-b{stop-color:#ff4d1f;stop-opacity:0}
</style></head><body>
<svg viewBox="0 0 420 220" role="img" aria-label="Revenue chart">
<defs><linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1"><stop class="stop-a" offset="0"/><stop class="stop-b" offset="1"/></linearGradient></defs>
<line class="grid" x1="20" y1="40" x2="400" y2="40"/>
<path class="area" d="M20 150 L100 100 L180 130 L260 60 L340 90 L400 30 L400 200 L20 200 Z"/>
<path class="line" d="M20 150 L100 100 L180 130 L260 60 L340 90 L400 30"/>
<circle class="dot" cx="400" cy="30" r="6"/>
<rect class="pill" x="330" y="4" width="60" height="22" rx="5"/>
<text class="label" x="360" y="19" text-anchor="middle">84k</text>
</svg></body></html>`;

async function main() {
  browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
    args: ["--allow-file-access-from-files", "--disable-web-security"],
  });

  await test("boots directly from file:// with an import prompt and no runtime errors", async () => {
    const context = await newContext();
    const page = await openApp(context, { empty: true });
    assert(await page.title() !== "", "page title is empty");
    equal(await page.evaluate(() => Stillframe.state.ready), false, "editor starts without a file");
    assert(await page.locator("#emptyState").isVisible(), "startup prompt is visible");
    const prompt = await page.locator("#emptyState").innerText();
    includes(prompt, "Open an HTML file to begin", "startup prompt asks for a file");
    assert(await page.locator("#emptyOpen").isVisible(), "open-file action is available");
    assert(await page.locator("#loadSample").isVisible(), "sample action is available");
    equal(await page.locator("#fileName").inputValue(), "Untitled", "no default file name");
    equal(await frame(page).locator("h1").count(), 0, "no default document is loaded");
    await page.locator("#loadSample").click();
    await page.waitForFunction(() => Stillframe.state.ready, null, { timeout: 20000 });
    equal(await frame(page).locator("h1").count(), 1, "sample can still be opened on demand");
    equal(await page.locator("[data-preview]").count(), 3, "three design preview buttons");
    equal(await page.locator("#compareButton").count(), 1, "compare control");
    equal(await page.locator("#historyTab").count(), 1, "history tab");
    equal(await page.locator("#fontPickerButton").count(), 0, "font button appears after selecting text");
    equal(page._featureErrors.length, 0, "no startup console errors: " + page._featureErrors.join(" | "));
    await context.close();
  });

  await test("core selection, layers, inspector, code and undo/redo still work", async () => {
    const context = await newContext();
    const page = await openApp(context);
    const h1 = await selectFrameElement(page, "h1");
    equal(await page.evaluate(() => Stillframe.state.selectionEl.tagName), "H1", "h1 selected");
    includes(await page.locator("#inspectorBody").innerText(), "Typography", "typography inspector");
    const originalSize = await h1.evaluate((el) => getComputedStyle(el).fontSize);
    await page.locator("#fontSizeInput").fill("48");
    await page.locator("#fontSizeInput").press("Enter");
    await page.waitForTimeout(500);
    equal(await h1.evaluate((el) => getComputedStyle(el).fontSize), "48px", "inspector font size applies");
    await page.locator("#undoButton").click();
    await page.waitForTimeout(1000);
    equal(await h1.evaluate((el) => getComputedStyle(el).fontSize), originalSize, "undo restores font size");
    await page.locator("#redoButton").click();
    await page.waitForTimeout(900);
    equal(await h1.evaluate((el) => getComputedStyle(el).fontSize), "48px", "redo reapplies font size");

    await page.locator("#layersTab").click();
    await page.waitForTimeout(250);
    assert((await page.locator(".layer-row").count()) > 0, "layers list renders");
    await page.locator(".layer-row").filter({ hasText: "h1" }).first().click();
    equal(await page.evaluate(() => Stillframe.state.selectionEl.tagName), "H1", "layer selection selects h1");

    await page.locator("#codeTab").click();
    await page.waitForTimeout(250);
    includes(await page.locator("#codeInput").inputValue(), "<h1", "code tab shows source");
    const codeValue = await page.locator("#codeInput").inputValue();
    await page.locator("#codeInput").fill(codeValue.replace("Scheduled for the next 30 days", "Edited in code"));
    await page.locator("#applyCode").click();
    await page.waitForTimeout(1200);
    excludes(await page.locator("#codeInput").inputValue(), "data-sf-", "code has no editor artifacts");
    await context.close();
  });

  await test("design preview rewrites schemes, persists separately from app theme, and never leaks into source", async () => {
    const context = await newContext();
    const page = await openApp(context);
    await importHtml(page, SCHEME_HTML, "scheme.html");
    const f = frame(page);
    const info = async () => ({
      bg: await f.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor),
      color: await f.locator("h1").evaluate((el) => getComputedStyle(el).color),
      cls: await f.locator("html").getAttribute("class"),
      theme: await f.locator("html").getAttribute("data-theme"),
      scheme: await f.locator("html").evaluate((el) => el.style.colorScheme),
      border: await f.locator(".box").evaluate((el) => getComputedStyle(el).borderTopColor),
    });
    const auto = await info();
    equal(auto.bg, "rgb(32, 32, 32)", "auto uses authored dark mode");
    equal(auto.theme, "dark", "auto preserves authored data-theme");

    await page.locator("[data-preview=light]").click();
    await page.waitForTimeout(350);
    const light = await info();
    equal(light.bg, "rgb(250, 250, 250)", "light preview rewrites the dark media rule");
    equal(light.color, "rgb(17, 17, 17)", "light preview text color");
    equal(light.cls, "", "forced light removes class dark");
    equal(light.theme, "light", "forced light updates data-theme");
    equal(light.scheme, "light", "forced light sets color-scheme");
    equal(light.border, "rgb(204, 204, 204)", "attribute theme rule no longer matches");
    const codeLight = await page.locator("#codeInput").inputValue();
    excludes(codeLight, 'data-theme="light"', "preview data-theme does not reach code");
    assert(!/<html[^>]*style="[^"]*color-scheme/i.test(codeLight), "preview color-scheme does not reach code");
    includes(codeLight, 'data-theme="dark"', "authored data-theme is preserved in code");
    await clearToasts(page);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, "desktop-light.png") });

    await page.locator("[data-preview=dark]").click();
    await page.waitForTimeout(350);
    const dark = await info();
    equal(dark.bg, "rgb(32, 32, 32)", "dark preview uses authored dark class");
    equal(dark.color, "rgb(245, 245, 245)", "dark preview uses dark media rule");
    equal(dark.scheme, "dark", "forced dark sets color-scheme");
    assert(!/<html[^>]*style="[^"]*color-scheme/i.test(await page.locator("#codeInput").inputValue()), "dark preview does not reach code");

    await page.locator("[data-preview=auto]").click();
    await page.waitForTimeout(350);
    const restored = await info();
    equal(restored.cls, "dark", "auto restores class");
    equal(restored.theme, "dark", "auto restores data-theme");
    equal(restored.scheme, "", "auto removes preview color-scheme");

    await page.locator("[data-preview=dark]").click();
    await page.waitForTimeout(200);
    equal(await page.evaluate(() => localStorage.getItem("stillframe-preview-mode")), "dark", "preview stored separately");
    await page.reload();
    await resumeApp(page);
    equal(await page.locator("[data-preview=dark]").getAttribute("aria-pressed"), "true", "preview survives reload");
    const appThemeBefore = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    await page.locator("#themeToggle").click();
    await page.waitForTimeout(300);
    assert(appThemeBefore !== await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "app theme toggles");
    equal(await page.locator("[data-preview=dark]").getAttribute("aria-pressed"), "true", "app theme does not alter design preview");
    equal(await page.evaluate(() => localStorage.getItem("stillframe-preview-mode")), "dark", "preview key untouched by app theme");
    await context.close();
  });

  await test("history saves, renames, pins, restores, undoes, deletes, groups and thumbnails", async () => {
    const context = await newContext();
    const page = await openApp(context);
    const h1 = frame(page).locator("h1");
    await page.locator("#historyTab").click();
    await page.locator(".history-row").first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(250);
    includes(await page.locator("#historyList").textContent(), "Today", "versions grouped by day");
    includes(await page.locator("#historyList").textContent(), "Original", "original version is recorded");

    await page.locator("#saveVersionButton").click();
    await page.locator("#versionNameInput").fill("Version A");
    await page.locator("#versionNameForm button[type=submit]").click();
    await page.waitForTimeout(700);
    let rec = await page.evaluate(() => Stillframe.history.list().find((v) => v.name === "Version A"));
    assert(rec, "manual version saved");
    equal(rec.pinned, false, "manual version starts unpinned");
    equal(rec.kind, "manual", "manual version kind");
    const htmlSnapshot = rec.html;
    excludes(htmlSnapshot, "data-sf-", "snapshot has no editor artifacts");
    excludes(htmlSnapshot, "contenteditable", "snapshot has no contenteditable");

    const rowA = page.locator(".history-row", { hasText: "Version A" }).first();
    await rowA.hover();
    await rowA.locator("[data-action=rename]").click();
    await page.locator(".history-rename").fill("Version B");
    await page.locator(".history-rename").press("Enter");
    await page.waitForTimeout(400);
    assert(await page.locator(".history-row", { hasText: "Version B" }).count(), "renamed row present");
    await page.locator(".toast-action").last().click();
    await page.waitForTimeout(350);
    assert(await page.locator(".history-row", { hasText: "Version A" }).count(), "rename undo");

    const rowPin = page.locator(".history-row", { hasText: "Version A" }).first();
    await rowPin.hover();
    await rowPin.locator("[data-action=pin]").click();
    await page.waitForTimeout(300);
    equal(await page.evaluate(() => Stillframe.history.list().find((v) => v.name === "Version A").pinned), true, "pin sets persisted flag");
    await page.locator(".toast-action").last().click();
    await page.waitForTimeout(250);
    equal(await page.evaluate(() => Stillframe.history.list().find((v) => v.name === "Version A").pinned), false, "pin undo");

    await h1.dblclick();
    await page.waitForTimeout(200);
    await h1.evaluate((el) => { el.textContent = "Changed headline"; });
    await h1.press("Enter");
    await page.waitForTimeout(700);
    await page.evaluate(() => Stillframe.history.flushForTest());
    await page.waitForTimeout(700);
    const rowRestore = page.locator(".history-row", { hasText: "Version A" }).first();
    await rowRestore.hover();
    await rowRestore.locator("[data-action=restore]").click();
    await page.waitForTimeout(1800);
    includes(await h1.innerText(), "Upcoming payments", "restore returns saved text");
    assert(await page.evaluate(() => Stillframe.history.list().some((v) => v.kind === "before-restore")), "before-restore snapshot recorded");
    await page.locator(".toast-action").last().click();
    await page.waitForTimeout(1000);
    includes(await h1.innerText(), "Changed headline", "undo of restore returns to edited text");

    await page.waitForTimeout(900);
    const thumbs = await page.locator(".history-thumb").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("src") || ""));
    assert(thumbs.some((src) => src.startsWith("data:image/jpeg")), "async JPG thumbnails render");

    const rowDelete = page.locator(".history-row", { hasText: "Version A" }).first();
    await rowDelete.hover();
    await rowDelete.locator("[data-action=delete]").click();
    await page.waitForTimeout(350);
    equal(await page.locator(".history-row", { hasText: "Version A" }).count(), 0, "delete removes version");
    await page.locator(".toast-action").last().click();
    await page.waitForTimeout(350);
    equal(await page.locator(".history-row", { hasText: "Version A" }).count(), 1, "delete undo restores version");
    equal(page._featureErrors.length, 0, "no console errors: " + page._featureErrors.join(" | "));
    await context.close();
  });

  await test("history dedupes autos, caps them at 40, keeps manuals, and H opens history from canvas", async () => {
    const context = await newContext();
    const page = await openApp(context);
    await page.evaluate(() => Stillframe.history.snapshot("manual", "Keep me", { force: true }));
    const dedupe = await page.evaluate(async () => {
      const before = Stillframe.history.list().length;
      const first = await Stillframe.history.snapshot("auto", null, { html: "<!doctype html><html><body><p>dedupe</p></body></html>" });
      const second = await Stillframe.history.snapshot("auto", null, { html: "<!doctype html><html><body><p>dedupe</p></body></html>" });
      return { before, after: Stillframe.history.list().length, first: !!first, second: !!second };
    });
    equal(dedupe.first, true, "first auto saved");
    equal(dedupe.second, false, "second identical auto deduped");
    equal(dedupe.after, dedupe.before + 1, "dedupe creates one version");

    await page.evaluate(async () => {
      for (let i = 0; i < 44; i++) {
        await Stillframe.history.snapshot("auto", null, { force: true, html: `<!doctype html><html><body><p>auto ${i}</p></body></html>` });
      }
    });
    await page.waitForTimeout(700);
    const counts = await page.evaluate(() => {
      const list = Stillframe.history.list();
      return { autos: list.filter((v) => v.kind === "auto").length, manual: list.filter((v) => v.name === "Keep me").length };
    });
    equal(counts.autos, 40, "auto snapshots capped at 40");
    equal(counts.manual, 1, "manual snapshots survive pruning");

    await frame(page).locator("h1").click();
    await page.locator("#layersTab").click();
    await page.waitForTimeout(200);
    await page.keyboard.press("h");
    await page.waitForTimeout(350);
    equal(await page.locator("#historyTab").getAttribute("aria-selected"), "true", "H opens history from canvas");
    await page.locator("#layersTab").click();
    await page.locator("#fileName").focus();
    await page.keyboard.press("h");
    await page.waitForTimeout(200);
    equal(await page.locator("#layersTab").getAttribute("aria-selected"), "true", "H is ignored while typing in inputs");
    await context.close();
  });

  await test("compare stacks a baseline, pauses editing, supports pointer/keyboard/Esc and preview parity", async () => {
    const context = await newContext();
    const page = await openApp(context);
    await importHtml(page, SCHEME_HTML, "compare.html");
    await page.locator("[data-preview=dark]").click();
    await page.waitForTimeout(300);
    await page.locator("#historyTab").click();
    await page.locator("#saveVersionButton").click();
    await page.locator("#versionNameInput").fill("Manual baseline");
    await page.locator("#versionNameForm button[type=submit]").click();
    await page.waitForTimeout(600);
    const originalId = await page.evaluate(() => Stillframe.history.list().find((v) => v.kind === "original").id);
    const manualId = await page.evaluate(() => Stillframe.history.list().find((v) => v.name === "Manual baseline").id);

    await page.locator("#compareButton").click();
    await page.waitForTimeout(1200);
    equal(await page.evaluate(() => Stillframe.compare.isActive()), true, "compare active");
    equal(await page.locator("#compareBaseline").inputValue(), originalId, "default baseline is Original");
    equal(await page.locator(".compare-before-frame").count(), 1, "before iframe present");
    equal(await page.locator(".compare-before-frame").evaluate((el) => el.parentElement.id), "artboard", "before iframe stacks inside zoom artboard");
    equal(await page.locator(".compare-pill").first().innerText(), "Before", "before pill");
    equal(await page.locator(".compare-pill").last().innerText(), "After", "after pill");
    const before = page.locator(".compare-before-frame");
    equal(await before.contentFrame().locator("body").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(32, 32, 32)", "baseline inherits dark preview");
    assert((await before.evaluate((el) => el.style.clipPath)).startsWith("inset(0px 50%"), "clip-path split at 50");

    const h1 = frame(page).locator("h1");
    const selectionBefore = await page.evaluate(() => Stillframe.state.selectionEl.tagName);
    const box = await h1.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(250);
    equal(await page.evaluate(() => Stillframe.state.selectionEl.tagName), selectionBefore, "editing paused under compare shield");

    const handle = page.locator(".compare-handle");
    const hb = await handle.boundingBox();
    if (hb) {
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      await page.mouse.move(hb.x + 220, hb.y + hb.height / 2, { steps: 6 });
      await page.mouse.up();
    }
    await page.waitForTimeout(200);
    assert(Math.abs(await page.evaluate(() => Stillframe.compare.getSplit()) - 50) > 1, "pointer drag moves split");
    await handle.focus();
    await page.keyboard.press("Home");
    equal(await page.evaluate(() => Stillframe.compare.getSplit()), 0, "Home sets split to 0");
    await page.keyboard.press("ArrowRight");
    equal(await page.evaluate(() => Stillframe.compare.getSplit()), 2, "arrow key nudges split");
    await page.keyboard.press("End");
    equal(await page.evaluate(() => Stillframe.compare.getSplit()), 100, "End sets split to 100");

    await page.locator("#compareBaseline").selectOption(manualId);
    await page.waitForTimeout(800);
    equal(await page.locator("#compareBaseline").inputValue(), manualId, "baseline can switch to a manual version");
    equal(await before.contentFrame().locator("h1").innerText(), "Scheme test", "before iframe reloads selected baseline");
    await page.evaluate(() => Stillframe.compare.setSplit(50));
    await page.locator("#themeToggle").click();
    await clearToasts(page);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, "desktop-dark.png") });
    await handle.focus();
    await page.keyboard.press("c");
    await page.waitForTimeout(350);
    equal(await page.evaluate(() => Stillframe.compare.isActive()), false, "C exits compare");
    await frame(page).locator("h1").click();
    await page.waitForTimeout(200);
    await page.keyboard.press("c");
    await page.waitForTimeout(900);
    equal(await page.evaluate(() => Stillframe.compare.isActive()), true, "C enters compare while canvas focused");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    equal(await page.evaluate(() => Stillframe.compare.isActive()), false, "Esc exits compare");
    equal(page._featureErrors.length, 0, "no console errors: " + page._featureErrors.join(" | "));
    await context.close();
  });

  await test("drag/drop accepts HTML, images and unsupported files without navigating", async () => {
    const context = await newContext();
    const page = await openApp(context);
    const startUrl = page.url();
    let f = frame(page);
    const dropData = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "x.png", { type: "image/png" }));
      return dt;
    });
    await page.dispatchEvent("#canvasWrap", "dragenter", { dataTransfer: dropData });
    await page.waitForTimeout(250);
    assert(await page.locator("#dropOverlay").isVisible(), "global drag overlay appears");
    await page.dispatchEvent("#canvasWrap", "dragleave", { dataTransfer: dropData });
    await page.waitForTimeout(250);
    assert(await page.locator("#dropOverlay").isHidden(), "drag overlay hides on leave");

    const historyBefore = await page.evaluate(() => Stillframe.state.history.length);
    await page.locator("#sf-file-input").setInputFiles(path.join(FIXTURES, "drop-test.png"));
    await page.waitForTimeout(1600);
    f = frame(page);
    equal(await f.locator("img").count(), 1, "dropped image inserted");
    equal(await f.locator("img").first().evaluate((el) => el.naturalWidth), 2048, "large image downscaled to 2048");
    equal((await page.evaluate(() => Stillframe.state.history.length)) - historyBefore, 1, "image insert is one undo step");
    includes(await page.locator("#codeInput").inputValue(), "[sf-asset-1]", "code shortens data URI into a token");
    excludes(await page.evaluate(() => Stillframe.serializeClean()), "[sf-asset-", "token never reaches serialized HTML");
    assert((await page.evaluate(() => Stillframe.serializeClean())).includes("data:image/png;base64,"), "clean HTML keeps real URI");
    assert(await page.evaluate(() => Stillframe.state.history.every((h) => !h.html.includes("[sf-asset-"))), "token never reaches undo history");
    await page.evaluate(() => Stillframe.undo());
    await page.waitForTimeout(1200);
    equal(await f.locator("img").count(), 0, "undo removes dropped image in one step");

    await page.locator("#sf-file-input").setInputFiles(path.join(FIXTURES, "drop-test.png"));
    await page.waitForTimeout(1400);
    f = frame(page);
    const oldSrc = await f.locator("img").first().getAttribute("src");
    const point = await f.locator("img").first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.evaluate(async ({ b64, point }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], "tiny.png", { type: "image/png" });
      await Stillframe.dropzone.handleFiles([file], point);
    }, { b64: TINY_PNG, point });
    await page.waitForTimeout(900);
    equal(await f.locator("img").count(), 1, "image at point replaces instead of inserting another");
    assert(oldSrc !== await f.locator("img").first().getAttribute("src"), "replacement image source changed");
    includes(await page.locator("#toastRegion").innerText(), "Image replaced.", "replace toast");
    assert(await page.evaluate(() => Stillframe.state.history.some((h) => h.html.includes("<img"))), "replacement recorded in history");

    await page.evaluate(async (html) => {
      const doc = document.getElementById("previewFrame").contentDocument;
      const dt = new DataTransfer();
      dt.items.add(new File([html], "dropped.html", { type: "text/html" }));
      doc.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 700, clientY: 300 }));
    }, IMPORTED_HTML);
    await page.waitForTimeout(1700);
    f = frame(page);
    equal(await f.locator("h1").innerText(), "Imported page", "HTML drop opens the document");
    equal(await page.url(), startUrl, "dropping HTML never navigates the browser");
    assert(await page.evaluate(() => Stillframe.history.list().some((v) => v.kind === "before-import")), "before-import snapshot recorded");
    includes(await page.locator("#toastRegion").innerText(), "Opened", "import toast");
    await page.locator(".toast-action").last().click();
    await page.waitForTimeout(1000);
    equal(await frame(page).locator("h1").innerText(), "Upcoming payments", "import toast undo returns previous document");

    await page.evaluate(() => Stillframe.dropzone.handleFiles([new File(["x"], "archive.zip", { type: "application/zip" })], null));
    await page.waitForTimeout(350);
    includes(await page.locator("#toastRegion").innerText(), "Unsupported file", "unsupported file toast");
    equal(page.url(), startUrl, "browser still did not navigate");
    equal(page._featureErrors.length, 0, "no console errors: " + page._featureErrors.join(" | "));
    await context.close();
  });

  await test("font picker searches, filters, previews, adds and applies Google fonts", async () => {
    const context = await newContext();
    const page = await openApp(context);
    const h1 = await selectFrameElement(page, "h1");
    const catalogue = await page.evaluate(() => Stillframe.fonts.catalogue().length);
    assert(catalogue >= 150, "curated catalogue has about 150 fonts");
    await page.locator("#fontPickerButton").click();
    await page.waitForTimeout(350);
    assert(await page.locator("#fontPopover").isVisible(), "font popover opens");

    await page.locator("#fontSearch").fill("Abril");
    await page.waitForTimeout(300);
    assert(await page.locator(".font-row", { hasText: "Abril Fatface" }).count(), "search filters fonts");
    const row = page.locator(".font-row", { hasText: "Abril Fatface" }).first();
    await row.hover();
    await page.waitForTimeout(500);
    includes(await h1.getAttribute("style") || "", "Abril Fatface", "hover previews the font on the selection");
    await page.mouse.move(10, 10);
    await page.waitForTimeout(300);

    await page.locator("#fontSearch").fill("");
    await page.locator("[data-font-category=serif]").click();
    await page.waitForTimeout(300);
    assert((await page.locator(".font-row").count()) > 0, "serif category has rows");
    const metas = await page.locator(".font-row .font-row-meta").allTextContents();
    assert(metas.every((meta) => meta === "serif"), "category chip filters exclusively");

    await page.locator("[data-font-tab=system]").click();
    await page.waitForTimeout(300);
    assert((await page.locator(".font-row").count()) > 0, "system tab has rows");
    await page.locator("[data-font-tab=google]").focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(250);
    equal(await page.locator("[data-font-tab=uploaded]").getAttribute("aria-selected"), "true", "tab keyboard navigation");

    await page.locator("[data-font-tab=google]").click();
    await page.locator("#fontAddName").fill("B612");
    await page.locator("#fontAddName").press("Enter");
    await page.waitForFunction(
      () => document.querySelector(".font-row[data-font-family='B612']") || /Added B612/.test(document.getElementById("toastRegion").textContent || ""),
      null,
      { timeout: 15000 }
    );
    const addToast = await page.locator("#toastRegion").innerText();
    const addRow = await page.locator(".font-row[data-font-family='B612']").count();
    assert(addRow === 1 || addToast.includes("Added B612"), "add-by-name confirms: " + addToast);
    await page.locator(".font-row[data-font-family='B612']").waitFor({ timeout: 10000 });
    await page.locator(".font-row[data-font-family='B612']").click();
    await page.waitForFunction(() => Stillframe.state.doc.fonts.check('16px "B612"'), null, { timeout: 15000 });
    includes(await h1.getAttribute("style") || "", "B612", "added font applies to selection");
    equal(await page.evaluate(() => Stillframe.state.doc.fonts.check('16px "B612"')), true, "font is loaded before applying");
    await page.locator("#fontPickerButton").click();
    await page.waitForTimeout(300);
    assert((await page.locator("[data-recent-font]").allTextContents()).includes("B612"), "recent fonts list records applied font");
    await page.locator("#fontAddName").fill("DefinitelyNotARealGoogleFontZZZ");
    await page.locator("#fontAddName").press("Enter");
    await page.waitForTimeout(1200);
    assert(await page.locator(".toast.is-error").count(), "invalid Google font name shows an error");
    await page.keyboard.press("Escape");
    await page.locator("#fontWeightSelect").selectOption("700");
    await page.waitForTimeout(400);
    equal(await h1.evaluate((el) => getComputedStyle(el).fontWeight), "700", "font weight applies");
    await page.locator("#fontPickerButton").click();
    await page.locator("#fontSearch").fill("Inter");
    await page.waitForTimeout(250);
    await page.locator(".font-row[data-font-family='Inter']").first().click();
    await page.waitForTimeout(1200);
    await page.locator("#fontPickerButton").click();
    await page.waitForTimeout(250);
    await page.locator("#fontItalicToggle").click();
    await page.waitForTimeout(300);
    equal(await page.locator("#fontItalicToggle").getAttribute("aria-pressed"), "true", "italic toggle state");
    equal(await h1.evaluate((el) => getComputedStyle(el).fontStyle), "italic", "italic style applies");
    await context.close();
  });

  await test("uploaded fonts persist, auto-load on import/restore/compare, rename/delete undo, and embed in HTML export", async () => {
    const context = await newContext();
    const page = await openApp(context);
    const h1 = await selectFrameElement(page, "h1");
    await page.locator("#sf-file-input").setInputFiles(path.join(FIXTURES, "MyBrandTest-Regular.ttf"));
    await page.waitForTimeout(1600);
    equal(await page.evaluate(() => Stillframe.fonts.uploaded().length), 1, "font upload installed");
    await page.locator("#fontPickerButton").click();
    await page.locator("[data-font-tab=uploaded]").click();
    await page.waitForTimeout(300);
    await page.locator("[data-face-family]").first().fill("Brand Custom");
    await page.locator("[data-face-family]").first().press("Tab");
    await page.waitForTimeout(700);
    equal(await page.evaluate(() => Stillframe.fonts.uploaded()[0].family), "Brand Custom", "uploaded font renamed");
    await page.locator(".toast-action").last().click();
    await page.waitForTimeout(400);
    equal(await page.evaluate(() => Stillframe.fonts.uploaded()[0].family), "MyBrandTest", "font rename undo");
    await page.locator("#fontPickerButton").click();
    await page.locator("[data-font-tab=uploaded]").click();
    await page.waitForTimeout(300);
    await page.locator("[data-face-family]").first().fill("Brand Custom");
    await page.locator("[data-face-family]").first().press("Tab");
    await page.waitForTimeout(600);
    await page.keyboard.press("Escape");

    await page.reload();
    await resumeApp(page);
    await page.waitForTimeout(2200);
    equal(await page.evaluate(() => Stillframe.fonts.uploaded()[0].family), "Brand Custom", "uploaded font persisted in IndexedDB");

    await importHtml(page, UPLOADED_HTML, "uploaded-use.html");
    const f = frame(page);
    includes(await f.locator("h1").evaluate((el) => getComputedStyle(el).fontFamily), "Brand Custom", "import auto-loads uploaded font");
    equal(await page.evaluate(() => !!Stillframe.state.doc.querySelector("style[data-sf-font]")), true, "uploaded @font-face injected");
    equal(await page.evaluate(() => Stillframe.state.doc.fonts.check('16px "Brand Custom"')), true, "uploaded font is usable");
    excludes(await page.evaluate(() => Stillframe.serializeClean()), "data-sf-", "uploaded font artifacts stripped from source");

    await f.locator("h1").click();
    await page.waitForTimeout(250);
    await page.locator("#fontPickerButton").click();
    await page.locator("[data-font-tab=document]").click();
    await page.waitForTimeout(300);
    assert(await page.locator(".font-row", { hasText: "Brand Custom" }).count(), "in-document tab lists used font");
    await page.keyboard.press("Escape");

    await page.locator("#historyTab").click();
    await page.locator("#saveVersionButton").click();
    await page.locator("#versionNameInput").fill("Brand version");
    await page.locator("#versionNameForm button[type=submit]").click();
    await page.waitForTimeout(600);
    await importHtml(page, IMPORTED_HTML, "other.html");
    equal(await frame(page).locator("h1").innerText(), "Imported page", "second document loaded");
    const brandId = await page.evaluate(() => Stillframe.history.list().find((v) => v.name === "Brand version").id);
    await page.evaluate((id) => Stillframe.history.restore(id), brandId);
    await page.waitForTimeout(2200);
    equal(await frame(page).locator("h1").innerText(), "Uploaded font page", "restored uploaded-font version");
    includes(await frame(page).locator("h1").evaluate((el) => getComputedStyle(el).fontFamily), "Brand Custom", "restore re-loads uploaded font");
    equal(await page.evaluate(() => !!Stillframe.state.doc.querySelector("style[data-sf-font]")), true, "restore reinjects @font-face");

    await page.locator("#compareButton").click();
    await page.waitForTimeout(1200);
    const before = page.locator(".compare-before-frame");
    includes(await before.contentFrame().locator("h1").evaluate((el) => getComputedStyle(el).fontFamily), "Brand Custom", "compare before-frame loads uploaded font");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);

    await openExport(page);
    equal(await page.locator("#embedFonts").isChecked(), true, "embed fonts defaults on");
    const [onDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#downloadHtmlButton").click()]);
    const onPath = await onDownload.path();
    const onHtml = fs.readFileSync(onPath, "utf8");
    includes(onHtml, "Brand Custom", "exported HTML references uploaded family");
    includes(onHtml, "data:font", "exported HTML embeds uploaded face");
    assert((onHtml.match(/@font-face/g) || []).length >= 1, "exported HTML has @font-face");
    excludes(onHtml, "data-sf-", "exported HTML has no editor markers");
    excludes(onHtml, "contenteditable", "exported HTML has no editing state");

    await page.locator("#embedFonts").uncheck();
    const [offDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#downloadHtmlButton").click()]);
    const offPath = await offDownload.path();
    const offHtml = fs.readFileSync(offPath, "utf8");
    excludes(offHtml, "data:font", "embed off leaves font files out");
    assert(offHtml.length < onHtml.length, "embed off is smaller");

    await closeExport(page);
    await frame(page).locator("h1").click();
    await page.waitForTimeout(250);
    await page.locator("#fontPickerButton").click();
    await page.locator("[data-font-tab=uploaded]").click();
    await page.waitForTimeout(250);
    await page.locator("[data-delete-face]").first().click();
    await page.waitForTimeout(500);
    equal(await page.evaluate(() => Stillframe.fonts.uploaded().length), 0, "delete removes uploaded face");
    await page.locator(".toast-action").last().click();
    await page.waitForTimeout(500);
    equal(await page.evaluate(() => Stillframe.fonts.uploaded().length), 1, "delete undo restores uploaded face");
    equal(page._featureErrors.length, 0, "no console errors: " + page._featureErrors.join(" | "));
    await context.close();
  });

  await test("selection text formatting, case, alignment, size, line-height, tracking, kerning and one undo step", async () => {
    const context = await newContext();
    const page = await openApp(context);
    let p = frame(page).locator("p").first();
    await p.click();
    await page.locator("[data-format=bold]").click();
    await page.waitForTimeout(350);
    equal(await p.evaluate((el) => getComputedStyle(el).fontWeight), "700", "whole-element bold");
    await page.locator("#undoButton").click();
    await page.waitForTimeout(900);
    equal(await p.evaluate((el) => getComputedStyle(el).fontWeight), "400", "whole-element bold undo");

    p = frame(page).locator("p").first();
    const historyBefore = await page.evaluate(() => Stillframe.state.history.length);
    await p.dblclick();
    await page.waitForTimeout(300);
    assert(await page.locator("#textToolbar").isVisible(), "floating toolbar appears while editing");
    await p.evaluate((el) => {
      const d = el.ownerDocument;
      const text = el.firstChild;
      const range = d.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 5);
      const selection = d.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press("Control+b");
    await page.locator("[data-tt-format=italic]").click();
    await page.locator("[data-tt-format=underline]").click();
    await page.locator("[data-tt-format=strike]").click();
    await page.locator("[data-case=uppercase]").click();
    await page.locator("#fontSizeInput").fill("24");
    await page.locator("#fontSizeInput").press("Enter");
    const lineHeight = page.locator('input[data-style="line-height"]');
    await lineHeight.fill("1.6");
    await lineHeight.press("Enter");
    await page.locator("#trackingInput").fill("120");
    await page.locator("#trackingInput").press("Enter");
    const wordSpacing = page.locator('input[data-style="word-spacing"]');
    await wordSpacing.fill("4");
    await wordSpacing.press("Enter");
    await page.waitForTimeout(450);
    const during = await p.innerHTML();
    includes(during, "font-weight", "selection bold");
    includes(during, "font-style", "selection italic");
    includes(during, "line-through", "selection strike");
    includes(during, "text-transform", "selection case");
    includes(during, "font-size", "selection size");
    includes(during, "letter-spacing", "selection tracking");
    includes(during, "word-spacing", "selection word spacing");
    equal(await page.evaluate(() => Stillframe.state.history.length), historyBefore, "formatting waits for the edit session");

    await p.press("Enter");
    await page.waitForTimeout(700);
    assert(await page.locator("#textToolbar").isHidden(), "toolbar hides at session end");
    assert((await page.evaluate(() => Stillframe.state.history.length)) <= historyBefore + 1, "editing session creates at most one undo step");
    const clean = await page.evaluate(() => Stillframe.serializeClean());
    excludes(clean, "data-sf-", "selection formatting leaves no markers");
    excludes(clean, "contenteditable", "selection formatting leaves no editing attribute");
    assert(!/font-size:24px[^>]*><span[^>]*font-size:24px/.test(clean), "no duplicate size spans");

    await page.keyboard.press("Control+z");
    await page.waitForTimeout(1100);
    equal(await frame(page).locator("p").first().innerText(), "Scheduled for the next 30 days", "one undo restores the whole editing session");
    equal(await frame(page).locator("p").first().getAttribute("style"), null, "undo removes whole-element styles too");

    const p2 = frame(page).locator("p").first();
    await p2.click();
    await page.locator("[data-align=center]").click();
    await page.waitForTimeout(350);
    equal(await p2.evaluate((el) => getComputedStyle(el).textAlign), "center", "alignment applies");
    await page.locator("#undoButton").click();
    await page.waitForTimeout(900);
    assert((await p2.evaluate((el) => getComputedStyle(el).textAlign)) !== "center", "alignment undo");

    const p3 = frame(page).locator("p").first();
    await p3.click();
    await page.locator("#autoKerning").uncheck();
    await page.waitForTimeout(350);
    equal(await p3.evaluate((el) => getComputedStyle(el).fontKerning), "none", "auto kerning off");
    await page.locator("#undoButton").click();
    await page.waitForTimeout(900);
    assert((await p3.evaluate((el) => getComputedStyle(el).fontKerning)) !== "none", "kerning undo");

    const p4 = frame(page).locator("p").first();
    await p4.dblclick();
    await page.waitForTimeout(300);
    await p4.evaluate((el) => {
      const d = el.ownerDocument;
      const selection = d.getSelection();
      const range = d.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press("Alt+ArrowRight");
    await page.waitForTimeout(300);
    includes(await p4.innerHTML(), "letter-spacing: 0.01em", "Alt+Right kerns a pair");
    includes(await page.locator("#kernLabel").innerText(), "+10", "kerning readout");
    await page.keyboard.press("Alt+ArrowLeft");
    await page.waitForTimeout(300);
    excludes(await p4.innerHTML(), "letter-spacing: 0.01em", "Alt+Left unwraps zero tracking");
    await p4.press("Enter");
    await page.waitForTimeout(500);

    await p4.click();
    await page.locator("#trackingInput").fill("120");
    await page.locator("#trackingInput").press("Enter");
    await page.waitForTimeout(500);
    const tracked = await p4.evaluate((el) => ({ spacing: parseFloat(getComputedStyle(el).letterSpacing), size: parseFloat(getComputedStyle(el).fontSize) }));
    near(tracked.spacing, tracked.size * 0.12, 0.05, "whole-element tracking in 1/1000 em");
    await page.locator("#undoButton").click();
    await page.waitForTimeout(900);
    equal(await p4.evaluate((el) => getComputedStyle(el).letterSpacing), "normal", "tracking undo");
    equal(page._featureErrors.length, 0, "no console errors: " + page._featureErrors.join(" | "));
    await context.close();
  });

  await test("image and HTML exports match preview mode, embed Google fonts, and stay artifact-free", async () => {
    const context = await newContext();
    const page = await openApp(context);
    await importHtml(page, SCHEME_HTML, "export.html");
    const f = frame(page);
    await page.locator("[data-preview=light]").click();
    await page.waitForTimeout(350);
    await openExport(page);
    const [lightDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#downloadButton").click()]);
    const lightBuffer = fs.readFileSync(await lightDownload.path());
    const lightPixels = await page.evaluate(async (b64) => {
      const res = await fetch("data:image/png;base64," + b64);
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return {
        body: Array.from(ctx.getImageData(100, 100, 1, 1).data),
        page: Array.from(ctx.getImageData(20, 20, 1, 1).data),
      };
    }, lightBuffer.toString("base64"));
    assert(lightPixels.body[0] < 80 && lightPixels.body[1] < 80, "light preview content reaches the image export");
    assert(lightPixels.page[0] > 200 && lightPixels.page[1] > 200, "light page background reaches the image export");

    await closeExport(page);
    await page.locator("[data-preview=dark]").click();
    await page.waitForTimeout(350);
    await openExport(page);
    const [darkDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#downloadButton").click()]);
    const darkBuffer = fs.readFileSync(await darkDownload.path());
    const darkPixels = await page.evaluate(async (b64) => {
      const res = await fetch("data:image/png;base64," + b64);
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return {
        body: Array.from(ctx.getImageData(100, 100, 1, 1).data),
        page: Array.from(ctx.getImageData(20, 20, 1, 1).data),
      };
    }, darkBuffer.toString("base64"));
    assert(darkPixels.body[0] > 200 && darkPixels.body[1] > 200, "dark preview content reaches the image export");
    assert(darkPixels.page[0] < 80 && darkPixels.page[1] < 80, "dark page background reaches the image export");

    await openExport(page);
    await page.locator("#bgTransparent").click();
    await page.waitForTimeout(150);
    const [transparentDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#downloadButton").click()]);
    const transparentBuffer = fs.readFileSync(await transparentDownload.path());
    const transparentAlpha = await page.evaluate(async (b64) => {
      const res = await fetch("data:image/png;base64," + b64);
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(20, 20, 1, 1).data[3];
    }, transparentBuffer.toString("base64"));
    equal(transparentAlpha, 0, "transparent export keeps a transparent page background");

    await openExport(page);
    const [htmlDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#downloadHtmlButton").click()]);
    const exported = fs.readFileSync(await htmlDownload.path(), "utf8");
    includes(exported, 'class="dark"', "export keeps authored class");
    includes(exported, 'data-theme="dark"', "export keeps authored data-theme");
    assert(!/<html[^>]*style="[^"]*color-scheme/i.test(exported), "export does not contain preview color-scheme");
    excludes(exported, "data-sf-", "export has no editor markers");
    excludes(exported, "contenteditable", "export has no editing state");

    await openApp(context);
    const sample = context.pages()[context.pages().length - 1];
    await sample.waitForTimeout(500);
    await openExport(sample);
    const [googleOn] = await Promise.all([sample.waitForEvent("download"), sample.locator("#downloadHtmlButton").click()]);
    const googleOnHtml = fs.readFileSync(await googleOn.path(), "utf8");
    includes(googleOnHtml, "@font-face", "Google fonts embedded by default");
    includes(googleOnHtml, "data:font", "font files converted to data URIs");
    excludes(googleOnHtml, "data-sf-", "embedded HTML has no editor markers");
    await sample.locator("#embedFonts").uncheck();
    const [googleOff] = await Promise.all([sample.waitForEvent("download"), sample.locator("#downloadHtmlButton").click()]);
    const googleOffHtml = fs.readFileSync(await googleOff.path(), "utf8");
    excludes(googleOffHtml, "@font-face", "embed off omits embedded faces");
    excludes(googleOffHtml, "data:font", "embed off omits font data URIs");
    assert(googleOffHtml.length < googleOnHtml.length, "embed off is smaller");
    await context.close();
  });

  await test("SVG charts keep CSS fills, strokes, gradients and labels in image exports", async () => {
    const context = await newContext();
    const page = await openApp(context);
    await importHtml(page, CHART_HTML, "chart.html");
    await page.waitForTimeout(500);
    await openExport(page);
    const [chartDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#downloadButton").click()]);
    const chartBuffer = fs.readFileSync(await chartDownload.path());
    const counts = await page.evaluate(async (b64) => {
      const res = await fetch("data:image/png;base64," + b64);
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let orange = 0;
      let green = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (r > 150 && r > g * 1.35 && r > b * 1.35) orange++;
        if (g > 150 && r < 100 && b < 190) green++;
      }
      return { orange, green, width: bitmap.width, height: bitmap.height };
    }, chartBuffer.toString("base64"));
    assert(counts.width > 700 && counts.height > 300, "chart export keeps its page dimensions");
    assert(counts.orange > 1000, "SVG line and area fills survive export: " + counts.orange);
    assert(counts.green > 1000, "SVG dot and label styles survive export: " + counts.green);
    equal(page._featureErrors.length, 0, "no console errors: " + page._featureErrors.join(" | "));
    await context.close();
  });

  await test("font export warns when remote font data is blocked", async () => {
    const context = await newContext();
    const page = await openApp(context);
    await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
    await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
    await openExport(page);
    try {
      await Promise.all([page.waitForEvent("download", { timeout: 9000 }), page.locator("#downloadButton").click()]);
    } catch (_) {}
    await page.waitForTimeout(500);
    includes(await page.locator("#toastRegion").innerText(), "couldn't be embedded", "fallback warning toast");
    await context.close();
  });

  await test("390px mobile layout and light/dark screenshots keep all five features usable", async () => {
    const context = await newContext({ width: 390, height: 844 });
    const page = await openApp(context);
    await page.locator("#themeToggle").click();
    await page.waitForTimeout(300);
    await page.locator("[data-preview=dark]").click();
    await page.waitForTimeout(400);
    await clearToasts(page);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(450);
    assert(await page.locator("[data-preview=dark]").isVisible(), "preview controls visible on mobile");
    assert(await page.locator("#dockLayers").isVisible(), "mobile panel dock visible");
    await page.locator("#dockLayers").click();
    await page.waitForTimeout(350);
    assert(await page.locator("#historyTab").isVisible(), "history tab reachable on mobile");
    await page.locator("#closeLeft").click();
    await page.waitForTimeout(300);
    const vp = page.viewportSize();
    for (const selector of ["#compareButton", "#exportButton", "[data-preview=dark]"]) {
      const box = await page.locator(selector).boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= vp.width + 1, `${selector} fits mobile viewport`);
    }
    await page.screenshot({ path: path.join(SHOTS, "mobile-dark.png"), fullPage: false });
    await page.locator("#themeToggle").click();
    await page.locator("[data-preview=light]").click();
    await clearToasts(page);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, "mobile-light.png"), fullPage: false });
    await page.locator("#compareButton").click();
    await page.waitForTimeout(1000);
    assert(await page.locator(".compare-handle").isVisible(), "compare handle visible on mobile");
    assert(await page.locator("#compareBaseline").isVisible(), "baseline selector visible on mobile");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    assert(await page.locator("#dropOverlay").isHidden(), "drop overlay stays out of the way");
    equal(page._featureErrors.length, 0, "no console errors: " + page._featureErrors.join(" | "));
    await context.close();
  });

  await browser.close();
  browser = null;

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`- ${failure.name}: ${failure.err && failure.err.message}`);
    process.exitCode = 1;
  }
  try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch (_) {}
}

main().catch(async (err) => {
  console.error(err && err.stack ? err.stack : err);
  if (browser) { try { await browser.close(); } catch (_) {} }
  process.exitCode = 1;
});



