const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("manifest.json"));
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:\.\d+)?$/);
assert.ok(!manifest.permissions.includes("tabGroups"));
assert.ok(!manifest.permissions.includes("alarms"));
assert.ok(!manifest.permissions.includes("downloads"));
assert.ok(!manifest.permissions.includes("clipboardWrite"));
assert.deepEqual(manifest.content_scripts[0].js, [
  "queue-lease-guard.js",
  "chatgpt-dom.js",
  "queue-core.js",
  "queue-ui.js",
  "content.js",
  "queue-v060.js"
]);

const background = read("background.js");
const pageAdapter = read("chatgpt-dom.js");
const content = read("content.js");
const core = read("queue-core.js");
const queue = read("queue-v060.js");
const queueUi = read("queue-ui.js");
const diagnostics = read("diagnostics.js");
const popup = read("popup.js");
const popupHtml = read("popup.html");

assert.ok(background.includes('importScripts("diagnostics.js")'));
assert.ok(background.includes('case "DIAGNOSTIC_EVENT"'));
assert.ok(background.includes('case "GET_DIAGNOSTIC_REPORT"'));
assert.ok(background.includes('case "CLEAR_DIAGNOSTICS"'));
assert.ok(background.includes("stopTasksForClosedTab"));
assert.ok(background.includes("cleanupQueueStateForClosedTab"));
assert.ok(!background.includes("chrome.tabs.group"));
assert.ok(!background.includes("chrome.alarms"));
assert.ok(!background.includes("active: false"));

assert.ok(pageAdapter.includes("collectPageState"));
assert.ok(pageAdapter.includes("evaluatePageFacts"));
assert.ok(pageAdapter.includes("toPublicSnapshot"));
assert.ok(pageAdapter.includes('supportStatus: "initializing"'));
assert.ok(pageAdapter.includes('blocked.length ? "blocked"'));
assert.ok(pageAdapter.includes("canDispatchQueue"));
assert.ok(pageAdapter.includes('reasonCodes: ["page_initializing"]'));
assert.ok(pageAdapter.includes("findActiveComposer"));
assert.ok(!pageAdapter.includes("documentRef.querySelector ="), "the adapter must not monkey-patch document.querySelector");

assert.ok(content.includes("ChatGPTPageAdapter"));
assert.ok(content.includes('message?.type === "GET_PAGE_SNAPSHOT"'));
assert.ok(content.includes("page.compatibility_changed"));
assert.ok(content.includes("pendingConfirmed"));
assert.ok(content.includes("pendingBaselineUserHash"));
assert.ok(content.includes("PAGE_PROMOTED"));
assert.ok(content.includes("RECOVERY_IDLE_GRACE_MS"));
assert.ok(!content.includes("location.reload()"));
assert.ok(!content.includes('button[data-testid*="stop"]'), "task monitoring must not duplicate page selectors");
assert.ok(!content.includes("something went wrong"), "task monitoring must not duplicate page error keywords");

assert.ok(core.includes("QUEUE_SCHEMA_VERSION = 5"));
assert.ok(core.includes("pauseReason"));
assert.ok(core.includes("pauseForCompatibility"));
assert.ok(core.includes("resumeQueue"));
assert.ok(!core.includes("function moveItem"));
assert.ok(core.includes("MAX_TEXT_LENGTH = 200_000"));
assert.ok(core.includes("shouldPauseQueueAfterPageReload"));

assert.ok(queue.includes("ChatGPTPageAdapter"));
assert.ok(queue.includes("ChatGPTQueueUI"));
assert.ok(queue.includes("enforceCompatibilityPause"));
assert.ok(queue.includes("空闲页面预存队列"));
assert.ok(queue.includes("页面兼容性受阻"));
assert.ok(queue.includes("输入框为空，请先输入要加入队列的内容"));
assert.ok(queue.includes("runtime.ui.render"));
assert.ok(queue.includes("MutationObserver"));
assert.ok(!queue.includes('data-action="up"'));
assert.ok(!queue.includes('data-action="down"'));
assert.ok(!queue.includes("moveItem("));
assert.match(queue, /deleteQueue\(fromKey,\s*\{items:\[\]\}\)/, "queue promotion must preserve shared item bodies");
assert.ok(!queue.includes('button[data-testid*="stop"]'), "queue runtime must not duplicate page selectors");
assert.ok(!queue.includes("something went wrong"), "queue runtime must not duplicate page error keywords");
assert.ok(queue.includes("messageQueueIndexV3"));
assert.ok(queue.includes("messageQueueItemV3:"));
assert.ok(queue.includes("messageQueueConversationLeasesV1"));
assert.ok(queue.includes("navigator.locks.request"));
assert.ok(queue.includes("withStorageLock"));
assert.ok(queue.includes("replaceChildren(document.createTextNode(text))"));
assert.ok(queue.includes("textLength: text.length"));

