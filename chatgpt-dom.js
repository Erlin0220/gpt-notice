(function attachChatGPTDomAdapter(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTDomAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createChatGPTDomAdapter() {
  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    "textarea[placeholder]",
    '[contenteditable="true"][data-virtualkeyboard]',
    'main [contenteditable="true"]'
  ];

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

  return {
    COMPOSER_SELECTORS,
    collectComposerCandidates,
    isComposerEnabled,
    findActiveComposer
  };
});
