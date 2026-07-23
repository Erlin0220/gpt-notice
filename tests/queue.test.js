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

assert.equal(core.canDispatch(queue, {
  composerReady: true,
  stopVisible: false,
  busy: false,
  visibleError: false,
  manualHold: false,
  stableForMs: 4_500
}), true);

const runningQueue = core.normalizeQueue({
  activeItemId: itemA.id,
  items: [{ ...itemA, status: "running", startedAt: Date.now() - 5_000, baselineAssistantHash: "old" }, itemB]
}, "c:test");
const active = runningQueue.items[0];
assert.equal(core.isItemCompleted(active, {
  assistantHash: "new",
  assistantText: "回复完成",
  composerReady: true,
  stopVisible: false,
  busy: false,
  visibleError: false,
  stableForMs: 4_500
}), true);

const moved = core.moveItem(queue.items, itemB.id, "up");
assert.equal(moved[0].id, itemB.id);

const recovered = core.resetInterruptedItems(runningQueue);
assert.equal(recovered.activeItemId, null);
assert.equal(recovered.items[0].status, "pending");

console.log("queue v0.5.0 tests passed");
