const { test, expect } = require("./fixtures");
const { serve } = require("./chatgpt-fixture");
const shortcut = "#gpt-notice-project-shortcuts";
const ids = ["a", "b", "c"].map(c => `g-p-${c.repeat(32)}`);
const projects = ids.map((id, i) => ({ id, short_url:`${id}-project-${i}`, display:{ name:["星河智源", "任务管理", "team-devspace"][i], emoji:i===2?"terminal":"books", theme:"#3A83F7" } }));
let requests;

test.beforeEach(async ({ persistentContext, extensionServiceWorker }) => {
  requests = [];
  await serve(persistentContext);
  await persistentContext.route("https://chatgpt.com/backend-api/**", async route => {
    requests.push({ method:route.request().method(), url:route.request().url() });
    await route.fulfill({ status:200, contentType:"application/json", body:JSON.stringify({ items:[{id:"recent",title:"当前项目最近会话",snippet:"Lightweight metadata"}] }) });
  });
  await persistentContext.addInitScript(({ projects }) => {
    if (!sessionStorage.getItem("fixture-skip-project-cache")) localStorage.setItem("cache/regression-user/regression-workspace/snorlax-history", JSON.stringify({timestamp:Date.now()-10000,value:{pages:[{items:projects.map(gizmo=>({gizmo:{gizmo}}))}]}}));
  }, { projects });
  await extensionServiceWorker.evaluate(()=>chrome.storage.local.clear());
});

test("ordinary conversation lists remain native while new-chat sections default to collapsed", async ({page,extensionServiceWorker}) => {
  await page.goto("https://chatgpt.com/?sidebar-poc=1");
  await expect.poll(()=>page.evaluate(()=>window.sidebarResults)).toHaveLength(2);
  expect((await page.evaluate(()=>window.sidebarResults.map(result=>result.status))).sort()).toEqual([200,200]);
  expect(requests.filter(request=>new URL(request.url).pathname==="/backend-api/conversations")).toHaveLength(2);
  await expect.poll(()=>extensionServiceWorker.evaluate(()=>chrome.declarativeNetRequest.getDynamicRules())).toEqual([]);
  for (const section of ["favorites","projects","chats"]) await expect(page.locator(`[data-section="${section}"]`)).toHaveAttribute("aria-expanded","false");
});

test("shortcut projects live in native sidebar flow and manual expansion is respected until the next new chat", async ({page}) => {
  await page.goto("https://chatgpt.com/c/sidebar-flow");
  await expect(page.locator(`${shortcut} [data-project-id]`)).toHaveCount(3);
  await expect(page.locator(`${shortcut}`)).toBeVisible();
  const order = await page.evaluate(() => {
    const host=document.getElementById("gpt-notice-project-shortcuts"), chats=document.querySelector('[data-native-section="chats"]');
    return host?.nextElementSibling===chats;
  });
  expect(order).toBe(true);

  const projectsButton = page.locator('[data-section="projects"]');
  if (await projectsButton.getAttribute("aria-expanded") !== "false") await projectsButton.click();
  const collapsedTop = await page.locator(shortcut).evaluate(node=>node.getBoundingClientRect().top);
  await projectsButton.click();
  const expandedTop = await page.locator(shortcut).evaluate(node=>node.getBoundingClientRect().top);
  expect(expandedTop).toBeGreaterThan(collapsedTop + 40);
  await page.waitForTimeout(2200);
  await expect(projectsButton).toHaveAttribute("aria-expanded","true");

  await page.evaluate(()=>window.routeTo('/'));
  for (const section of ["favorites","projects","chats"]) await expect(page.locator(`[data-section="${section}"]`)).toHaveAttribute("aria-expanded","false");
  await projectsButton.click();
  await page.waitForTimeout(2200);
  await expect(projectsButton).toHaveAttribute("aria-expanded","true");
  await page.evaluate(()=>window.routeTo('/c/after-new'));
  await page.waitForTimeout(1200);
  await page.evaluate(()=>window.routeTo('/'));
  await expect(projectsButton).toHaveAttribute("aria-expanded","false");
});

