const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
assert.equal(manifest.version, "0.4.0");
assert.ok(manifest.permissions.includes("tabGroups"));
assert.ok(manifest.permissions.includes("alarms"));

const monitor = fs.readFileSync(path.join(root, "background-monitor-tabs.js"), "utf8");
assert.ok(monitor.includes("active: false"));
assert.ok(!monitor.includes("chrome.windows.create"), "monitor path must not create a window");
assert.ok(monitor.includes("getOrCreateMonitorGroup"));

const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
assert.ok(!content.includes("location.reload()"), "content script must not use fixed self-refresh");
assert.ok(content.includes("PROBE_TASK_STATE"));
console.log("static v0.4.0 tests passed");
