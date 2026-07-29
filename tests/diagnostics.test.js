const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
const diagnostics = require("../diagnostics.js");

const sensitive = [
  "https://chatgpt.com/c/secret-conversation",
  "Bearer abc.def.ghi",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
  "C:\\Users\\clin\\project\\secret.txt",
  "person@example.com",
  "api_key=sk-1234567890abcdefghijklmnop",
  "Cookie: session=secret"
].join(" ");
const sanitized = diagnostics.sanitizeText(sensitive, 500);
assert.ok(!sanitized.includes("secret-conversation"));
assert.ok(!sanitized.includes("person@example.com"));
assert.ok(!sanitized.includes("C:\\Users"));
assert.ok(!sanitized.includes("sk-123456"));
assert.ok(!sanitized.includes("session=secret"));

const now = Date.now();
let events = [];
events = diagnostics.mergeEvent(events, {
  type: "page.compatibility_blocked",
  result: "blocked",
  reasonCode: "composer_missing",
  module: "page-adapter",
  summary: sensitive
}, now);
events = diagnostics.mergeEvent(events, {
  type: "page.compatibility_blocked",
  result: "blocked",
  reasonCode: "composer_missing",
  module: "page-adapter"
}, now + 1_000);
assert.equal(events.length, 1);
assert.equal(events[0].count, 2);
assert.ok(!events[0].summary.includes("person@example.com"));

const stale = { ...events[0], firstSeenAt: now - diagnostics.MAX_EVENT_AGE_MS - 1, lastSeenAt: now - diagnostics.MAX_EVENT_AGE_MS - 1 };
assert.equal(diagnostics.pruneEvents([stale], now).length, 0);
const many = Array.from({ length: 240 }, (_, index) => ({
  type: `test.${index}`,
  result: "ok",
  lastSeenAt: now + index,
  firstSeenAt: now + index
}));
assert.equal(diagnostics.pruneEvents(many, now + 300).length, diagnostics.MAX_EVENTS);

(async () => {
  const salt = diagnostics.createSalt();
  const firstAlias = await diagnostics.hashIdentifier(salt, "c:secret", "session");
  const secondAlias = await diagnostics.hashIdentifier(salt, "c:secret", "session");
  const otherAlias = await diagnostics.hashIdentifier(salt, "c:other", "session");
  assert.equal(firstAlias, secondAlias);
  assert.notEqual(firstAlias, otherAlias);
  assert.ok(!firstAlias.includes("secret"));

  const report = diagnostics.buildReport({
    extensionVersion: "0.7.0",
    manifestVersion: 3,
    browserMajorVersion: "150",
    platform: "Windows",
    notificationPermission: "granted",
    tasks: [{
      id: "raw-task-id",
      status: "running",
      title: "秘密问题",
      prompt: sensitive,
      assistantFirstLine: "秘密回复",
      observerMode: "current_page",
      startedAt: now,
      updatedAt: now,
      url: "https://chatgpt.com/c/secret"
    }],
    queueIndex: {
      "tab:7:page-secret:c:secret": {
        paused: true,
        pauseReason: "页面兼容性受阻",
        activeItemId: null,
        items: [{ id: "raw-item", status: "pending", textLength: 12345 }]
      }
    },
    leases: { "c:secret": { ownerTabId: 7 } },
    currentPage: {
      schemaVersion: 1,
      observedAt: now,
      supportStatus: "supported",
      routeType: "conversation",
      compatibility: "blocked",
      reasonCodes: ["composer_missing"],
      capabilities: { canAdmitQueue: false },
      composer: { exists: false, ready: false, empty: true, textLengthBucket: "empty" },
      controls: {},
      error: { visible: false },
      messages: { userCount: 1, assistantCount: 1 }
    },
    events
  });
  const json = JSON.stringify(report);
  const markdown = diagnostics.toMarkdown(report);
  for (const forbidden of ["秘密问题", "秘密回复", "raw-task-id", "raw-item", "page-secret", "c:secret", "secret-conversation", "person@example.com"]) {
    assert.ok(!json.includes(forbidden), `JSON must not expose ${forbidden}`);
    assert.ok(!markdown.includes(forbidden), `Markdown must not expose ${forbidden}`);
  }
  assert.equal(report.queues.totalTextBucket, "10k-100k");
  assert.equal(report.currentPage.compatibility, "blocked");
  assert.match(markdown, /gpt-notice 诊断摘要/);
  console.log("diagnostics v0.7.0 tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