test("shortcut list starts with a new-chat link that opens in a new tab", async ({page,persistentContext}) => {
  await page.goto("https://chatgpt.com/c/sidebar-new-chat");
  await expect(page.locator(`${shortcut} [data-project-id]`)).toHaveCount(3);
  const first = page.locator(`${shortcut} .gn-list > li`).first().locator("[data-shortcut-new-chat]");
  await expect(first).toHaveAttribute("target", "_blank");
  await expect(first).toHaveAttribute("href", "/");
  await expect(first).toHaveText(/^(新聊天|New chat)$/);
  const original = page.url();
  const opened = persistentContext.waitForEvent("page");
  await first.click();
  const newPage = await opened; await newPage.waitForLoadState("domcontentloaded");
  await expect(newPage).toHaveURL("https://chatgpt.com/");
  await expect(page).toHaveURL(original);
  await newPage.close();
});

test("shortcut section defaults to eight rows, popup can change the limit, and native mechanics stay intact", async ({page,persistentContext,extensionId}) => {
  await page.goto("https://chatgpt.com/c/sidebar-native-shape");
  const extra = ["d","e","f","1","2","3","4","5"].map((c,i)=>({id:`g-p-${c.repeat(32)}`,short_url:`g-p-${c.repeat(32)}-extra-${i}`,display:{name:i===7?"怪物火车":`extra-${i}`,...(i===7?{}:{emoji:"terminal",theme:"#3A83F7"})}}));
  await page.evaluate(({base,extra})=>localStorage.setItem("cache/regression-user/regression-workspace/snorlax-history",JSON.stringify({timestamp:Date.now(),value:{pages:[{items:[...base,...extra].map(gizmo=>({gizmo:{gizmo}}))}]}})),{base:projects,extra});
  await expect(page.locator(`${shortcut} [data-project-id]`)).toHaveCount(8);
  const more=page.locator(`${shortcut} button`,{hasText:"查看更多"});await expect(more).toBeVisible();
  await page.evaluate(()=>{document.documentElement.style.setProperty('--text-tertiary','rgb(128, 128, 128)');document.documentElement.style.setProperty('--text-primary','rgb(255, 255, 255)');});
  await expect(more).toHaveCSS('color','rgb(128, 128, 128)');await more.hover();await expect(more).toHaveCSS('color','rgb(255, 255, 255)');await page.locator('main').hover();await expect(more).toHaveCSS('color','rgb(128, 128, 128)');
  const popup=await persistentContext.newPage();await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("#shortcutCount")).toHaveValue("8");await popup.locator("#shortcutCount").fill("4");await popup.locator("#shortcutCount").press("Tab");
  await expect(page.locator(`${shortcut} [data-project-id]`)).toHaveCount(4);await popup.close();
  await expect(page.locator(`${shortcut} [data-testid="project-folder-icon"] use`).first()).toHaveAttribute("href",/sprites-core-test\.svg#/);
  await expect(page.locator(`${shortcut} .gn-chevron use`)).toHaveAttribute("href",/chevron-down-sm$/);
  await page.locator(`${shortcut} .gn-head`).click();
  await expect(page.locator(`${shortcut} .gn-list`)).toBeHidden();
  await expect(page.locator(`${shortcut} .gn-chevron use`)).toHaveAttribute("href",/chevron-right-sm$/);
  await page.locator(`${shortcut} .gn-head`).click();
  await page.locator(`${shortcut} button`,{hasText:"查看更多"}).click();
  await expect(page.locator(`${shortcut} [data-project-id]`)).toHaveCount(11);
  const fallback = page.locator(`${shortcut} [data-project-id]`,{hasText:"怪物火车"});
  await expect(fallback.locator('[data-testid="project-folder-icon"] svg')).toHaveCount(1);
  await expect(fallback).not.toContainText("📁");
  expect(await page.locator(shortcut).evaluate(node=>getComputedStyle(node).overflowX)).toBe("clip");
});

