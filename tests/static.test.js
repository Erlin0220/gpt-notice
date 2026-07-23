const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:\.\d+)?$/, "manifest version must be a Chrome-compatible numeric version");
assert.ok(manifest.permissions.includes("tabGroups"));
assert.ok(manifest.permissions.includes("alarms"));
assert.deepEqual(manifest.content_scripts[0].js, ["queue-core.js", "content.js", "queue.js"]);

const monitor = fs.readFileSync(path.join(root, "background-monitor-tabs.js"), "utf8");
assert.ok(monitor.includes("active: false"));
assert.ok(!monitor.includes("chrome.windows.create"), "monitor path must not create a window");
assert.ok(monitor.includes("getOrCreateMonitorGroup"));

const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
assert.ok(!content.includes("location.reload()"), "content script must not use fixed self-refresh");
assert.ok(content.includes("PROBE_TASK_STATE"));

const queueCore = fs.readFileSync(path.join(root, "queue-core.js"), "utf8");
const queue = fs.readFileSync(path.join(root, "queue.js"), "utf8");
assert.ok(queueCore.includes("QUEUE_STORAGE_KEY"));
assert.ok(queue.includes("加入队列"));
assert.ok(queue.includes("acquireLease"), "queue must prevent duplicate dispatch across tabs");
assert.ok(queue.includes("MAX_AUTO_RETRY = 1"));

console.log(`static v${manifest.version} tests passed`);
