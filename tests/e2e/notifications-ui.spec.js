const { test, expect } = require("./fixtures");
const { serve } = require("./chatgpt-fixture");
const root = "#chatgpt-message-queue-root";
const control = (page, action) => page.locator(`${root} [data-action="${action}"]:visible`);
const records = worker => worker.evaluate(async () => Object.entries(await chrome.storage.local.get(null)).filter(([k]) => k.startsWith("notice:notification:")).map(([key,n]) => ({key,...n})));

test.beforeEach(async ({ persistentContext, extensionServiceWorker }) => {
  await serve(persistentContext);
  await extensionServiceWorker.evaluate(async () => {
    await chrome.storage.local.clear();
    globalThis.noticeCalls = []; globalThis.visibleNotices = {}; globalThis.failNotices = false;
    chrome.notifications.getPermissionLevel = async () => "granted";
    chrome.notifications.create = async (id, options) => {
      if (globalThis.failNotices) throw new Error("模拟系统通知暂不可用");
      globalThis.visibleNotices[id] = options; globalThis.noticeCalls.push({op:"create",id,...options}); return id;
    };
    chrome.notifications.update = async (id, options) => {
      if (globalThis.failNotices) throw new Error("模拟系统通知暂不可用");
      if (!globalThis.visibleNotices[id]) return false;
      globalThis.visibleNotices[id] = options; globalThis.noticeCalls.push({op:"update",id,...options}); return true;
    };
  });
});

test("manual results notify individually and a three-item queue only announces its final result", async ({ page, extensionServiceWorker }) => {
  test.setTimeout(60000);
  await page.goto("https://chatgpt.com/c/notice-batch"); await expect(control(page,"queue")).toBeVisible();
  for (let i=0;i<2;i++) {
    await page.locator("#prompt-textarea").fill(`manual ${i}`); await page.locator("#composer-submit-button").click();
    await expect.poll(async () => (await records(extensionServiceWorker)).filter(n=>n.kind).length,{timeout:12000}).toBe(i+1);
  }
  await control(page,"queue").click();await control(page,"pause").click();await control(page,"close").click();
  for (let i=0;i<3;i++) {
    await page.locator("#prompt-textarea").fill(`queued ${i}`);await control(page,"add").click();
    await expect(page.locator("#prompt-textarea")).toBeEmpty();
  }
  await control(page,"queue").click();await control(page,"pause").click();
  await expect.poll(()=>page.evaluate(()=>window.sent.length),{timeout:30000}).toBe(5);
  await expect.poll(async () => (await records(extensionServiceWorker)).filter(n=>n.kind).length,{timeout:12000}).toBe(3);
  const calls=await extensionServiceWorker.evaluate(()=>globalThis.noticeCalls.filter(n=>n.op==="create"));
  expect(calls).toHaveLength(3);expect(calls[2].title).toContain("队列已完成");
  await expect(page.locator(`${root} .empty`)).toBeVisible();
});

test("failed final notification retries via the existing sampler after the turn has settled", async ({ page, extensionServiceWorker }) => {
  test.setTimeout(30000);
  await page.goto("https://chatgpt.com/c/notice-retry");await expect(control(page,"add")).toBeVisible();
  await extensionServiceWorker.evaluate(()=>{globalThis.failNotices=true;});
  await page.locator("#prompt-textarea").fill("final result survives notification failure");await page.locator("#composer-submit-button").click();
  await expect.poll(async () => (await records(extensionServiceWorker)).filter(n=>n.pendingKind).length,{timeout:12000}).toBe(1);
  await expect(page.locator(`${root} .notice`)).toContainText("系统通知暂未送达");
  await extensionServiceWorker.evaluate(()=>{globalThis.failNotices=false;});
  await expect.poll(async () => (await records(extensionServiceWorker)).filter(n=>n.kind && !n.pendingKind).length,{timeout:15000}).toBe(1);
  expect(await page.evaluate(()=>window.sent.length)).toBe(1);
  expect(await extensionServiceWorker.evaluate(()=>globalThis.noticeCalls.filter(n=>n.op==="create").length)).toBe(1);
});

