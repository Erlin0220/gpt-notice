const assert = require("node:assert/strict");
const guard = require("../queue-lease-guard.js");

const olderInstance = guard.createPageInstanceId(1_000, 0.11);
const newerInstance = guard.createPageInstanceId(2_000, 0.22);
assert.ok(guard.parsePageInstanceTimestamp(newerInstance) > guard.parsePageInstanceTimestamp(olderInstance));
assert.ok(guard.compareInstanceAge(newerInstance, olderInstance) > 0);
assert.ok(guard.compareInstanceAge(olderInstance, newerInstance) < 0);
assert.equal(guard.compareInstanceAge(newerInstance, newerInstance), 0);

function createRoot() {
  const values = new Map();
  return {
    sessionStorage: {
      setItem(key, value) { values.set(key, String(value)); },
      getItem(key) { return values.get(key) || null; }
    }
  };
}

const firstDocument = createRoot();
const firstPrepared = guard.preparePageInstance(firstDocument, 10_000, 0.31);
assert.equal(firstPrepared, firstDocument.sessionStorage.getItem(guard.INSTANCE_STORAGE_KEY));
assert.equal(
  guard.preparePageInstance(firstDocument, 20_000, 0.41),
  firstPrepared,
  "the same document must keep one stable page-instance id"
);

const refreshedDocument = createRoot();
const refreshedPrepared = guard.preparePageInstance(refreshedDocument, 20_000, 0.41);
assert.notEqual(refreshedPrepared, firstPrepared, "a refreshed document must receive a new page-instance id");
assert.ok(guard.compareInstanceAge(refreshedPrepared, firstPrepared) > 0);

const identity = { tabId: 7, instanceId: refreshedPrepared, queueKey: "tab:7:session:c:test" };
const lease = { ...identity, ownerTabId: identity.tabId, ownerInstanceId: identity.instanceId, ownerQueueKey: identity.queueKey, leaseId: "lease-new" };
assert.equal(guard.isLeaseOwner(lease, identity), true);
assert.equal(guard.isLeaseOwner(lease, identity, "lease-new"), true);
assert.equal(guard.isLeaseOwner(lease, identity, "lease-old"), false, "a stale release must not match a newer lease id");
assert.equal(guard.isLeaseOwner({ ...lease, ownerInstanceId: olderInstance }, identity), false);
assert.equal(guard.isLeaseOwner({ ...lease, ownerTabId: 8 }, identity), false);
assert.equal(guard.isLeaseOwner({ ...lease, ownerQueueKey: "tab:7:session:c:other" }, identity), false);

assert.equal(guard.preparePageInstance({}, 30_000, 0.51), "", "missing sessionStorage must fail safely");

console.log("conversation lease page-instance and fencing tests passed");
