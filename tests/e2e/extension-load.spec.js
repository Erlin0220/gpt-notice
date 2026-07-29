const { test, expect } = require("./fixtures");

const mockChatGptHtml = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>GPT Notice E2E</title></head>
  <body>
    <main>
      <article data-testid="conversation-turn-1" data-message-author-role="assistant">
        <div class="markdown">E2E_READY</div>
        <button type="button" aria-label="复制回复" data-testid="copy-turn-action-button">复制</button>
      </article>
      <form>
        <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        <button id="composer-submit-button" type="button" aria-label="发送提示">发送</button>
      </form>
    </main>
  </body>
</html>`;

async function serveMockChatGpt(context) {
  await context.route("https://chatgpt.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: mockChatGptHtml });
  });
}

test("loads Manifest V3 service worker", async ({ extensionServiceWorker }) => {
  const manifest = await extensionServiceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.version).toBe("0.7.0");
  expect(manifest.background.service_worker).toBe("background.js");
});

test("opens the extension popup with diagnostics", async ({ persistentContext, extensionId }) => {
  const popup = await persistentContext.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("h1")).toHaveText("ChatGPT 任务提醒");
  await expect(popup.locator("#testButton")).toBeVisible();
  await expect(popup.locator("#pageHealth")).toBeVisible();
  await expect(popup.locator("#copyDiagnosticsButton")).toBeVisible();
  await expect(popup.locator("#summary")).not.toHaveText("正在读取任务状态…");
});

test("keeps queue UI stable during streaming DOM updates", async ({ persistentContext, page }) => {
  await serveMockChatGpt(persistentContext);
  await page.goto("https://chatgpt.com/");
  await expect(page.locator("#chatgpt-message-queue-root")).toBeAttached();
  await page.evaluate(() => {
    window.__gptQueueButton = document.querySelector("#chatgpt-message-queue-root [data-action='enqueue']");
    const answer = document.querySelector(".markdown");
    for (let index = 0; index < 30; index += 1) answer.textContent = `E2E_STREAM_${index}`;
  });
  await page.waitForTimeout(1_200);
  expect(await page.evaluate(() => window.__gptQueueButton === document.querySelector("#chatgpt-message-queue-root [data-action='enqueue']"))).toBe(true);
});

test("allows idle admission, pauses by default, and removes reordering", async ({ persistentContext, page }) => {
  await serveMockChatGpt(persistentContext);
  await page.goto("https://chatgpt.com/");
  const composer = page.locator("#prompt-textarea");
  await expect(composer).toBeVisible();
  await composer.fill("空闲页面预存的下一条消息");
  const addButton = page.locator("#chatgpt-message-queue-root [data-action='enqueue']");
  await expect(addButton).toBeEnabled();
  await addButton.click();
  await page.locator("#chatgpt-message-queue-root .gptq-trigger").click();
  await expect(page.locator("#chatgpt-message-queue-root .gptq-item")).toHaveCount(1);
  await expect(page.locator("#chatgpt-message-queue-root .gptq-status")).toContainText("空闲页面预存队列");
  await expect(page.locator("#chatgpt-message-queue-root [data-action='up']")).toHaveCount(0);
  await expect(page.locator("#chatgpt-message-queue-root [data-action='down']")).toHaveCount(0);
  await expect(composer).toHaveText("");
});
