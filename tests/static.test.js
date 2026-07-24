const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:\.\d+)?$/);
assert.ok(!manifest.permissions.includes("tabGroups"), "current-page mode must not request tabGroups");
assert.ok(!manifest.permissions.includes("alarms"), "current-page mode must not request alarms");
assert.deepEqual(manifest.content_scripts[0].js, ["queue-core.js", "content.js", "queue-v060.js"]);

const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
assert.ok(background.includes("stopTasksForClosedTab"));
assert.ok(background.includes("页面已关闭，已停止监控"));
assert.ok(!background.includes("chrome.tabs.group"));
assert.ok(!background.includes("chrome.alarms"));
assert.ok(!background.includes("active: false"), "service worker must not create background monitor tabs");

const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
assert.ok(content.includes("ChatGPTTaskNotifierBridge"));
assert.ok(!content.includes("location.reload()"));

const core = fs.readFileSync(path.join(root, "queue-core.js"), "utf8");
const queue = fs.readFileSync(path.join(root, "queue-v060.js"), "utf8");
assert.ok(core.includes("MAX_TEXT_LENGTH = 200_000"));
assert.ok(core.includes("canAdmit"));
assert.ok(queue.includes("messageQueueIndexV3"), "queue metadata must be stored separately");
assert.ok(queue.includes("messageQueueItemV3:"), "long item text must use independent storage entries");
assert.ok(queue.includes("PREVIEW_LENGTH = 240"));
assert.ok(queue.includes("item.text.slice(0, PREVIEW_LENGTH)"));
assert.ok(queue.includes("replaceChildren(document.createTextNode(text))"), "composer writes must be atomic");
assert.ok(queue.includes("suppressComposerMutations"), "programmatic writes must suppress observer churn");
assert.ok(queue.includes("reconcilePageStateForAction"), "manual execution must repair stale state");
assert.ok(queue.includes("resolveEffectiveTaskRunning"), "cached notifier state must be corrected with live DOM state");
assert.ok(queue.includes('data-action="execute-now"'));
assert.ok(queue.includes('class="gptq-confirm"'));
assert.ok(queue.includes("event.stopImmediatePropagation()"));
assert.ok(queue.includes("previousComposerText"));
assert.ok(queue.includes("runtime.uiActionInFlight"));
assert.ok(!queue.includes("document.execCommand"), "large composer writes must not use execCommand");
assert.ok(!queue.includes("window.prompt("));

console.log(`static v${manifest.version} tests passed`);
