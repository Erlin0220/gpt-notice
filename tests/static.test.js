const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:\.\d+)?$/, "manifest version must be a Chrome-compatible numeric version");
assert.ok(manifest.permissions.includes("tabGroups"));
assert.ok(manifest.permissions.includes("alarms"));
assert.deepEqual(manifest.content_scripts[0].js, ["queue-core.js", "content.js", "queue-v051.js"]);

const monitor = fs.readFileSync(path.join(root, "background-monitor-tabs.js"), "utf8");
assert.ok(monitor.includes("active: false"));
assert.ok(!monitor.includes("chrome.windows.create"), "monitor path must not create a window");
assert.ok(monitor.includes("getOrCreateMonitorGroup"));

const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
assert.ok(!content.includes("location.reload()"), "content script must not use fixed self-refresh");
assert.ok(content.includes("PROBE_TASK_STATE"));

const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
const backgroundQueue = fs.readFileSync(path.join(root, "background-queue.js"), "utf8");
const queueCore = fs.readFileSync(path.join(root, "queue-core.js"), "utf8");
const queue = fs.readFileSync(path.join(root, "queue-v051.js"), "utf8");
assert.ok(background.includes("background-queue.js"));
assert.ok(backgroundQueue.includes("reconcileQueueObservers"));
assert.ok(queueCore.includes("canAdmit"), "queue core must reject idle admission");
assert.ok(queueCore.includes("shouldMigrateQueue"), "queue migration must be constrained");
assert.ok(queue.includes("当前没有正在进行的会话，不能加入队列"));
assert.ok(queue.includes("acquireLease"), "queue must prevent duplicate dispatch across tabs");
assert.ok(queue.includes("acquireWriteLock"), "queue writes must be serialized across tabs");
assert.ok(queue.includes("dataset.gptqOwner"), "stale queue UI must be replaced after script reload");
assert.ok(queue.includes("ChatGPTTaskNotifierBridge"), "queue must read restored task state after refresh");
assert.ok(content.includes("ChatGPTTaskNotifierBridge"), "task notifier must expose restored running state to the queue");
assert.ok(queue.includes("MAX_AUTO_RETRY = 1"));
assert.ok(queue.includes('class="gptq-confirm"'), "queue actions must use an in-panel confirmation");
assert.ok(queue.includes('data-action="execute-now"'), "pending queue items must support immediate execution");
assert.ok(queue.includes('mode === "auto-execute"'), "automatic dispatch must confirm before overwriting a draft");
assert.ok(queue.includes("deferredAutoItemId"), "declined automatic dispatch must wait while the composer remains non-empty");
assert.ok(queue.includes("setComposerText(composer, item.text)"), "queue editing must restore content to the ChatGPT composer");
assert.ok(queue.includes("currentQueue.items = currentQueue.items.filter"), "restored items must be removed from the queue");
assert.ok(queue.includes("if (list.innerHTML !== listMarkup)"), "queue rendering must preserve item buttons when markup is unchanged");
assert.ok(queue.includes("!root || !root.contains(mutation.target)"), "the observer must ignore queue UI mutations");
assert.ok(queue.includes("event.stopImmediatePropagation()"), "queue actions must be isolated from page click handlers");
assert.ok(!queue.includes("window.prompt("), "queue actions must not depend on suppressible browser dialogs");
assert.ok(!queue.includes("gptq-editor"), "obsolete inline queue editor must be removed");
assert.ok(queue.includes("previousComposerText"), "failed overwrites must preserve the previous composer content");

console.log(`static v${manifest.version} tests passed`);
