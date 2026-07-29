const assert = require("node:assert/strict");
const page = require("../chatgpt-dom.js");

class FakeNode {
  constructor({ text = "", visible = true, disabled = false, attrs = {}, tag = "div", copyAction = false } = {}) {
    this.innerText = text;
    this.textContent = text;
    this.value = text;
    this.visible = visible;
    this.disabled = disabled;
    this.attrs = { ...attrs };
    this.tag = tag;
    this.copyAction = copyAction;
    this.parentElement = null;
    this.title = "";
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  getBoundingClientRect() { return this.visible ? { width: 100, height: 30 } : { width: 0, height: 0 }; }
  contains(node) { return node === this; }
  closest(selector) {
    if (selector === "button" && this.tag === "button") return this;
    if ((selector.includes("article") || selector.includes("conversation-turn")) && this.tag === "article") return this;
    return null;
  }
  matches(selector) { return selector.includes(this.tag); }
  querySelector(selector) {
    if (selector.includes("copy-turn-action-button") && this.copyAction) return new FakeNode({ tag: "button" });
    return null;
  }
  querySelectorAll() { return []; }
}

function createDocument(selectorMap, activeElement = null, readyState = "complete") {
  return {
    activeElement,
    readyState,
    querySelector(selector) { return (selectorMap.get(selector) || [])[0] || null; },
    querySelectorAll(selector) { return selectorMap.get(selector) || []; }
  };
}

const root = {
  getComputedStyle(node) {
    return { display: node.visible ? "block" : "none", visibility: "visible", opacity: "1" };
  }
};

function baseMap(composers, { send = true, assistant = [], users = [] } = {}) {
  const sendButton = new FakeNode({ tag: "button", attrs: { id: "composer-submit-button" } });
  return new Map([
    ["#prompt-textarea", composers],
    ["textarea[placeholder]", []],
    ['[contenteditable="true"][data-virtualkeyboard]', []],
    ['main [contenteditable="true"]', []],
    ["#composer-submit-button", send ? [sendButton] : []],
    ['button[data-testid*="send-button"]', []],
    ['button[data-testid*="composer-submit"]', []],
    ["main button", send ? [sendButton] : []],
    ['button[data-testid*="stop"]', []],
    ['button[aria-label*="Stop"]', []],
    ['button[aria-label*="stop"]', []],
    ['button[aria-label*="停止"]', []],
    ['button[aria-label*="中止"]', []],
    ['button[aria-label*="取消生成"]', []],
    ['main [aria-live="polite"], main [role="status"], main [data-state="loading"]', []],
    ['[role="alert"], main [data-testid*="error"], main .text-red-500', []],
    ['[data-message-author-role="assistant"]', assistant],
    ['[data-message-author-role="user"]', users],
    ['button[data-testid="copy-turn-action-button"]', assistant.filter((item) => item.copyAction).map(() => new FakeNode({ tag: "button" }))]
  ]);
}

const stale = new FakeNode({ visible: false, tag: "textarea" });
const active = new FakeNode({ visible: true, tag: "textarea" });
const documentAfterProjectNavigation = createDocument(baseMap([stale, active]), active);
assert.equal(
  page.findActiveComposer(documentAfterProjectNavigation, (node) => node.visible),
  active,
  "hidden project composers must not override the active conversation composer"
);

const healthy = page.collectPageState({
  documentRef: documentAfterProjectNavigation,
  locationRef: { href: "https://chatgpt.com/c/abc", origin: "https://chatgpt.com" },
  root,
  documentStartedAt: Date.now() - 10_000
});
assert.equal(healthy.supportStatus, "supported");
assert.equal(healthy.routeType, "conversation");
assert.equal(healthy.compatibility, "healthy");
assert.equal(healthy.capabilities.canAdmitQueue, true);
assert.equal(healthy.capabilities.canDispatchQueue, true);
assert.equal(page.toPublicSnapshot(healthy).private, undefined);
assert.equal(page.toPublicSnapshot(healthy).refs, undefined);

const emptyWithoutSend = page.collectPageState({
  documentRef: createDocument(baseMap([active], { send: false }), active),
  locationRef: { href: "https://chatgpt.com/", origin: "https://chatgpt.com" },
  root,
  documentStartedAt: Date.now() - 10_000
});
assert.equal(emptyWithoutSend.compatibility, "healthy", "an empty composer may legitimately hide the send control");
assert.equal(emptyWithoutSend.capabilities.canWriteComposer, true);
assert.equal(emptyWithoutSend.capabilities.canDispatchQueue, true, "the queue may write text before the send control appears");
assert.equal(emptyWithoutSend.capabilities.canClickSend, false, "the current page still cannot click send before text is written");

const provisional = page.classifyRoute("https://chatgpt.com/c/WEB:temporary");
assert.equal(provisional.routeType, "provisional_conversation");
assert.equal(page.classifyRoute("https://chatgpt.com/g/g-p-demo/project").routeType, "draft");
assert.equal(page.classifyRoute("https://chatgpt.com/settings").supportStatus, "unsupported");
assert.equal(page.classifyRoute("https://example.com/c/abc").routeType, "non_chatgpt");

const noComposer = page.collectPageState({
  documentRef: createDocument(baseMap([], { send: false })),
  locationRef: { href: "https://chatgpt.com/c/abc", origin: "https://chatgpt.com" },
  root,
  documentStartedAt: Date.now() - 10_000
});
assert.equal(noComposer.compatibility, "blocked");
assert.ok(noComposer.reasonCodes.includes("composer_missing"));
assert.equal(noComposer.capabilities.canDispatchQueue, false);

const hiddenOnly = page.collectPageState({
  documentRef: createDocument(baseMap([stale], { send: false })),
  locationRef: { href: "https://chatgpt.com/c/abc", origin: "https://chatgpt.com" },
  root,
  documentStartedAt: Date.now() - 10_000
});
assert.equal(hiddenOnly.compatibility, "blocked", "a stale hidden composer must not remain an admission target");
assert.ok(hiddenOnly.reasonCodes.includes("composer_missing"));
assert.equal(hiddenOnly.capabilities.canAdmitQueue, false);

const loading = page.collectPageState({
  documentRef: createDocument(baseMap([], { send: false }), null, "loading"),
  locationRef: { href: "https://chatgpt.com/c/abc", origin: "https://chatgpt.com" },
  root,
  documentStartedAt: Date.now()
});
assert.equal(loading.supportStatus, "initializing");
assert.equal(loading.compatibility, "initializing");

const first = new FakeNode({ visible: true, tag: "textarea" });
const second = new FakeNode({ visible: true, tag: "textarea" });
const ambiguous = page.collectPageState({
  documentRef: createDocument(baseMap([first, second])),
  locationRef: { href: "https://chatgpt.com/", origin: "https://chatgpt.com" },
  root,
  documentStartedAt: Date.now() - 10_000
});
assert.equal(ambiguous.compatibility, "blocked");
assert.ok(ambiguous.reasonCodes.includes("multiple_visible_composers"));

const assistant = new FakeNode({ text: "回复", tag: "article", copyAction: false });
const degraded = page.collectPageState({
  documentRef: createDocument(baseMap([active], { assistant: [assistant] }), active),
  locationRef: { href: "https://chatgpt.com/c/abc", origin: "https://chatgpt.com" },
  root,
  documentStartedAt: Date.now() - 10_000
});
assert.equal(degraded.compatibility, "degraded");
assert.ok(degraded.reasonCodes.includes("copy_action_missing"));
assert.equal(degraded.capabilities.canTrackTask, true);

assert.equal(page.install(documentAfterProjectNavigation, root), false, "v0.7.0 must not patch document.querySelector globally");
assert.equal(documentAfterProjectNavigation.querySelector("#prompt-textarea"), stale, "the native querySelector result must remain untouched");

console.log("ChatGPT page adapter v0.7.1 tests passed");
