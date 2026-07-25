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
  items: [{ ...itemA, status: "running", startedAt: Date.now() - 10_000, baselineAssistantHash: "same", baselineAssistantCount: 2 }, itemB]
}, "c:test");
const active = runningQueue.items[0];
assert.equal(core.isItemCompleted(active, {
  assistantHash: "new", assistantText: "回复完成", assistantCount: 3, composerReady: true,
  stopVisible: false, waitingAction: false, busy: false, visibleError: false, stableForMs: 4_500
}), true);

const otherLeaseQueue = core.normalizeQueue({
  ...runningQueue,
  lease: { ownerId: "other-tab", expiresAt: Date.now() + 10_000 }
}, "c:test");
assert.equal(core.shouldRecoverInterruptedQueue(otherLeaseQueue, "this-tab"), false, "a second tab must not reset an actively leased queue");
assert.equal(core.shouldRecoverInterruptedQueue(otherLeaseQueue, "other-tab"), true, "the reloaded owner tab may recover its interrupted queue");
assert.equal(core.shouldRecoverInterruptedQueue({ ...otherLeaseQueue, lease: { ownerId: "other-tab", expiresAt: Date.now() - 1 } }, "this-tab"), true, "an expired lease must be recoverable");

const recovered = core.resetInterruptedItems(runningQueue);
assert.equal(recovered.activeItemId, null);
assert.equal(recovered.items[0].status, "pending");
assert.equal(recovered.paused, true, "interrupted queue must pause instead of resending automatically");

const moved = core.moveItem(queue.items, itemB.id, "up");
assert.equal(moved[0].id, itemB.id);
const manyPending = Array.from({ length: 130 }, (_, index) => ({ id: `pending-${index}`, text: `pending ${index}`, status: "pending" }));
assert.equal(core.normalizeQueue({ items: manyPending }, "c:pending").items.length, 130);

console.log("queue v0.6.3 tests passed");
