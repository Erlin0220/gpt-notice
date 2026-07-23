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
assert.equal(
  core.getConversationKey("https://chatgpt.com/g/g-p-demo/project", "tab-1"),
  "project-draft:g-p-demo:tab-1"
);
assert.equal(core.shouldMigrateQueue("temp:tab-1", "c:abc"), true);
assert.equal(core.shouldMigrateQueue("project-draft:g-p-demo:tab-1", "c:abc"), true);
assert.equal(core.shouldMigrateQueue("c:old", "c:new"), false);

const idleSnapshot = {
  composerReady: true,
  composerEmpty: true,
  stopVisible: false,
  waitingAction: false,
  busy: false,
  visibleError: false,
  manualHold: false,
  stableForMs: 5_000
};
assert.equal(core.canAdmit(queue, idleSnapshot), false, "idle conversation must reject queue admission");
assert.equal(core.canAdmit(queue, { ...idleSnapshot, busy: true }), true);
assert.equal(core.canAdmit(queue, { ...idleSnapshot, waitingAction: true }), true);

assert.equal(core.canDispatch(queue, idleSnapshot), true);
assert.equal(core.canDispatch(queue, { ...idleSnapshot, composerEmpty: false }), false, "draft must block auto dispatch");

const runningQueue = core.normalizeQueue({
  activeItemId: itemA.id,
  items: [{
    ...itemA,
    status: "running",
    startedAt: Date.now() - 10_000,
    baselineAssistantHash: "same",
    baselineAssistantCount: 2
  }, itemB]
}, "c:test");
const active = runningQueue.items[0];
assert.equal(core.isItemCompleted(active, {
  assistantHash: "same",
  assistantText: "完全相同的回复",
  assistantCount: 3,
  composerReady: true,
  stopVisible: false,
  waitingAction: false,
  busy: false,
  visibleError: false,
  stableForMs: 4_500
}), true, "new assistant message count must complete even when text hash repeats");

assert.equal(core.isItemCompleted(active, {
  assistantHash: "new",
  assistantText: "回复完成",
  assistantCount: 3,
  composerReady: true,
  stopVisible: false,
  waitingAction: false,
  busy: true,
  visibleError: false,
  stableForMs: 8_500
}), true, "stale busy indicator must not block completion forever");

const moved = core.moveItem(queue.items, itemB.id, "up");
assert.equal(moved[0].id, itemB.id);

const interrupted = core.normalizeQueue({
  activeItemId: itemA.id,
  items: [{ ...itemA, status: "dispatching" }, itemB]
}, "c:test");
const recovered = core.resetInterruptedItems(interrupted);
assert.equal(recovered.activeItemId, null);
assert.equal(recovered.items[0].status, "pending");

const history = Array.from({ length: 150 }, (_, index) => ({
  id: `done-${index}`,
  text: `done ${index}`,
  status: "completed",
  createdAt: index + 1,
  finishedAt: index + 1
}));
const pruned = core.normalizeQueue({ items: history }, "c:history");
assert.ok(pruned.items.length <= core.MAX_HISTORY_ITEMS);
assert.ok(pruned.items.length <= 60);

console.log("queue v0.5.1 tests passed");