assert.ok(queueUi.includes("lastSignature"));
assert.ok(queueUi.includes("syncItems"));
assert.ok(queueUi.includes("node.dataset.id"));
assert.ok(queueUi.includes("list.insertBefore"));
assert.ok(queueUi.includes("actions.replaceChildren"));
assert.ok(!queueUi.includes('data-action="up"'));
assert.ok(!queueUi.includes('data-action="down"'));

assert.match(diagnostics, /MAX_EVENTS\s*=\s*200/);
assert.ok(diagnostics.includes("MAX_EVENT_AGE_MS"));
assert.ok(diagnostics.includes("sanitizeText"));
assert.ok(diagnostics.includes("hashIdentifier"));
assert.ok(diagnostics.includes("buildReport"));
assert.ok(diagnostics.includes("toMarkdown"));
assert.ok(diagnostics.includes("diagnosticEventsV1"));

assert.ok(popupHtml.includes('id="pageHealth"'));
assert.ok(popupHtml.includes('id="copyDiagnosticsButton"'));
assert.ok(popupHtml.includes('id="downloadDiagnosticsButton"'));
assert.ok(popupHtml.includes('id="clearDiagnosticsButton"'));
assert.ok(popup.includes('send("GET_DIAGNOSTIC_REPORT")'));
assert.ok(popup.includes("navigator.clipboard.writeText"));
assert.ok(popup.includes("new Blob"));
assert.ok(popup.includes('send("CLEAR_DIAGNOSTICS")'));

const runtimeTextFiles = [
  "manifest.json", "background.js", "chatgpt-dom.js", "content.js", "diagnostics.js",
  "popup.html", "popup.css", "popup.js", "queue-core.js", "queue-lease-guard.js", "queue-ui.js", "queue-v060.js", "queue.css"
];
const runtimeBytes = runtimeTextFiles.reduce((sum, file) => sum + fs.statSync(path.join(root, file)).size, 0);
assert.ok(runtimeBytes <= 175_000, `runtime text resources exceed the v0.7.0 target; current=${runtimeBytes} bytes`);
for (const file of runtimeTextFiles.filter((file) => file.endsWith(".js"))) {
  const size = fs.statSync(path.join(root, file)).size;
  assert.ok(size <= 50_000, `${file} is too large (${size} bytes); split responsibilities before release`);
}

const packageJson = JSON.parse(read("package.json"));
const chromeE2E = read("scripts/e2e-current-chrome.mjs");
assert.ok(packageJson.scripts["e2e:chrome:prepare"]);
assert.ok(packageJson.scripts["e2e:chrome:endpoint"]);
assert.ok(packageJson.scripts["e2e:chrome:probe"]);
assert.equal(packageJson.devDependencies["@playwright/cli"], undefined, "the deprecated Playwright CLI connector must stay removed");
assert.ok(chromeE2E.includes("DevToolsActivePort"));
assert.ok(chromeE2E.includes("connectOverCDP"));
assert.ok(!chromeE2E.includes("Profile 2"));

const updater = read("scripts/update-installed-extension.ps1");
assert.ok(updater.includes("backupPath"));
assert.ok(updater.includes("chrome://extensions/"));
for (const file of ["diagnostics.js", "queue-ui.js", "queue.css"]) assert.ok(updater.includes(`"${file}"`), `${file} must be copied by the fixed-directory updater`);
const privacy = read("PRIVACY.md");
assert.ok(!privacy.includes("GPT 后台"));
const ci = read(".github/workflows/ci.yml");
assert.ok(ci.includes("pull_request:"));
const release = read(".github/workflows/auto-release.yml");
assert.ok(release.includes("--exclude='playwright.config.js'"));
assert.ok(ci.includes("--exclude='package-lock.json'"));
for (const workflow of [ci, release]) {
  assert.ok(workflow.includes("npm ci"), "CI and release must install locked test dependencies");
  assert.ok(workflow.includes("playwright install --with-deps chromium"), "CI and release must install the Chromium runtime");
  assert.ok(workflow.includes("npm run e2e:smoke"), "CI and release must gate on the no-login browser smoke suite");
}

console.log(`static v${manifest.version} tests passed; runtime text=${runtimeBytes} bytes`);