test("projects survive refresh; names open in place while compose opens a new project tab; only current-project recents load", async ({page,persistentContext,extensionServiceWorker}) => {
  await page.goto("https://chatgpt.com/c/sidebar-projects?sidebar-poc=1");
  await expect(page.locator(`${shortcut} [data-project-id]`)).toHaveCount(3);
  await expect(page.locator(`${shortcut} [data-project-id] [data-marquee-text]`).first()).toHaveText("星河智源");
  await page.evaluate(()=>{sessionStorage.setItem("fixture-skip-project-cache","1");localStorage.removeItem("cache/regression-user/regression-workspace/snorlax-history");});
  await page.reload();
  await expect(page.locator(`${shortcut} [data-project-id]`)).toHaveCount(3);

  requests.length=0;
  await page.locator(`${shortcut} [data-project-id]`).nth(1).click();
  await expect(page).toHaveURL(`https://chatgpt.com/g/${projects[1].short_url}/project`);
  await expect(page.locator("#native-project-recents")).toHaveText("当前项目最近会话");
  await expect(page.locator(`${shortcut} [data-project-id][data-active]`)).toHaveCount(1);
  await expect(page.locator(`${shortcut} [data-project-id][data-active]`)).toHaveAttribute("data-project-id",ids[1]);
  expect(requests.filter(request=>/\/gizmos\/.*\/conversations/.test(request.url)).map(request=>new URL(request.url).pathname)).toEqual([`/backend-api/gizmos/${ids[1]}/conversations`]);

  const opened = persistentContext.waitForEvent("page");
  await page.locator(`${shortcut} [data-project-new]`).nth(2).click();
  const newPage = await opened; await newPage.waitForLoadState("domcontentloaded");
  await expect(newPage).toHaveURL(`https://chatgpt.com/g/${projects[2].short_url}/project`);
  await expect(page).toHaveURL(`https://chatgpt.com/g/${projects[1].short_url}/project`);
  expect(requests.filter(request=>request.method==="POST")).toHaveLength(0);
  await expect(page.locator(`${shortcut} [data-project-id]`)).toHaveCount(3);
  await newPage.close();
  const revision=()=>extensionServiceWorker.evaluate(async()=>Object.entries(await chrome.storage.local.get(null)).find(([key])=>key.startsWith("notice:projects:"))?.[1].revision);
  const before=await revision();await page.waitForTimeout(3500);expect(await revision()).toBe(before);
});

test("creating a conversation in a project promotes that shortcut to the top", async ({page,extensionServiceWorker}) => {
  await page.goto("https://chatgpt.com/c/sidebar-promote?sidebar-poc=1");
  await expect(page.locator(`${shortcut} [data-project-id]`)).toHaveCount(3);
  await expect(page.locator(`${shortcut} [data-project-id]`).first()).toHaveAttribute("data-project-id", ids[0]);

  await page.evaluate(path => window.routeTo(path), `/g/${projects[1].short_url}/project`);
  await page.locator("#prompt-textarea").fill("new project conversation");
  await page.locator("#composer-submit-button").click();
  await expect(page).toHaveURL(new RegExp(`/g/${projects[1].short_url}/c/project-first$`));
  await expect(page.locator(`${shortcut} [data-project-id]`).first()).toHaveAttribute("data-project-id", ids[1]);
  await expect.poll(()=>extensionServiceWorker.evaluate(async()=>Object.values(await chrome.storage.local.get(null)).find(value=>value?.items?.some(item=>item.projectId?.startsWith("g-p-")))?.items?.[0]?.projectId||"" )).toBe(ids[1]);
});

test("project first send still promotes when ChatGPT exposes a plain conversation route first", async ({page,extensionServiceWorker}) => {
  await page.goto("https://chatgpt.com/c/sidebar-promote-intermediate?sidebar-poc=1");
  await expect(page.locator(`${shortcut} [data-project-id]`)).toHaveCount(3);
  await page.evaluate(({path}) => { window.routeTo(path); window.projectFirstIntermediate = true; }, {path:`/g/${projects[1].short_url}/project`});
  await page.locator("#prompt-textarea").fill("new project conversation with intermediate route");
  await page.locator("#composer-submit-button").click();
  await expect(page).toHaveURL(/\/c\/project-first$/);
  await expect.poll(()=>extensionServiceWorker.evaluate(async()=>Object.values(await chrome.storage.local.get(null)).find(value=>value?.items?.some(item=>item.projectId?.startsWith("g-p-")))?.items?.[0]?.projectId||"" )).toBe(ids[1]);
});

