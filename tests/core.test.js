const { test } = require("node:test");
const assert = require("node:assert/strict");
const Q = require("../queue-core");
const U = require("../usage-core");
const at = Date.parse("2026-09-14T12:00:00Z");
const scope = "a".repeat(64);
function added(text = "next prompt") { return Q.apply(undefined, { op: "add", id: "item-12345", text, running: true }, "tab-A", at).state; }
function claim(state = added()) { return Q.apply(state, { op: "claim", baseline: "user-before" }, "tab-A", at + 1); }

test("route keys only exist for stable formal conversations, independent of tab and project label", () => {
  for (const path of ["/", "/g/g-p-one/project", "/g/project-two/project", "/c/WEB:temporary", "/share/abc", "/plugins"]) assert.equal(Q.key(scope, "https://chatgpt.com" + path), "");
  assert.equal(Q.route("https://chatgpt.com/g/any/project").mode, "usage");
  assert.equal(Q.route("https://chatgpt.com/c/WEB:temporary").mode, "usage");
  assert.equal(Q.key(scope, "https://chatgpt.com/c/abc"), Q.key(scope, "https://chatgpt.com/g/project/c/abc"));
  assert.notEqual(Q.key(scope, "https://chatgpt.com/c/abc"), Q.key(scope, "https://chatgpt.com/g/project/c/def"));
  assert.notEqual(Q.key(scope, "https://chatgpt.com/c/abc"), Q.key("b".repeat(64), "https://chatgpt.com/c/abc"));
  assert.equal(Q.key(scope, "https://evil.example/c/abc"), "");
});
test("enqueue is idempotent and rejects overflow without truncating", () => {
  const state = added("  keep\nall spaces  ");
  assert.equal(state.items[0].text, "  keep\nall spaces  ");
  assert.equal(Q.apply(state, { op: "add", id: "item-12345", text: "different" }, "tab-A", at).state.items.length, 1);
  assert.throws(() => added("x".repeat(Q.MAX_TEXT + 1)));
  assert.equal(state.items.length, 1);
});
test("idle enqueue starts active unless the user explicitly paused the queue", () => {
  let state = Q.apply(undefined, { op: "add", id: "item-idle-1", text: "run me", running: false }, "tab-A", at).state;
  assert.equal(state.paused, false);
  state = Q.apply(state, { op: "pause", paused: true }, "tab-A", at + 1).state;
  state = Q.apply(state, { op: "add", id: "item-idle-2", text: "wait too", running: false }, "tab-A", at + 2).state;
  assert.equal(state.paused, true);
  assert.equal(state.pauseCause, "user");
});
test("one claim across tabs, with a durable intent before delivery", () => {
  const a = claim();
  assert.throws(() => Q.apply(a.state, { op: "claim", baseline: "before" }, "tab-B", at + 2));
  assert.throws(() => Q.apply(a.state, { op: "intent", id: a.item.id, claim: a.item.claim }, "tab-B", at + 2));
  const b = Q.apply(a.state, { op: "intent", id: a.item.id, claim: a.item.claim }, "tab-A", at + 2);
  assert.equal(b.state.items[0].phase, "submitting");
  assert.throws(() => Q.apply(b.state, { op: "receipt", id: a.item.id, claim: a.item.claim, userId: "new", text: "wrong" }, "tab-A", at + 3));
});
test("lease expiry before intent is reclaimable; after intent is unknown and cannot resume", () => {
  const a = claim();
  assert.equal(Q.normalize(a.state, at + 40000).items[0].state, "pending");
  const intent = Q.apply(a.state, { op: "intent", id: a.item.id, claim: a.item.claim }, "tab-A", at + 2).state;
  const recovered = Q.normalize(intent, at + 40000);
  assert.equal(recovered.items[0].state, "unknown");
  assert.throws(() => Q.apply(recovered, { op: "pause", paused: false }, "tab-B", at + 40001));
  assert.throws(() => Q.apply(recovered, { op: "claim", manual: true, id: a.item.id }, "tab-B", at + 40001));
});
test("exact delivery receipt survives refresh and deduplicates retransmitted acknowledgements", () => {
  const a = claim();
  const intent = Q.apply(a.state, { op: "intent", id: a.item.id, claim: a.item.claim }, "tab-A", at + 2).state;
  const receipt = { op: "receipt", id: a.item.id, claim: a.item.claim, userId: "user-new", text: "next prompt" };
  assert.throws(() => Q.apply(intent, { ...receipt, userId: "user-before" }, "tab-A", at + 3));
  const delivered = Q.apply(intent, receipt, "tab-B", at + 40000);
  assert.equal(delivered.state.items.length, 0);
  assert.equal(delivered.state.turn.done, false);
  assert.equal(Q.apply(delivered.state, receipt, "tab-A", at + 40001).alreadyReceived, true);
});
test("unknown delivery requires explicit resolution and stays paused", () => {
  const a = claim();
  const b = Q.apply(a.state, { op: "intent", id: a.item.id, claim: a.item.claim }, "tab-A", at + 2).state;
  const unknown = Q.normalize(b, at + 40000);
  assert.throws(() => Q.apply(unknown, { op: "resolve", id: a.item.id, retry: true }, "tab-B", at + 40001));
  const resolved = Q.apply(unknown, { op: "resolve", id: a.item.id, retry: true, confirmed: true }, "tab-B", at + 40001).state;
  assert.equal(resolved.items[0].state, "pending"); assert.equal(resolved.paused, true);
});
test("native submission hold never guesses delivery from elapsed time", () => {
  const state = Q.apply(added(), { op: "hold" }, "tab-A", at).state;
  assert.throws(() => claim(state));
  assert.throws(() => Q.apply(state, { op: "claim", baseline: "before" }, "tab-B", at + 11000));
  const resumed = Q.apply(state, { op: "pause", paused: false }, "tab-B", at + 11001).state;
  assert.equal(Q.apply(resumed, { op: "claim", baseline: "before" }, "tab-B", at + 11002).item.state, "sending");
});
test("native hold and a newer completed turn invalidate an earlier claim", () => {
  const a = claim();
  const held = Q.apply(a.state, { op: "hold" }, "tab-B", at + 2).state;
  assert.throws(() => Q.apply(held, { op: "intent", id: a.item.id, claim: a.item.claim }, "tab-A", at + 3));
  let state = Q.apply(added(), { op: "start", userId: "newer" }, "tab-B", at).state;
  state = Q.apply(state, { op: "settle", userId: "newer", assistantId: "response" }, "tab-B", at + 2).state;
  assert.throws(() => claim(state));
});
test("regeneration preserves one active turn but has distinct completion identity", () => {
  let state = Q.apply(undefined, { op: "start", userId: "user" }, "tab-A", at).state;
  state = Q.apply(state, { op: "settle", userId: "user", assistantId: "answer-one" }, "tab-A", at + 1000).state;
  state = Q.apply(state, { op: "start", userId: "user", generationId: "user:answer-two" }, "tab-A", at + 2000).state;
  assert.equal(state.turn.userId, "user");
  const done = Q.apply(state, { op: "settle", userId: "user", generationId: "user:answer-two", assistantId: "answer-two" }, "tab-A", at + 3000);
  assert.equal(done.notify, true);
  assert.equal(Q.apply(done.state, { op: "settle", userId: "user", generationId: "user:answer-two" }, "tab-B", at + 4000).notify, undefined);
});
test("simultaneous native generations in two tabs fail closed instead of replacing queue ownership", () => {
  let state = Q.apply(undefined, { op: "start", userId: "branch-a" }, "tab-A", at).state;
  const conflict = Q.apply(state, { op: "start", userId: "branch-b" }, "tab-B", at + 1);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.state.turn.id, "branch-a");
  assert.equal(conflict.state.paused, true);
  assert.ok(conflict.state.holdUntil);
  const settled = Q.apply(conflict.state, { op: "settle", userId: "branch-a" }, "tab-A", at + 2);
  assert.equal(settled.notify, false);
  assert.throws(() => Q.apply(settled.state, { op: "claim", baseline: "branch-a" }, "tab-A", at + 3));
  const resumed = Q.apply(settled.state, { op: "pause", paused: false }, "tab-A", at + 4).state;
  assert.equal(resumed.holdUntil, 0);
});
test("a newer generation from the same browser tab supersedes a missed settle without a false concurrency pause", () => {
  let state = Q.apply(undefined, { op: "start", userId: "first" }, "17:doc-a:instance-a", at).state;
  const next = Q.apply(state, { op: "start", userId: "second" }, "17:doc-b:instance-b", at + 1);
  assert.equal(next.conflict, undefined);
  assert.equal(next.state.turn.id, "second");
  assert.equal(next.state.turn.source, "17");
  assert.equal(next.state.paused, false);
  assert.ok(next.state.settled.includes("first"));
});
test("same-tab recovery does not override an explicit user pause", () => {
  let state = Q.apply(undefined, { op: "start", userId: "first" }, "17:doc-a:instance-a", at).state;
  state = Q.apply(state, { op: "pause", paused: true }, "17:doc-a:instance-a", at + 1).state;
  state = Q.apply(state, { op: "start", userId: "second" }, "17:doc-b:instance-b", at + 2).state;
  assert.equal(state.turn.id, "second");
  assert.equal(state.paused, true);
  assert.equal(state.pauseCause, "user");
  assert.equal(state.reason, "已暂停");
});
test("a legacy conflict can recover when the background proves only one tab has the conversation", () => {
  const legacy = Q.fresh();
  delete legacy.pauseCause;
  legacy.paused = true;
  legacy.reason = Q.CONFLICT_REASON;
  legacy.holdUntil = at;
  legacy.turn = { id: "old", userId: "old", at, done: false };
  const recovered = Q.apply(legacy, { op: "start", userId: "new", singleTab: true }, "17:doc-new:instance", at + 1);
  assert.equal(recovered.conflict, undefined);
  assert.equal(recovered.state.turn.id, "new");
  assert.equal(recovered.state.paused, false);
  assert.equal(recovered.state.pauseCause, "");
  assert.equal(recovered.state.holdUntil, 0);
});
test("completion with pending items does not notify; the final turn notifies once", () => {
  let state = Q.apply(added(), { op: "start", userId: "manual" }, "tab-A", at).state;
  let result = Q.apply(state, { op: "settle", userId: "manual", assistantId: "answer" }, "tab-A", at + 5000);
  assert.equal(result.notify, false);
  state = Q.apply(result.state, { op: "remove", id: "item-12345" }, "tab-A", at + 6000).state;
  state = Q.apply(state, { op: "start", userId: "last" }, "tab-A", at + 6001).state;
  result = Q.apply(state, { op: "settle", userId: "last" }, "tab-A", at + 10000);
  assert.equal(result.notify, true);
  assert.equal(Q.apply(result.state, { op: "settle", userId: "last" }, "tab-B", at + 11000).notify, undefined);
  assert.equal(Q.apply(result.state, { op: "start", userId: "last" }, "tab-B", at + 11000).state.turn.done, true);
});
test("native stop/error pauses without success notification", () => {
  const state = Q.apply(added(), { op: "start", userId: "stopped" }, "tab-A", at).state;
  const result = Q.apply(state, { op: "settle", userId: "stopped", failed: true }, "tab-A", at + 1000);
  assert.equal(result.notify, false); assert.equal(result.state.paused, true);
});
test("native Stop survives reload and does not poison the next user turn", () => {
  let state = Q.apply(undefined, { op: "start", userId: "stopped" }, "tab-A", at).state;
  state = Q.apply(state, { op: "stop", userId: "stopped" }, "tab-A", at + 1).state;
  const reloaded = Q.apply(state, { op: "settle", userId: "stopped" }, "tab-B", at + 1000);
  assert.equal(reloaded.notify, false);
  state = Q.apply(state, { op: "start", userId: "follow-up" }, "tab-A", at + 2).state;
  assert.equal(Q.apply(state, { op: "settle", userId: "follow-up" }, "tab-A", at + 1000).notify, true);
});
test("editing is revision checked and sending items cannot be deleted or reordered", () => {
  const state = added();
  assert.throws(() => Q.apply(state, { op: "edit", id: "item-12345", text: "edited", revision: 0 }, "tab-A", at));
  assert.equal(Q.apply(state, { op: "edit", id: "item-12345", text: "edited", revision: state.revision }, "tab-A", at).state.items[0].text, "edited");
  const a = claim();
  for (const op of ["edit", "remove", "move"]) assert.throws(() => Q.apply(a.state, { op, id: a.item.id, text: "edit", revision: a.state.revision }, "tab-B", at + 2));
});
test("usage starts with unknown history and no fabricated reset or remaining count", () => {
  const s = U.summary(U.fresh(at), at);
  assert.equal(s.used, 0); assert.equal(s.baselineKnown, false); assert.equal(s.resetAt, 0);
  assert.equal(s.cycleDays, 7); assert.match(s.label, /^GPT-6 · 0 \/ 50 · 刷新未知$/);
  assert.doesNotMatch(s.label, /校正|记录|计算|推算/); assert.equal(s.remaining, undefined);
});
test("manual and Queue observed receipts share the same model rules and dedup key", () => {
  let s = U.fresh(at);
  for (const [id, model] of [["turn-a","gpt-6-pro"],["turn-b","gpt-5-6-pro"],["turn-a","gpt-6-pro"],["turn-c","gpt-5-6-thinking"],["turn-d","gpt-6-astra-wm"]]) s = U.apply(s, { op: "record", turnId: id, model, at: at + 100 }, at + 100).state;
  assert.equal(U.count(s), 2);
});
test("manual correction cannot erase concurrent usage and a confirmed schedule rolls over", () => {
  let s = U.apply(U.fresh(at), { op: "record", turnId: "a", model: "gpt-6-pro", at }, at).state;
  assert.throws(() => U.apply(s, { op: "edit", revision: 0, total: 10, limit: 50 }, at));
  s = U.apply(s, { op: "edit", revision: s.revision, total: 12, limit: 50, cycleDays: 3, resetAt: at + 10000 }, at).state;
  assert.equal(U.count(s), 12);
  const next = U.normalize(s, at + 11000);
  assert.equal(U.count(next), 0); assert.equal(next.correction, 0); assert.equal(next.cycleDays, 3); assert.equal(next.resetAt, at + 10000 + U.DAY * 3);
  const later = U.normalize(s, at + 10000 + U.DAY * 3 * 5);
  assert.equal(later.resetAt, at + 10000 + U.DAY * 3 * 6);
  assert.equal(U.apply(next, { op: "record", turnId: "a", model: "gpt-6-pro", at }, at + 11000).state.entries.length, 1);
});
