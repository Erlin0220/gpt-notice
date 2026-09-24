const { test, expect } = require("./fixtures");
const { serve } = require("./chatgpt-fixture");

const host = "#chatgpt-message-queue-root";
const button = (page, action) => page.locator(`${host} [data-action="${action}"]`);
const projectId = `g-p-${"a".repeat(32)}`;
const project = { id: projectId, short_url: `${projectId}-current-dom`, display: { name: "Current DOM project", emoji: "terminal", theme: "#3A83F7" } };

async function notifications(worker) {
  return worker.evaluate(() => globalThis.testNotifications || []);
}

async function installCurrentBaseline(page, path = locationPath(page)) {
  const userId = `baseline-${path}`;
  await page.evaluate(({ userId }) => window.replaceTranscriptWithCurrentTurns([{
    userId,
    responseId: "current-response-baseline",
    userText: "baseline",
    assistantText: "old response",
    completed: true
  }]), { userId });
  return userId;
}

function locationPath(page) {
  const value = new URL(page.url());
  return value.pathname;
}

test.beforeEach(async ({ persistentContext, extensionServiceWorker }) => {
  await serve(persistentContext);
  await persistentContext.addInitScript(({ project }) => {
    localStorage.setItem("cache/regression-user/regression-workspace/snorlax-history", JSON.stringify({
      timestamp: Date.now(),
      value: { pages: [{ items: [{ gizmo: { gizmo: project } }] }] }
    }));
  }, { project });
  await extensionServiceWorker.evaluate(async () => {
    await chrome.storage.local.clear();
    globalThis.testNotifications = [];
    const original = chrome.notifications.create.bind(chrome.notifications);
    chrome.notifications.create = async (id, options) => {
      globalThis.testNotifications.push({ id, options });
      return original(id, options);
    };
  });
});

test("current sidebar sections collapse and shortcut projects mount before Recent", async ({ page }) => {
  await page.goto("https://chatgpt.com/?current-dom=1");
  for (const section of ["favorites", "projects", "chats"]) {
    await expect(page.locator(`[data-section="${section}"]`)).toHaveAttribute("aria-expanded", "false");
  }
  await expect(page.locator("#gpt-notice-project-shortcuts [data-project-id]")).toHaveCount(1);
  await expect(page.locator("#gpt-notice-project-shortcuts [data-project-id] [data-testid='project-folder-icon'] svg path")).toHaveCount(1);
  await expect(page.locator("#gpt-notice-project-shortcuts [data-project-new] svg path")).toHaveCount(2);
  expect(await page.evaluate(() => {
    const hostNode = document.getElementById("gpt-notice-project-shortcuts");
    const next = hostNode?.nextElementSibling;
    return {
      next: next?.getAttribute("data-native-section") || next?.querySelector('[data-native-section="chats"]')?.getAttribute("data-native-section") || "",
      tag: hostNode?.tagName || "",
      parentContainsRecent: Boolean(next?.matches?.('[data-native-section="chats"]') || next?.querySelector?.('[data-native-section="chats"]')),
      rowUsesCurrentSidebarSkin: hostNode?.querySelector('[data-project-id]')?.classList.contains("sidebar-item") || false
    };
  })).toEqual({ next: "chats", tag: "SECTION", parentContainsRecent: true, rowUsesCurrentSidebarSkin: true });
});

test("native sidebar sections default collapsed on conversation routes", async ({ page }) => {
  await page.goto("https://chatgpt.com/c/current-dom-default-collapse?current-dom=1");
  for (const section of ["favorites", "projects", "chats"]) {
    await expect(page.locator(`[data-section="${section}"]`)).toHaveAttribute("aria-expanded", "false");
  }
});

test("shortcut project compose opens a new tab without navigating the current page", async ({ page, persistentContext }) => {
  await page.goto("https://chatgpt.com/?current-dom=1");
  const original = page.url();
  const compose = page.locator("#gpt-notice-project-shortcuts [data-project-new]").first();
  await expect(compose).toHaveAttribute("target", "_blank");
  const [newPage] = await Promise.all([
    persistentContext.waitForEvent("page"),
    compose.click()
  ]);
  await newPage.waitForLoadState("domcontentloaded");
  await expect(page).toHaveURL(original);
  await expect(newPage).toHaveURL(new RegExp(`/g/${project.short_url}/project`));
  await newPage.close();
});

test("current turn markers keep Queue delivery on the native composer", async ({ page }) => {
  await page.goto("https://chatgpt.com/c/current-dom-queue?current-dom=1");
  await expect(button(page, "add")).toBeVisible();
  await installCurrentBaseline(page);
  await page.locator('[contenteditable="true"][data-virtualkeyboard="true"]').fill("queued through current DOM");
  await button(page, "add").click();
  await expect.poll(() => page.evaluate(() => window.sent.length), { timeout: 15_000 }).toBe(1);
  expect(await page.evaluate(() => window.sent[0].text)).toBe("queued through current DOM");
  await expect(button(page, "queue")).toBeVisible();
  await expect(page.locator(`${host} .count`)).toHaveText("0", { timeout: 10_000 });
  await expect(page.locator(`${host} .status`)).not.toContainText("等待原生提交确认", { timeout: 10_000 });
});