test("a failed project send followed by manual navigation does not promote the project", async ({page,extensionServiceWorker}) => {
  await page.goto("https://chatgpt.com/c/sidebar-promote-cancelled?sidebar-poc=1");
  await expect(page.locator(`${shortcut} [data-project-id]`).first()).toHaveAttribute("data-project-id", ids[0]);
  await page.evaluate(path => window.routeTo(path), `/g/${projects[1].short_url}/project`);
  await page.evaluate(()=>window.clickDrops=true);
  await page.locator("#prompt-textarea").fill("this send never leaves the project page");
  await page.locator("#composer-submit-button").click();
  await page.evaluate(()=>window.routeTo("/c/existing-manual-navigation"));
  await page.waitForTimeout(1500);
  await expect(page.locator(`${shortcut} [data-project-id]`).first()).toHaveAttribute("data-project-id", ids[0]);
  await expect.poll(()=>extensionServiceWorker.evaluate(async()=>Object.values(await chrome.storage.local.get(null)).find(value=>value?.items?.some(item=>item.projectId?.startsWith("g-p-")))?.items?.[0]?.projectId||"" )).toBe(ids[0]);
});

test("project promotion survives an in-flight project refresh", async ({page,extensionServiceWorker}) => {
  await page.goto("https://chatgpt.com/c/sidebar-promote-race?sidebar-poc=1");
  await expect(page.locator(`${shortcut} [data-project-id]`)).toHaveCount(3);
  await extensionServiceWorker.evaluate(()=>{
    const original=chrome.storage.local.get.bind(chrome.storage.local);let delayed=false;
    chrome.storage.local.get=async keys=>{
      const values=Array.isArray(keys)?keys:[keys];
      if(!delayed&&values.some(key=>typeof key==="string"&&key.startsWith("notice:projects:"))){delayed=true;globalThis.__projectGetStarted=true;await new Promise(resolve=>setTimeout(resolve,1800));}
      return original(keys);
    };
  });
  await page.evaluate(path => window.routeTo(path), `/g/${projects[1].short_url}/project`);
  await expect.poll(()=>extensionServiceWorker.evaluate(()=>Boolean(globalThis.__projectGetStarted))).toBe(true);
  await page.locator("#prompt-textarea").fill("promotion must survive busy refresh");
  await page.locator("#composer-submit-button").click();
  await expect.poll(()=>extensionServiceWorker.evaluate(async()=>Object.values(await chrome.storage.local.get(null)).find(value=>value?.items?.some(item=>item.projectId?.startsWith("g-p-")))?.items?.[0]?.projectId||"" ),{timeout:6000}).toBe(ids[1]);
  await expect(page.locator(`${shortcut} [data-project-id]`).first()).toHaveAttribute("data-project-id", ids[1]);
});

