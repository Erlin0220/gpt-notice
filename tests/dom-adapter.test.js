const assert = require("node:assert/strict");
const dom = require("../chatgpt-dom.js");

class FakeComposer {
  constructor({ visible = true, disabled = false, ariaDisabled = "false", ariaHidden = "false" } = {}) {
    this.visible = visible;
    this.disabled = disabled;
    this.attributes = {
      "aria-disabled": ariaDisabled,
      "aria-hidden": ariaHidden
    };
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  getBoundingClientRect() { return this.visible ? { width: 100, height: 30 } : { width: 0, height: 0 }; }
  contains(node) { return node === this; }
}

function createDocument(selectorMap, activeElement = null) {
  return {
    activeElement,
    querySelector(selector) { return (selectorMap.get(selector) || [])[0] || null; },
    querySelectorAll(selector) { return selectorMap.get(selector) || []; }
  };
}

const staleProjectComposer = new FakeComposer({ visible: false });
const activeConversationComposer = new FakeComposer({ visible: true });
const selectorMap = new Map([
  ["#prompt-textarea", [staleProjectComposer, activeConversationComposer]],
  ["textarea[placeholder]", [staleProjectComposer, activeConversationComposer]],
  ['[contenteditable="true"][data-virtualkeyboard]', []],
  ['main [contenteditable="true"]', []]
]);
const documentAfterProjectNavigation = createDocument(selectorMap, activeConversationComposer);

assert.equal(
  dom.findActiveComposer(documentAfterProjectNavigation, (node) => node.visible),
  activeConversationComposer,
  "project SPA navigation must ignore the stale hidden composer and use the focused conversation composer"
);

const newestVisibleComposer = new FakeComposer({ visible: true });
const duplicateVisibleMap = new Map([
  ["#prompt-textarea", [activeConversationComposer, newestVisibleComposer]],
  ["textarea[placeholder]", []],
  ['[contenteditable="true"][data-virtualkeyboard]', []],
  ['main [contenteditable="true"]', []]
]);
assert.equal(
  dom.findActiveComposer(createDocument(duplicateVisibleMap), (node) => node.visible),
  newestVisibleComposer,
  "when ChatGPT temporarily mounts multiple visible composers, the newest candidate should win"
);

const disabledFocusedComposer = new FakeComposer({ visible: true, disabled: true });
assert.equal(
  dom.findActiveComposer(createDocument(new Map([
    ["#prompt-textarea", [disabledFocusedComposer, activeConversationComposer]],
    ["textarea[placeholder]", []],
    ['[contenteditable="true"][data-virtualkeyboard]', []],
    ['main [contenteditable="true"]', []]
  ]), disabledFocusedComposer), (node) => node.visible),
  activeConversationComposer,
  "a disabled stale composer must not override an enabled visible composer"
);

const patchedDocument = createDocument(selectorMap, activeConversationComposer);
const root = {
  getComputedStyle(node) {
    return { display: node.visible ? "block" : "none", visibility: "visible", opacity: "1" };
  }
};
assert.equal(dom.install(patchedDocument, root), true);
assert.equal(patchedDocument.querySelector("#prompt-textarea"), activeConversationComposer);
assert.equal(dom.install(patchedDocument, root), false, "the adapter must only patch one document once");

console.log("ChatGPT active composer adapter tests passed");
