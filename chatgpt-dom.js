(function attachChatGPTDomAdapter(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTDomAdapter = api;
  if (root.document) api.install(root.document, root);
})(typeof globalThis !== "undefined" ? globalThis : this, function createChatGPTDomAdapter() {
  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    "textarea[placeholder]",
    '[contenteditable="true"][data-virtualkeyboard]',
    'main [contenteditable="true"]'
  ];
  const INSTALL_MARKER = "__CHATGPT_ACTIVE_COMPOSER_ADAPTER_INSTALLED__";

  function collectComposerCandidates(documentRef) {
    if (!documentRef || typeof documentRef.querySelectorAll !== "function") return [];
    const seen = new Set();
    const candidates = [];
    for (const selector of COMPOSER_SELECTORS) {
      for (const node of documentRef.querySelectorAll(selector)) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        candidates.push(node);
      }
    }
    return candidates;
  }

  function isComposerEnabled(node) {
    return Boolean(
      node &&
      node.disabled !== true &&
      node.getAttribute?.("aria-disabled") !== "true" &&
      node.getAttribute?.("aria-hidden") !== "true"
    );
  }

  function isElementVisible(node, root = globalThis) {
    if (!node) return false;
    const style = typeof root.getComputedStyle === "function" ? root.getComputedStyle(node) : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)) return false;
    const rect = typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
    return !rect || (rect.width > 0 && rect.height > 0);
  }

  function findActiveComposer(documentRef, isVisible = () => true) {
    const candidates = collectComposerCandidates(documentRef);
    if (!candidates.length) return null;

    const activeElement = documentRef.activeElement;
    const focused = candidates.find((node) =>
      node === activeElement || (typeof node.contains === "function" && node.contains(activeElement))
    );
    if (focused && isComposerEnabled(focused) && isVisible(focused)) return focused;

    const visibleEnabled = candidates.filter((node) => isComposerEnabled(node) && isVisible(node));
    if (visibleEnabled.length) return visibleEnabled.at(-1);

    const visible = candidates.filter((node) => isVisible(node));
    if (visible.length) return visible.at(-1);

    return candidates.at(-1) || null;
  }

  function install(documentRef, root = globalThis) {
    if (!documentRef || documentRef[INSTALL_MARKER] || typeof documentRef.querySelector !== "function") return false;
    const originalQuerySelector = documentRef.querySelector.bind(documentRef);
    Object.defineProperty(documentRef, INSTALL_MARKER, { value: true, configurable: false });
    documentRef.querySelector = function activeComposerQuerySelector(selector) {
      if (COMPOSER_SELECTORS.includes(String(selector))) {
        const composer = findActiveComposer(documentRef, (node) => isElementVisible(node, root));
        if (composer) return composer;
      }
      return originalQuerySelector(selector);
    };
    return true;
  }

  return {
    COMPOSER_SELECTORS,
    collectComposerCandidates,
    isComposerEnabled,
    isElementVisible,
    findActiveComposer,
    install
  };
});
