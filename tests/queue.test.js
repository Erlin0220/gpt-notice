const assert = require("node:assert/strict");
const core = require("../queue-core.js");

const itemA = core.createQueueItem("第一条消息");
const itemB = core.createQueueItem("第二条消息");
assert.ok(itemA.id && itemB.id);
assert.equal(itemA.status, "pending");
const queue = core.normalizeQueue({ items: [itemA, itemB] }, "c:test");
assert.equal(core.countPending(queue), 2);
assert.equal(core.getNextPendingItem(queue).text, "第一条消息");
assert.equal(core.getConversationKey("https://chatgpt.com/c/abc?x=1"), "c:abc");
assert.match(core.getConversationKey("https://chatgpt.com/", "tab-1"), /^temp:/);
assert.equal(core.getConversationKey("https://chatgpt.com/g/g-p-demo/project", "tab-1"), "project-draft:g-p-demo:tab-1");
const realProjectDraftKey = core.getConversationKey("https://chatgpt.com/g/g-p-6a5f1944d2a88191bdee52564ce3a883-qing-gan-shi-pin-ji-neng/project", "project-tab");
const realProjectConversationKey = core.getConversationKey("https://chatgpt.com/g/g-p-6a60d644663c8191ae735ee9173602dd-windowszhong-duan/c/6a641d0e-bbb0-83e8-995e-14b42efe9c71", "project-tab");
assert.equal(realProjectDraftKey, "project-draft:g-p-6a5f1944d2a88191bdee52564ce3a883-qing-gan-shi-pin-ji-neng:project-tab");
assert.equal(realProjectConversationKey, "c:6a641d0e-bbb0-83e8-995e-14b42efe9c71");
assert.equal(core.shouldMigrateQueue(realProjectDraftKey, realProjectConversationKey), true, "a project draft queue must migrate after ChatGPT assigns the project conversation URL");
assert.equal(core.getTabQueueKey(7, "c:abc", "page-a"), "tab:7:page-a:c:abc");
assert.notEqual(core.getTabQueueKey(7, "c:abc", "page-a"), core.getTabQueueKey(8, "c:abc", "page-a"), "the same conversation must keep separate queues per tab");
assert.notEqual(core.getTabQueueKey(7, "c:abc", "page-a"), core.getTabQueueKey(7, "c:abc", "page-b"), "a reused tab id must not inherit another browser-page queue");
assert.equal(core.normalizeQueue({}, "tab:7:page-a:c:abc").ownerTabId, null, "an empty queue must not invent tab 0 as its owner");
assert.equal(core.shouldMigrateQueue("temp:tab-1", "c:abc"), true);
assert.equal(core.shouldMigrateQueue("project-draft:g-p-demo:tab-1", "c:abc"), true);
assert.equal(core.shouldMigrateQueue("c:old", "c:new"), false);

const longText = "长".repeat(150_000);
assert.equal(core.createQueueItem(longText).text.length, 150_000, "long queue messages must not be truncated to 20k");
assert.equal(core.createQueueItem("超".repeat(220_000)).text.length, core.MAX_TEXT_LENGTH);

const idleSnapshot = { composerReady: true, composerEmpty: true, stopVisible: false, waitingAction: false, busy: false, visibleError: false, manualHold: false, stableForMs: 5_000 };
assert.equal(core.canAdmit(queue, idleSnapshot), false);
assert.equal(core.canAdmit(queue, { ...idleSnapshot, busy: true }), true);
assert.equal(core.canDispatch(queue, idleSnapshot), true);
assert.equal(core.canDispatch(queue, { ...idleSnapshot, composerEmpty: false }), false);

const runningQueue = core.normalizeQueue({
  activeItemId: itemA.id,
  items: [{ ...itemA, status: "running", startedAt: Date.now() - 10_000, baselineAssistantHash: "same", baselineAssistantCount: 2, baselineCopyActionCount: 2 }, itemB]
}, "c:test");
const active = runningQueue.items[0];
assert.equal(core.isItemCompleted(active, {
  assistantHash: "new", assistantText: "回复完成", assistantCount: 3, composerReady: true,
  stopVisible: false, waitingAction: false, busy: false, visibleError: false, stableForMs: 4_500
}), true);
assert.equal(core.isItemCompleted(active, {
  assistantHash: "new-copy", assistantText: "回复完成", assistantCount: 3, assistantHasCopyAction: true, copyActionCount: 3, composerReady: true,
  stopVisible: false, waitingAction: false, busy: false, visibleError: false, stableForMs: 700
}), true, "new reply copy action should complete faster than the text-stability fallback");
assert.equal(core.isItemCompleted(active, {
  assistantHash: "new-no-copy", assistantText: "仍在输出", assistantCount: 3, assistantHasCopyAction: false, copyActionCount: 2, composerReady: true,
  stopVisible: false, waitingAction: false, busy: false, visibleError: false, stableForMs: 700
}), false, "without a copy action the four-second text stability fallback must remain");

assert.equal(core.shouldRecoverInterruptedQueue(runningQueue), true, "a tab-scoped interrupted active item must be recovered by its own tab");
assert.equal(core.hasLeaseWork(runningQueue), true);
assert.equal(core.hasLeaseWork(core.normalizeQueue({ items: [itemB], paused: true }, "tab:7:c:test")), false, "a paused queue without an active item must release the conversation lease");

const recovered = core.resetInterruptedItems(runningQueue);
assert.equal(recovered.activeItemId, null);
assert.equal(recovered.items[0].status, "pending");
assert.equal(recovered.paused, true, "interrupted queue must pause instead of resending automatically");

const moved = core.moveItem(queue.items, itemB.id, "up");
assert.equal(moved[0].id, itemB.id);
const manyPending = Array.from({ length: 130 }, (_, index) => ({ id: `pending-${index}`, text: `pending ${index}`, status: "pending" }));
assert.equal(core.normalizeQueue({ items: manyPending }, "c:pending").items.length, 130);

console.log("queue v0.6.7 tests passed");