test("approval and final result use independent IDs; acknowledging approval never consumes completion", async ({ page, extensionServiceWorker }) => {
  await page.goto("https://chatgpt.com/c/notice-approval");await expect(control(page,"add")).toBeVisible();
  await page.evaluate(()=>{window.autoReply=false;});
  await page.locator("#prompt-textarea").fill("wait for approval");await page.locator("#composer-submit-button").click();
  await page.evaluate(()=>{const b=document.createElement("button");b.id="native-approval";b.textContent="Allow once";window.approvalClicks=0;b.onclick=()=>window.approvalClicks++;document.querySelectorAll('[data-message-author-role="assistant"]').item(1).parentElement.append(b);});
  await expect.poll(async () => (await records(extensionServiceWorker)).filter(n=>n.kind==="attention").length,{timeout:12000}).toBe(1);
  // Simulate the durable acknowledgment written by onClosed/onClicked; unit
  // tests exercise the actual listeners. No native approval is ever clicked.
  const [approval]=await records(extensionServiceWorker);
  await extensionServiceWorker.evaluate(async key=>{const n=(await chrome.storage.local.get(key))[key];await chrome.storage.local.set({[key]:{...n,dismissedAt:Date.now()}});},approval.key);
  expect(await page.evaluate(()=>window.approvalClicks)).toBe(0);
  await page.evaluate(()=>{document.getElementById("native-approval").remove();window.finish("approved result");});
  await expect.poll(async () => (await records(extensionServiceWorker)).filter(n=>n.kind==="completed").length,{timeout:12000}).toBe(1);
  expect(new Set((await records(extensionServiceWorker)).map(n=>n.key)).size).toBe(2);
});

test("localized queue keeps order controls and paused editing without replacing native text", async ({ page }, testInfo) => {
  await page.goto("https://chatgpt.com/c/chinese-queue");await expect(control(page,"queue")).toHaveText(/队列/);
  await control(page,"queue").click();await expect(page.locator(`${root} .empty`)).toContainText("暂无待发消息");
  await control(page,"pause").click();await control(page,"close").click();
  for (const text of ["第一条待处理消息","第二条待处理消息"]) {await page.locator("#prompt-textarea").fill(text);await control(page,"add").click();}
  await page.locator("#prompt-textarea").fill("未入队的原生草稿");
  await control(page,"queue").click();await expect(page.locator(`${root} .queue-state`)).toHaveText("已暂停");
  await expect(control(page,"up").first()).toBeDisabled();await expect(control(page,"down").last()).toBeDisabled();
  await control(page,"up").last().click();await expect(page.locator(`${root} .preview`).first()).toHaveText("第二条待处理消息");
  await control(page,"edit").first().click();await page.locator(`${root} [name="edit"]`).fill("已修改的队列内容");await control(page,"save-edit").click();
  await expect(page.locator("#prompt-textarea")).toHaveText("未入队的原生草稿");
  await control(page,"queue").click();await expect(page.locator(`${root} .preview`).first()).toHaveText("已修改的队列内容");
  expect(await page.locator(`${root} .queue-panel`).innerText()).not.toMatch(/Queue|outbox|Workspace/);
  await page.screenshot({path:testInfo.outputPath("queue-paused.png")});
});

test("popup shows compact localized switches, scoped queues and honest permission state", async ({ page, persistentContext, extensionId, extensionServiceWorker }, testInfo) => {
  await page.goto("https://chatgpt.com/c/popup-reviewed");await expect(control(page,"queue")).toBeVisible();
  await extensionServiceWorker.evaluate(()=>{chrome.notifications.getPermissionLevel=async()=>"denied";});
  const popup=await persistentContext.newPage();await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByRole("switch")).toHaveCount(3);await expect(popup.locator("#permission")).toHaveText("浏览器未允许");
  await expect(popup.locator("#delivery")).toContainText("勿扰");
  await popup.locator('label:has(#notifications)').click();await expect(popup.locator("#delivery")).toHaveText("提醒已关闭，不影响消息发送。");
  await expect(popup.locator("#sidebarCollapse")).toBeChecked();await expect(popup.locator("#queue")).toBeChecked();
  expect(await popup.locator("body").evaluate(n=>n.scrollWidth<=n.clientWidth)).toBe(true);
  expect(await popup.locator("body").innerText()).not.toMatch(/Queue|Workspace/);
  await popup.screenshot({path:testInfo.outputPath("popup.png"),fullPage:true});await popup.close();
});
