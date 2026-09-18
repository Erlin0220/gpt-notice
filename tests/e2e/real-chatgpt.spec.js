const fs = require("node:fs");
const { test, expect } = require("./fixtures");
const expectedVersion = require("../../manifest.json").version;

test.describe("live ChatGPT read-only smoke", () => {
  test.skip(process.env.GPT_NOTICE_REAL_CHATGPT !== "1", "Enable explicitly with an authenticated test profile.");
  test("native homepage and usage-only UI load without sending a prompt", async ({ page, extensionServiceWorker }, testInfo) => {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await expect(page.locator("#prompt-textarea")).toBeVisible({ timeout: 30000 });
    const host = page.locator("#chatgpt-message-queue-root");
    await expect(host).toBeAttached();
    await expect(host.locator('[data-action="usage"]')).toBeVisible();
    await expect(host.locator('[data-action="queue"]')).toBeHidden();
    await host.locator('[data-action="usage"]').click();
    await expect(host.locator('.usage-source-short')).toContainText(/本机|手动/);
    const box = await host.locator('.usage-popover').boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath("live-home-usage.png") });
    const diagnostic = await extensionServiceWorker.evaluate(async () => {
      const stored = await chrome.storage.local.get(null);
      return {
        version: chrome.runtime.getManifest().version,
        conversations: Object.keys(stored).filter(k => k.startsWith("notice:conversation:")).length,
        usageRecords: Object.keys(stored).filter(k => k.startsWith("notice:usage:")).length
      };
    });
    fs.writeFileSync(testInfo.outputPath("storage-redacted.json"), JSON.stringify(diagnostic, null, 2));
    expect(diagnostic.version).toBe(expectedVersion);
  });
});
