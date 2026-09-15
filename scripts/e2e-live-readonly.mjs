// Attach only to an explicitly selected authenticated profile. Never launch,
// restart, reload, or close the user's shared browser or existing conversations.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [profileDirectory, projectUrl, conversationUrl] = process.argv.slice(2);
if (!profileDirectory || !path.isAbsolute(profileDirectory)) throw new Error("Pass the absolute directory of the explicitly selected browser profile.");
const [port, browserPath] = fs.readFileSync(path.join(profileDirectory, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
if (!/^\d+$/.test(port) || !browserPath?.startsWith("/devtools/browser/")) throw new Error("Invalid local CDP endpoint.");
for (const value of [projectUrl, conversationUrl].filter(Boolean)) {
  const url = new URL(value);
  if (url.origin !== "https://chatgpt.com") throw new Error("Only the selected ChatGPT profile may be inspected.");
}
const source = ["queue-core.js", "chatgpt-dom.js"].map(name => fs.readFileSync(path.join(root, name), "utf8")).join("\n");
const report = { at: new Date().toISOString(), adapterSha256: crypto.createHash("sha256").update(source).digest("hex"), blockedMutations: 0, generationRequests: 0, checks: [] };
const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${browserPath}`);
const context = browser.contexts()[0];
const originalPages = context.pages();
let probe, failure;
async function inspect(page) {
  const session = await context.newCDPSession(page);
  try {
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "gpt-notice-readonly-audit" });
    await session.send("Runtime.evaluate", { contextId: executionContextId, expression: source });
    const result = await session.send("Runtime.evaluate", {
      contextId: executionContextId, awaitPromise: true, returnByValue: true,
      expression: `(async()=>{const p=ChatGPTPageAdapter.snapshot();return {mode:ChatGPTQueueCore.route(location.href).mode,scopeKnown:!!(await ChatGPTPageAdapter.scope()),composer:!!p.composer,ready:p.ready,empty:p.empty,attachments:p.attachments,outcome:p.outcome,nativeSend:!!ChatGPTPageAdapter.sendButton(),nativeStop:p.stop,hasUser:!!p.userId}})()`
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  } finally { await session.detach(); }
}
try {
  // Existing conversation: adapter facts only, no navigation or DOM mutation.
  if (conversationUrl) {
    const conversation = originalPages.find(page => page.url() === conversationUrl);
    assert.ok(conversation, "The selected conversation must already be open.");
    const facts = await inspect(conversation);
    assert.equal(facts.mode, "conversation"); assert.equal(facts.scopeKnown, true); assert.equal(facts.composer, true);
    report.checks.push({ surface: "existing-conversation-readonly", ...facts });
  }
  probe = await context.newPage();
  await probe.route("**/*", route => {
    const request = route.request();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      report.blockedMutations++;
      if (/\/backend-api\/(?:f\/)?conversation(?:\?|$)/.test(request.url())) report.generationRequests++;
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  await probe.routeWebSocket("**/*", socket => socket.close());
  for (const [surface, url] of [["home", "https://chatgpt.com/?gpt_notice_readonly_audit=1"], ...(projectUrl ? [["project", projectUrl]] : [])]) {
    await probe.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await probe.locator("#prompt-textarea").waitFor({ timeout: 30000 });
    const facts = await inspect(probe);
    assert.equal(facts.mode, "usage"); assert.equal(facts.scopeKnown, true); assert.equal(facts.composer, true);
    const host = probe.locator("#chatgpt-message-queue-root");
    assert.equal(await host.count(), 1);
    await host.locator('[data-action="usage"]').click({ timeout: 15000 });
    await host.locator(".usage-panel").waitFor({ timeout: 10000 });
    assert.equal(await host.locator('[data-action="queue"]').isVisible(), false);
    assert.equal((await inspect(probe)).empty, facts.empty, "The native draft must be unchanged.");
    report.checks.push({ surface, ...facts, usagePanel: true, queueHidden: true, draftUnchanged: true });
    await probe.screenshot({ path: path.join(root, "test-results", `live-${surface}-readonly.png`) });
  }
  assert.equal(report.generationRequests, 0, "No generation should even be attempted by this audit.");
  report.passed = true;
} catch (error) {
  failure = error;
  report.passed = false;
  report.error = String(error?.message || error);
} finally {
  if (probe) await probe.close();
  report.existingTabsPreserved = originalPages.every(page => !page.isClosed());
  fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(root, "test-results", "live-readonly-audit.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  // Exit this disposable CDP client without sending Browser.close to a shared browser.
  process.exit(failure ? 1 : 0);
}
