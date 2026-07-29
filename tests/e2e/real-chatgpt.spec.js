const fs = require("node:fs");
const { test, expect } = require("./fixtures");

const realChatGptEnabled = process.env.GPT_NOTICE_REAL_CHATGPT === "1";

test.describe("real ChatGPT Team smoke", () => {
  test.skip(!realChatGptEnabled, "Set GPT_NOTICE_REAL_CHATGPT=1 to use the persisted Team profile.");

  test("reuses Team login and injects the extension", async ({ page, extensionServiceWorker }, testInfo) => {
    await page.goto("https://chatgpt.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });

    const composer = page.locator("#prompt-textarea, [contenteditable='true'][data-lexical-editor='true']").first();
    await expect(composer, "登录状态无效；真实验收请运行 npm run e2e:chrome:prepare 后连接当前已登录 Chrome").toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#chatgpt-message-queue-root")).toBeAttached({ timeout: 15_000 });

    await page.screenshot({ path: testInfo.outputPath("01-chatgpt-team-home.png"), fullPage: true });

    const diagnostic = await extensionServiceWorker.evaluate(async () => {
      const manifest = chrome.runtime.getManifest();
      const storage = await chrome.storage.local.get(null);
      const tasks = Array.isArray(storage.tasks) ? storage.tasks : Object.values(storage.tasks || {});
      const queueIndex = storage.messageQueueIndexV3 || {};
      const leases = storage.messageQueueConversationLeasesV1 || {};

      return {
        extensionVersion: manifest.version,
        taskCount: tasks.length,
        taskStatuses: tasks.reduce((result, task) => {
          const status = String(task?.status || "unknown");
          result[status] = (result[status] || 0) + 1;
          return result;
        }, {}),
        queueKeys: Object.keys(queueIndex),
        leaseKeys: Object.keys(leases),
        storageKeys: Object.keys(storage).sort()
      };
    });

    fs.writeFileSync(
      testInfo.outputPath("storage-redacted.json"),
      `${JSON.stringify(diagnostic, null, 2)}\n`,
      "utf8"
    );

    expect(diagnostic.extensionVersion).toBe("0.7.1");
  });
});