test("current response identity and Copy action confirm a completion notification", async ({ page, extensionServiceWorker }) => {
  const path = "/c/current-dom-completion";
  await page.goto(`https://chatgpt.com${path}?current-dom=1`);
  await expect(button(page, "add")).toBeVisible();
  const baseline = await installCurrentBaseline(page, path);
  await page.evaluate(() => { window.autoReply = false; });
  await page.locator('[contenteditable="true"][data-virtualkeyboard="true"]').fill("manual current DOM completion");
  await page.locator("#composer-submit-button").click();
  const sent = await page.evaluate(() => window.sent[0]);
  await page.evaluate(({ baseline, sent }) => window.replaceTranscriptWithCurrentTurns([
    { userId: baseline, responseId: "current-response-baseline", userText: "baseline", assistantText: "old response", completed: true },
    { userId: sent.id, searchTurnKey: "fallback-turn-1", userText: sent.text, assistantText: "thinking", completed: false }
  ]), { baseline, sent });
  await page.waitForTimeout(1200);
  await page.evaluate(({ baseline, sent }) => {
    document.querySelector('[data-testid="stop-button"]')?.remove();
    window.replaceTranscriptWithCurrentTurns([
      { userId: baseline, responseId: "current-response-baseline", userText: "baseline", assistantText: "old response", completed: true },
      { userId: sent.id, searchTurnKey: "fallback-turn-1", responseId: "current-response-finished", userText: sent.text, assistantText: "finished response", completed: true }
    ]);
  }, { baseline, sent });
  await expect.poll(async () => (await notifications(extensionServiceWorker)).length, { timeout: 15_000 }).toBe(1);
});

test("current data-turn-key nodes receive long-chat content visibility", async ({ page }) => {
  await page.goto("https://chatgpt.com/c/current-dom-perf?current-dom=1");
  await installCurrentBaseline(page);
  await expect.poll(() => page.locator('[data-turn-key]').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).contentVisibility))).toEqual(["auto"]);
});

test("current data-turn-key owns tool-call compaction", async ({ page }) => {
  await page.goto("https://chatgpt.com/c/current-dom-tools?current-dom=1");
  await installCurrentBaseline(page);
  await page.evaluate(() => {
    const turn = document.querySelector('[data-turn-key]');
    const flow = document.createElement("div");
    flow.id = "current-tool-flow";
    for (let i = 0; i < 2; i += 1) {
      const row = document.createElement("div");
      row.className = "contents";
      const marker = document.createElement("div");
      marker.className = "group/tool-message";
      marker.textContent = `tool ${i}`;
      row.append(marker);
      flow.append(row);
    }
    turn.append(flow);
  });
  await expect(page.locator("#current-tool-flow")).toHaveAttribute("data-gpt-notice-tool-flow", "compact", { timeout: 5_000 });
  await expect(page.locator('#current-tool-flow > [data-gpt-notice-tool-row="hidden"]')).toHaveCount(1);
});

test("scroll stabilizer follows the latest current turn and still repairs non-user jumps", async ({ page }) => {
  await page.goto("https://chatgpt.com/c/current-dom-scroll?current-dom=1");
  await expect(button(page, "add")).toBeVisible();
  await page.evaluate(() => {
    const entries = Array.from({ length: 16 }, (_, index) => ({
      userId: `current-scroll-${index}`,
      responseId: `current-scroll-response-${index}`,
      userText: `user ${index}`,
      assistantText: `assistant ${index}`,
      completed: true
    }));
    window.replaceTranscriptWithCurrentTurns(entries);
    const messages = document.getElementById("messages");
    const root = document.createElement("div");
    root.id = "current-scroll-root";
    root.style.cssText = "height:420px;overflow-y:auto";
    messages.parentElement.insertBefore(root, messages);
    root.append(messages);
    for (const turn of messages.querySelectorAll('[data-turn-key]')) turn.style.minHeight = "170px";
    root.scrollTop = root.scrollHeight;
  });
  await page.waitForTimeout(1300);
  await page.evaluate(() => {
    const root = document.getElementById("current-scroll-root");
    root.scrollTop = Math.max(0, root.scrollTop - 220);
  });
  await expect.poll(() => page.evaluate(() => {
    const root = document.getElementById("current-scroll-root");
    return root.scrollHeight - root.clientHeight - root.scrollTop;
  }), { timeout: 3_000 }).toBeLessThan(12);
});
