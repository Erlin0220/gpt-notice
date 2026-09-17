(() => {
  "use strict";
  const P = globalThis.ChatGPTProjects;
  const SETTING = "notice:sidebar-collapse-enabled";
  const LIMIT = "notice:shortcut-project-limit";
  const COOKIE = "oai-sidebar-sections";
  const HOST_ID = "gpt-notice-project-shortcuts";
  const LABELS = new Map([
    ["置顶", "favorites"], ["Pinned", "favorites"], ["Favorites", "favorites"],
    ["项目", "projects"], ["Projects", "projects"],
    ["聊天", "chats"], ["Chats", "chats"], ["Your chats", "chats"]
  ]);
  const FALLBACK = {
    section: "group/sidebar-expando-section mb-[var(--sidebar-expanded-section-margin-bottom)]",
    header: "group/sidebar-expando-section-header flex items-center justify-between pe-1.5",
    head: "text-token-text-tertiary flex w-full items-center justify-start gap-0.5 px-4 py-1.5",
    title: "__menu-label font-medium",
    main: "group __menu-item border-b border-transparent bg-clip-padding hoverable gap-1.5 transition-colors keyboard-focused:focus-ring keyboard-focused:-outline-offset-2 can-hover:group-hover/project-unfurl-row:pe-16 can-hover:group-focus-within/project-unfurl-row:pe-16 cant-hover:pe-16 has-[[data-state=open]]:pe-16 group-hover/project-unfurl-row:bg-(--menu-item-highlighted) group-focus-within/project-unfurl-row:bg-(--menu-item-highlighted)",
    actions: "text-token-text-tertiary pointer-events-none absolute inset-y-0 end-4 z-10 flex items-center gap-2 opacity-0 transition-opacity duration-100 ease-out can-hover:group-hover/project-unfurl-row:pointer-events-auto can-hover:group-hover/project-unfurl-row:opacity-100 can-hover:group-focus-within/project-unfurl-row:pointer-events-auto can-hover:group-focus-within/project-unfurl-row:opacity-100 cant-hover:pointer-events-auto cant-hover:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100",
    action: "disabled:text-token-text-tertiary pointer-events-auto disabled:pointer-events-none touch:min-h-10 keyboard-focused:*:focus-ring relative isolate flex min-h-9 items-center self-stretch rounded-e-[10px] focus:outline-none -my-2 -ms-1 ps-1 -me-2.5 pe-1.5 text-inherit interactive-label-secondary data-[state=open]:text-(--interactive-label-hover-secondary)",
    more: "group __menu-item border-b border-transparent bg-clip-padding hoverable transition-colors keyboard-focused:focus-ring keyboard-focused:-outline-offset-2 w-full"
  };

  let enabled = null, limit = 8, pendingCollapse = "", previousNewChatKey = "";
  let cachedRaw = "", cachedProjects = [], documentScope = "", changedAccount = false;
  let host = null, body = null, signature = "", expanded = true, showAll = false;
  let lastRaw = null, lastUrl = "", lastScope = "";

  function newChatKey(value = location.href) {
    try {
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin) return "";
      if (url.pathname === "/" || url.pathname === "") return "/";
      if (/\/project\/?$/.test(url.pathname) && P.route(url.href, url.origin)) return url.pathname.replace(/\/$/, "");
    } catch {}
    return "";
  }

  function preference() {
    try {
      const cookie = document.cookie.split("; ").find(value => value.startsWith(`${COOKIE}=`));
      const value = cookie ? JSON.parse(decodeURIComponent(cookie.slice(COOKIE.length + 1))) : { sectionStates: {} };
      return value && value.sectionStates && typeof value.sectionStates === "object" && !Array.isArray(value.sectionStates) ? value : null;
    } catch { return null; }
  }

  function writeCollapsedPreference() {
    const value = preference();
    if (!value) return;
    let changed = false;
    for (const key of ["favorites", "projects", "chats"]) {
      if (value.sectionStates[key] !== false) { value.sectionStates[key] = false; changed = true; }
    }
    if (changed) document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(value))}; Path=/; SameSite=Lax`;
  }

  function sectionButtons() {
    const found = new Map();
    for (const heading of document.querySelectorAll('nav button[aria-expanded] > h2')) {
      const key = LABELS.get(heading.textContent.trim());
      if (key && !found.has(key)) found.set(key, heading.parentElement);
    }
    return found;
  }

  function sectionRoot(button) {
    for (let node = button?.parentElement; node && node.tagName !== "NAV"; node = node.parentElement) {
      if (node.classList?.contains("group/sidebar-expando-section")) return node;
    }
    return button?.parentElement || null;
  }

  function finishPendingCollapse() {
    if (!pendingCollapse || enabled !== true) return;
    const buttons = sectionButtons();
    if (!["favorites", "projects", "chats"].every(key => buttons.has(key))) return;
    for (const key of ["favorites", "projects", "chats"]) {
      const button = buttons.get(key);
      if (button.getAttribute("aria-expanded") === "true") button.click();
    }
    if ([...buttons.values()].every(button => button.getAttribute("aria-expanded") === "false")) pendingCollapse = "";
  }

  function requestCollapse(value = location.href) {
    const key = newChatKey(value);
    if (!key || enabled !== true) return;
    pendingCollapse = key;
    writeCollapsedPreference();
    finishPendingCollapse();
  }

  function sample(value = location.href) {
    const key = newChatKey(value);
    if (enabled === true && key && key !== previousNewChatKey) requestCollapse(value);
    previousNewChatKey = key;
    if (!key) pendingCollapse = "";
    finishPendingCollapse();
  }

  function spriteBase(kind) {
    const use = document.querySelector(`use[href*="/cdn/assets/sprites-${kind}-"]`);
    return use?.getAttribute("href")?.split("#")[0] || "";
  }

  function setChevron() {
    const svg = host?.querySelector(".gn-chevron"), use = svg?.querySelector("use"), shell = spriteBase("shell");
    host?.querySelector(".gn-head")?.setAttribute("aria-expanded", String(expanded));
    if (body) body.hidden = !expanded;
    if (!svg || !use || !shell) return;
    host.className = host.className.replace(/sidebar-(?:expanded|collapsed)-section-margin-bottom/g, `sidebar-${expanded ? "expanded" : "collapsed"}-section-margin-bottom`);
    use.setAttribute("href", `${shell}#${expanded ? "chevron-down-sm" : "chevron-right-sm"}`);
    svg.setAttribute("class", expanded
      ? "gn-chevron invisible h-3 w-3 shrink-0 group-hover/sidebar-expando-section:visible"
      : "gn-chevron h-3 w-3 shrink-0 group-hover/sidebar-expando-section:block");
  }

  function createHost() {
    const node = document.createElement("div");
    node.id = HOST_ID;
    node.className = FALLBACK.section;
    node.style.cssText = "min-width:0;max-width:100%;overflow-x:clip";
    const header = document.createElement("div"); header.className = FALLBACK.header;
    const head = document.createElement("button"); head.type = "button"; head.className = `${FALLBACK.head} gn-head`; head.setAttribute("aria-expanded", "true");
    const title = document.createElement("h2"); title.className = `${FALLBACK.title} gn-title`; title.dataset.noSpacing = "true"; title.textContent = "快捷项目";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("width", "16"); svg.setAttribute("height", "16"); svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true"); svg.classList.add("gn-chevron");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use"); use.setAttribute("fill", "currentColor"); svg.append(use); head.append(title, svg); header.append(head);
    body = document.createElement("ul"); body.className = "m-0 list-none p-0 gn-list"; body.style.cssText = "min-width:0;max-width:100%;overflow-x:clip";
    node.append(header, body);
    head.addEventListener("click", () => { expanded = !expanded; setChevron(); });
    return node;
  }

  function copyNativeSkin() {
    if (!host) return;
    const nativeButton = sectionButtons().get("projects"), native = sectionRoot(nativeButton);
    if (!nativeButton || !native || native === host) return;
    host.className = `${native.className || FALLBACK.section}`;
    const nativeHeader = nativeButton.parentElement, header = host.firstElementChild, head = host.querySelector(".gn-head"), title = host.querySelector(".gn-title");
    if (nativeHeader?.className) header.className = nativeHeader.className;
    if (nativeButton.className) head.className = `${nativeButton.className} gn-head`;
    const nativeTitle = nativeButton.querySelector("h2");
    if (nativeTitle?.className) title.className = `${nativeTitle.className} gn-title`;
  }

  function insertionPoint() {
    const buttons = sectionButtons(), chats = buttons.get("chats");
    if (!chats) return null;
    const chatsRoot = sectionRoot(chats);
    return chatsRoot?.parentElement ? { container: chatsRoot.parentElement, anchor: chatsRoot } : null;
  }

  function mount() {
    const point = insertionPoint();
    if (!point) return false;
    if (!host) host = createHost();
    if (host.parentElement !== point.container || host.nextElementSibling !== point.anchor) point.container.insertBefore(host, point.anchor);
    copyNativeSkin(); setChevron();
    return true;
  }

  function nativeRowTemplate() {
    const native = sectionRoot(sectionButtons().get("projects"));
    const li = native?.querySelector('li [class~="group/project-unfurl-row"]')?.closest("li");
    return li || null;
  }

  function nativeRows() {
    const native = sectionRoot(sectionButtons().get("projects"));
    return [...(native?.querySelectorAll('[class~="group/project-unfurl-row"] > [role="button"][data-sidebar-item="true"]') || [])];
  }

  function visualOf(main) {
    const icon = main?.firstElementChild, svg = icon?.querySelector("svg"), use = svg?.querySelector("use[href]");
    if (!icon || !svg) return null;
    if (!use) return { sprite: "shell", symbol: "folder" };
    const href = use.getAttribute("href") || "", sprite = href.includes("sprites-core-") ? "core" : href.includes("sprites-shell-") ? "shell" : "";
    const symbol = href.split("#")[1] || "";
    if (!sprite || !symbol) return null;
    const visual = { sprite, symbol }, holder = icon.querySelector('[data-testid="project-folder-icon"]');
    const color = holder?.style?.color || "";
    if (color) visual.color = color;
    return visual;
  }

  function nativeRowFor(project) {
    const rows = nativeRows(), current = P.route(location.href, location.origin);
    if (current?.projectId === project.projectId) {
      const active = rows.find(row => row.hasAttribute("data-active"));
      if (active) return active;
    }
    return rows.find(row => row.querySelector('[data-marquee-text]')?.textContent?.trim() === project.name) || null;
  }

  function nativeMoreTemplate() {
    const native = sectionRoot(sectionButtons().get("projects"));
    const button = [...(native?.querySelectorAll("button") || [])].find(value => value.textContent.trim() === "查看更多");
    return button ? button.cloneNode(true) : null;
  }

  function makeIcon(project) {
    const nativeMain = nativeRowFor(project);
    const nativeIcon = nativeMain?.firstElementChild;
    if (nativeIcon) {
      const clone = nativeIcon.cloneNode(true);
      // Native animated folder SVGs carry document-global clip IDs. Keep their
      // exact path geometry but avoid duplicate IDs in this independent row.
      for (const node of clone.querySelectorAll("[id]")) {
        const old = node.id, next = `${project.projectId}-${old}`;
        node.id = next;
        for (const clipped of clone.querySelectorAll("[clip-path]")) if (clipped.getAttribute("clip-path") === `url(#${old})`) clipped.setAttribute("clip-path", `url(#${next})`);
      }
      return clone;
    }
    const wrap = document.createElement("div"); wrap.className = "relative flex items-center justify-center [opacity:var(--menu-item-icon-opacity,1)] icon";
    const holder = document.createElement("div"); holder.dataset.testid = "project-folder-icon";
    const visual = project.visual || visualOf(nativeMain);
    if (visual) {
      if (visual.color) holder.style.color = visual.color;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("width", "20"); svg.setAttribute("height", "20"); svg.setAttribute("viewBox", "0 0 20 20"); svg.setAttribute("class", "icon");
      svg.setAttribute("aria-hidden", "true");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use"), base = spriteBase(visual.sprite);
      if (base) use.setAttribute("href", `${base}#${visual.symbol}`); use.setAttribute("fill", "currentColor"); svg.append(use); holder.append(svg);
    } else {
      const shell = spriteBase("shell");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("width", "20"); svg.setAttribute("height", "20"); svg.setAttribute("viewBox", "0 0 20 20"); svg.setAttribute("data-icon-shape", "non-circular"); svg.setAttribute("focusable", "false"); svg.setAttribute("class", "icon"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "默认颜色，浅色模式下为黑色，深色模式下为白色 文件夹");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use"); if (shell) use.setAttribute("href", `${shell}#folder`); use.setAttribute("fill", "currentColor"); svg.append(use); holder.append(svg);
    }
    wrap.append(holder); return wrap;
  }

  function nameNode(project) {
    const grow = document.createElement("div"); grow.className = "flex min-w-0 grow items-center gap-2.5";
    const clip = document.createElement("div"); clip.className = "truncate [&:has([data-marquee-text])]:min-w-0 [&:has([data-marquee-text])]:flex-1 [&:has([data-marquee-text])]:overflow-visible";
    const text = document.createElement("span"); text.dir = "auto"; text.className = "_NCija_viewport block w-full min-w-0 whitespace-nowrap"; text.dataset.marqueeText = "true"; text.draggable = false; text.textContent = project.name;
    clip.append(text); grow.append(clip); return grow;
  }

  function makeCompose(project) {
    const actions = document.createElement("div"); actions.className = FALLBACK.actions;
    const link = document.createElement("a"); link.className = FALLBACK.action; link.href = `/g/${project.shortUrl}/project`; link.target = "_blank"; link.rel = "noopener noreferrer"; link.dataset.projectNew = project.projectId;
    link.setAttribute("aria-label", `在${project.name}中新建聊天`); link.title = `在${project.name}中新建聊天`;
    const inner = document.createElement("div"); inner.className = "flex items-center justify-center rounded-lg p-1";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("width", "20"); svg.setAttribute("height", "20"); svg.setAttribute("viewBox", "0 0 20 20"); svg.setAttribute("class", "icon-sm"); svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use"), shell = spriteBase("shell"); if (shell) use.setAttribute("href", `${shell}#compose`); use.setAttribute("fill", "currentColor"); svg.append(use); inner.append(svg); link.append(inner); actions.append(link); return actions;
  }

  function fallbackRow() {
    const li = document.createElement("li"); li.className = "list-none";
    const row = document.createElement("div"); row.className = "group/project-unfurl-row relative";
    const main = document.createElement("div"); main.className = FALLBACK.main; main.tabIndex = 0; main.role = "button"; main.dataset.fill = ""; main.dataset.sidebarItem = "true";
    main.style.cssText = "--menu-item-active:var(--interactive-bg-secondary-selected);--menu-item-background:var(--interactive-bg-secondary-default);--menu-item-highlighted:var(--interactive-bg-secondary-hover);--menu-item-open:var(--interactive-bg-secondary-press);--menu-item-pressed:var(--interactive-bg-secondary-press)";
    row.append(main); li.append(row); return li;
  }

  function projectRow(project, current) {
    const template = nativeRowTemplate();
    const li = template?.querySelector('[role="button"][data-sidebar-item="true"]') ? template.cloneNode(true) : fallbackRow();
    const row = li.querySelector('[class~="group/project-unfurl-row"]') || li.firstElementChild;
    const main = li.querySelector('[role="button"][data-sidebar-item="true"]');
    main.removeAttribute("aria-controls"); main.removeAttribute("aria-expanded"); main.removeAttribute("data-state"); main.removeAttribute("data-active"); main.dataset.projectId = project.projectId;
    main.replaceChildren(makeIcon(project), nameNode(project));
    for (const child of [...row.children].slice(1)) child.remove();
    row.append(makeCompose(project));
    if (project.projectId === current?.projectId) main.dataset.active = "";
    main.setAttribute("aria-label", project.name); main.title = project.name;
    main.addEventListener("click", () => location.assign(`/g/${project.shortUrl}/project`));
    main.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault(); location.assign(`/g/${project.shortUrl}/project`);
    });
    return li;
  }

  function moreRow() {
    const li = document.createElement("li"); li.className = "list-none";
    const native = nativeMoreTemplate(), button = native || document.createElement("button");
    button.type = "button"; button.className = native?.className || FALLBACK.more; button.textContent = "查看更多";
    button.addEventListener("click", () => { showAll = true; signature = ""; render(lastRaw, lastUrl, lastScope); }); li.append(button); return li;
  }

  function render(raw, url = location.href, scope = "") {
    lastRaw = raw; lastUrl = url; lastScope = scope;
    if (!mount()) return;
    const projects = (raw?.items || []).map(P.normalize).filter(Boolean);
    host.hidden = !scope || projects.length === 0;
    if (host.hidden) return;
    const current = P.route(url, location.origin), hasTemplate = Boolean(nativeRowTemplate());
    const nextSignature = `${scope}:${raw?.revision || 0}:${current?.projectId || ""}:${showAll}:${limit}:${hasTemplate}:${nativeRows().length}:${spriteBase("core")}:${spriteBase("shell")}`;
    if (nextSignature === signature) return;
    signature = nextSignature;
    const visible = showAll ? projects : projects.slice(0, limit);
    body.replaceChildren(...visible.map(project => projectRow(project, current)));
    if (!showAll && projects.length > limit) body.append(moreRow());
    setChevron();
  }

  function collect(scope, url) {
    const raw = globalThis.ChatGPTPageAdapter.projectCache(scope);
    if (raw !== cachedRaw) { cachedRaw = raw; cachedProjects = P.fromCache(raw); }
    const found = new Map(cachedProjects.map(project => [project.projectId, project]));
    if (documentScope && documentScope !== scope) changedAccount = true;
    documentScope = scope;
    if (changedAccount) return [...found.values()];
    for (const link of document.querySelectorAll('nav a[href*="/project"], header a[href*="/project"]')) {
      if (link.closest(`#${HOST_ID}`)) continue;
      const parsed = P.route(link.href, location.origin), label = link.querySelector('[data-marquee-text], .truncate');
      const name = (label?.textContent || link.getAttribute("title") || link.textContent || "").trim();
      const project = parsed && P.normalize({ ...parsed, name });
      if (project) found.set(project.projectId, { ...found.get(project.projectId), ...project, observedAt: 0 });
    }
    const current = P.route(url, location.origin);
    const title = /\/project\/?$/.test(new URL(url).pathname) && document.querySelector('main h1 [name="project-title"], main h1');
    const project = current && title && P.normalize({ ...current, name: title.textContent });
    if (project) found.set(project.projectId, { ...found.get(project.projectId), ...project, observedAt: 0 });
    const used = new Set();
    for (const row of nativeRows()) {
      const name = row.querySelector('[data-marquee-text]')?.textContent?.trim() || "";
      const match = row.hasAttribute("data-active") && current ? found.get(current.projectId) : [...found.values()].find(value => value.name === name && !used.has(value.projectId));
      const visual = visualOf(row);
      if (!match || !visual) continue;
      used.add(match.projectId);
      found.set(match.projectId, { ...match, visual });
    }
    return [...found.values()].slice(0, 500);
  }

  document.addEventListener("click", event => {
    const link = event.target.closest?.("a[href]");
    if (!link || link.closest(`#${HOST_ID}`) || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (newChatKey(link.href)) requestCollapse(link.href);
  }, true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (Object.hasOwn(changes, SETTING)) {
      enabled = changes[SETTING].newValue !== false;
      if (enabled) requestCollapse(location.href); else pendingCollapse = "";
    }
    if (changes[LIMIT]) { limit = changes[LIMIT].newValue || 8; signature = ""; }
  });

  void chrome.storage.local.get([SETTING, LIMIT]).then(stored => {
    enabled = stored[SETTING] !== false;
    limit = stored[LIMIT] || 8;
    if (enabled) requestCollapse(location.href);
  }).catch(() => { enabled = false; });

  globalThis.ChatGPTSidebar = { sample, collect, render };
})();
