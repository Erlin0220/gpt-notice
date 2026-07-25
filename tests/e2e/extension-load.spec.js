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

test("loads Manifest V3 service worker", async ({ extensionServiceWorker }) => {
  const manifest = await extensionServiceWorker.evaluate(() => chrome.runtime.getManifest());

  expect(manifest.manifest_version).toBe(3);
  expect(manifest.version).toBe("0.6.12");
  expect(manifest.background.service_worker).toBe("background.js");
});

test("opens the extension popup", async ({ persistentContext, extensionId }) => {
  const popup = await persistentContext.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect(popup.locator("h1")).toHaveText("ChatGPT 任务提醒");
  await expect(popup.locator("#testButton")).toBeVisible();
  await expect(popup.locator("#summary")).not.toHaveText("正在读取任务状态…");
});

test("injects the queue UI into a ChatGPT page", async ({ persistentContext, page }) => {
  await persistentContext.route("https://chatgpt.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: mockChatGptHtml
    });
  });

  await page.goto("https://chatgpt.com/__gpt_notice_e2e__");

  await expect(page.locator("#chatgpt-message-queue-root")).toBeAttached();
  await expect(page.locator("#prompt-textarea")).toBeVisible();
  await expect(page.locator("#composer-submit-button")).toBeVisible();
});