test("native project cache changes update name and URL without erasing other projects, and SPA account switches do not copy old DOM", async ({page,extensionServiceWorker}) => {
  await page.goto("https://chatgpt.com/c/sidebar-updates");
  await expect(page.locator(`${shortcut} [data-project-id]`)).toHaveCount(3);
  requests.length=0;
  await page.evaluate(({id})=>{localStorage.setItem("cache/regression-user/regression-workspace/snorlax-history",JSON.stringify({timestamp:Date.now(),value:{pages:[{items:[{gizmo:{gizmo:{id,short_url:`${id}-renamed`,display:{name:"已改名",emoji:"heart",theme:"#FA423E"}}}}]}]}}));window.renderNativeProjects();},{id:ids[0]});
  await expect(page.locator(`${shortcut} [data-project-id] [data-marquee-text]`).first()).toHaveText("已改名");
  await expect(page.locator(`${shortcut} [data-project-new]`).first()).toHaveAttribute("href",`/g/${ids[0]}-renamed/project`);
  await expect(page.locator(`${shortcut} [data-project-id]`).first().locator('use')).toHaveAttribute("href",/sprites-core-test\.svg#a1bba7$/);
  expect(requests.filter(request=>/\/gizmos\//.test(request.url))).toHaveLength(0);
  const stored=await extensionServiceWorker.evaluate(async()=>Object.values(await chrome.storage.local.get(null)).find(value=>value?.items?.some(item=>item.projectId?.startsWith("g-p-"))));
  expect(stored.items.find(item=>item.projectId===ids[0]).visual).toEqual({sprite:"core",symbol:"a1bba7",color:"rgb(255, 103, 100)"});
  await expect(page.locator(`${shortcut} [data-project-id]`)).toHaveCount(3);
  await page.evaluate(({id})=>{const a=document.createElement("a");a.href=`/g/${id}-secret/project`;a.textContent="Old account DOM";document.querySelector("nav").append(a);localStorage.setItem("_account",JSON.stringify("other-workspace"));},{id:ids[1]});
  await expect(page.locator(shortcut)).toBeHidden();
  const sets=await extensionServiceWorker.evaluate(async()=>Object.entries(await chrome.storage.local.get(null)).filter(([key])=>key.startsWith("notice:projects:")).map(([,value])=>value.items));
  expect(sets.map(items=>items.length).sort()).toEqual([0,3]);
  expect(JSON.stringify(sets)).not.toContain("Old account DOM");

  const nextId=`g-p-${"d".repeat(32)}`;
  await page.evaluate(({nextId})=>{
    localStorage.removeItem("cache/regression-user/regression-workspace/snorlax-history");
    localStorage.setItem("cache/regression-user/other-workspace/snorlax-history",JSON.stringify({timestamp:Date.now(),value:{pages:[{items:[{gizmo:{gizmo:{id:nextId,short_url:`${nextId}-other`,display:{name:"Other workspace project",emoji:"heart",theme:"#FA423E"}}}}]}]}}));
    window.renderNativeProjects();
  },{nextId});
  await expect(page.locator(`${shortcut} [data-project-id="${nextId}"]`)).toHaveCount(1);
  await expect.poll(()=>extensionServiceWorker.evaluate(async nextId=>Object.values(await chrome.storage.local.get(null)).find(value=>value?.items?.some(item=>item.projectId===nextId))?.items.find(item=>item.projectId===nextId)?.visual||null,nextId)).toEqual({sprite:"core",symbol:"a1bba7",color:"rgb(255, 103, 100)"});
  await page.evaluate(()=>document.querySelector('nav a[href*="-secret/project"]')?.remove());
  await page.waitForTimeout(1200);
  await page.evaluate(({nextId})=>{const a=document.createElement("a");a.href=`/g/${nextId}-fresh/project`;a.title="Fresh workspace project";document.querySelector("nav").append(a);},{nextId});
  await expect.poll(()=>extensionServiceWorker.evaluate(async nextId=>Object.values(await chrome.storage.local.get(null)).find(value=>value?.items?.some(item=>item.projectId===nextId))?.items.find(item=>item.projectId===nextId)?.shortUrl||"",nextId)).toBe(`${nextId}-fresh`);
});

test("sidebar fallback remains navigable and collapse does not depend on sprite loading", async ({page}) => {
  await page.goto("https://chatgpt.com/c/sidebar-fallback");
  await expect(page.locator(`${shortcut} [data-project-id]`)).toHaveCount(3);
  await page.evaluate(() => {
    document.querySelectorAll('[data-native-section="projects"] [role="button"]').forEach(n => n.removeAttribute("role"));
    document.querySelectorAll('use[href]').forEach(n => n.removeAttribute("href"));
  });
  await page.waitForTimeout(1200);
  await page.locator(`${shortcut} .gn-head`).click();await expect(page.locator(`${shortcut} .gn-list`)).toBeHidden();
  await page.locator(`${shortcut} .gn-head`).click();await expect(page.locator(`${shortcut} .gn-list`)).toBeVisible();
  await page.locator(`${shortcut} [data-project-id]`).first().click();
  await expect(page).toHaveURL(`https://chatgpt.com/g/${projects[0].short_url}/project`);
});
