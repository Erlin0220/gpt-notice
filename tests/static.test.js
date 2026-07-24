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
assert.ok(!content.includes("isMonitor"), "obsolete background-monitor mode must be removed");
assert.ok(content.includes("pendingConfirmed"), "task creation must wait for send confirmation");
assert.ok(content.includes("sendWithRetry"), "task state messages must retry transient failures");
assert.ok(content.includes('type: "PAGE_CHANGED"'), "SPA navigation must stop the previous task");
assert.ok(content.includes("RECOVERY_IDLE_GRACE_MS"), "refresh recovery must use a hydration grace period");
assert.ok(content.includes("PAGE_PROMOTED"), "draft-to-conversation navigation must preserve the active task");
assert.ok(content.includes("isConversationPromotion"), "URL promotion must be explicitly constrained");

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
assert.ok(queue.includes("navigator.locks.request"), "cross-tab writes must use Web Locks when available");
assert.ok(queue.includes("acquireFallbackStorageLock"), "queue writes need a storage-lock fallback");
assert.ok(queue.includes("migrateLegacyQueue"), "legacy queues must be removed after migration");
assert.ok(queue.includes("runtime.queueCache"), "long item bodies must be cached by metadata revision");
assert.ok(queue.includes("textsById"), "metadata-only updates must reuse cached long item bodies");
assert.ok(queue.includes("let claimed = false"), "lease acquisition must re-check ownership while holding the storage lock");
assert.ok(queue.includes("shouldRecoverInterruptedQueue"), "a second tab must not reset a valid active lease");
assert.ok(queue.includes("if (runtime.sendConfirmation || runtime.dispatching) return;"), "manual reconciliation must not race an unconfirmed send");
assert.ok(queue.includes('mode === "auto-execute" ? "auto" : "manual"'), "auto overwrite confirmation must retain automatic dispatch safety checks");
assert.ok(queue.includes("输入框清空失败，内容未加入队列"), "enqueue must rollback when composer clearing fails");
assert.ok(!queue.includes("document.execCommand"), "large composer writes must not use execCommand");
assert.ok(!queue.includes("window.prompt("));



const privacy = fs.readFileSync(path.join(root, "PRIVACY.md"), "utf8");
assert.ok(!privacy.includes("GPT 后台"));
assert.ok(!privacy.includes("Chrome Alarms API"));
const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
assert.ok(ci.includes("pull_request:"));
const release = fs.readFileSync(path.join(root, ".github/workflows/auto-release.yml"), "utf8");
assert.ok(!release.includes("types: [closed]"));
assert.ok(!/Validate extension\n\s+if:/.test(release), "release validation must never be skipped");

console.log(`static v${manifest.version} tests passed`);
