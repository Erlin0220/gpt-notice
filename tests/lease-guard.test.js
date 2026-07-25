const assert = require("node:assert/strict");
const guard = require("../queue-lease-guard.js");

const olderInstance = guard.createPageInstanceId(1_000, 0.11);
const newerInstance = guard.createPageInstanceId(2_000, 0.22);
assert.ok(guard.parsePageInstanceTimestamp(newerInstance) > guard.parsePageInstanceTimestamp(olderInstance));
assert.ok(guard.compareInstanceAge(newerInstance, olderInstance) > 0);

const conversationKey = "c:test";
const queueKey = "tab:7:tab-session:c:test";
const olderLease = {
  ownerTabId: 7,
  ownerInstanceId: olderInstance,
  ownerQueueKey: queueKey,
  expiresAt: 50_000
};
const newerLease = {
  ownerTabId: 7,
  ownerInstanceId: newerInstance,
  ownerQueueKey: queueKey,
  expiresAt: 60_000
};

const newerReader = { tabId: 7, instanceId: newerInstance };
const olderReader = { tabId: 7, instanceId: olderInstance };
const otherTab = { tabId: 8, instanceId: guard.createPageInstanceId(3_000, 0.33) };

assert.deepEqual(
  guard.sanitizeLeaseMapForReader({ [conversationKey]: olderLease }, newerReader, 10_000),
  {},
  "a newer document in the same tab must be able to take over the old page instance"
);

const protectedForOlderReader = guard.sanitizeLeaseMapForReader({ [conversationKey]: newerLease }, olderReader, 10_000);
assert.equal(protectedForOlderReader[conversationKey].ownerTabId, -1, "an older page instance must see the new owner as another executor");
assert.ok(protectedForOlderReader[conversationKey].expiresAt > 10_000);

assert.deepEqual(
  guard.sanitizeLeaseMapForReader({ [conversationKey]: newerLease }, otherTab, 10_000),
  { [conversationKey]: newerLease },
  "leases owned by another Chrome tab must remain unchanged"
);

assert.deepEqual(
  guard.reconcileLeaseMaps({ [conversationKey]: olderLease }, { [conversationKey]: newerLease }, newerReader, 10_000),
  { [conversationKey]: newerLease },
  "a newer page instance may replace the old lease in the same tab"
);

assert.deepEqual(
  guard.reconcileLeaseMaps({ [conversationKey]: newerLease }, { [conversationKey]: olderLease }, olderReader, 10_000),
  { [conversationKey]: newerLease },
  "an older page instance must not steal the lease back"
);

assert.deepEqual(
  guard.reconcileLeaseMaps({ [conversationKey]: newerLease }, {}, olderReader, 10_000),
  { [conversationKey]: newerLease },
  "an older page instance must not release the newer instance's lease"
);

assert.deepEqual(
  guard.reconcileLeaseMaps({ [conversationKey]: newerLease }, {}, newerReader, 10_000),
  {},
  "the exact lease owner may release its own lease"
);

const differentTabLease = { ...newerLease, ownerTabId: 8, ownerInstanceId: otherTab.instanceId };
assert.deepEqual(
  guard.reconcileLeaseMaps({ [conversationKey]: differentTabLease }, { [conversationKey]: newerLease }, newerReader, 10_000),
  { [conversationKey]: differentTabLease },
  "an unexpired lease owned by another tab must block acquisition"
);

const expiredOtherTabLease = { ...differentTabLease, expiresAt: 9_000 };
assert.deepEqual(
  guard.reconcileLeaseMaps({ [conversationKey]: expiredOtherTabLease }, { [conversationKey]: newerLease }, newerReader, 10_000),
  { [conversationKey]: newerLease },
  "an expired lease may be acquired by the waiting tab"
);

console.log("conversation lease instance guard tests passed");
