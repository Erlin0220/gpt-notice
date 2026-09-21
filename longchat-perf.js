(() => {
  "use strict";
  if (globalThis.ChatGPTLongChatPerf) return;
  const SETTING = "enabled";
  const CLASS = "gpt-notice-longchat-perf";

  function clearLegacyVirtualization(doc = document) {
    doc.getElementById("chatgpt-acc-css-style")?.remove();
    doc.getElementById("chatgpt-acc-gpu-style")?.remove();
    for (const element of doc.querySelectorAll(".chatgpt-accelerator-hidden,.chatgpt-accelerator-unloaded")) {
      const unloaded = element.classList.contains("chatgpt-accelerator-unloaded");
      element.classList.remove("chatgpt-accelerator-hidden", "chatgpt-accelerator-unloaded");
      element.style.removeProperty("contain-intrinsic-size");
      element.style.removeProperty("height");
      element.style.removeProperty("overflow");
      if (unloaded) for (const child of element.children) child.style.removeProperty("display");
    }
  }

  function apply(enabled) {
    document.documentElement.classList.toggle(CLASS, enabled !== false);
  }

  clearLegacyVirtualization();
  chrome.storage.local.get(SETTING, values => apply(values[SETTING] !== false));
  const storageListener = (changes, area) => {
    if (area === "local" && Object.hasOwn(changes, SETTING)) apply(changes[SETTING].newValue !== false);
  };
  chrome.storage.onChanged.addListener(storageListener);
  globalThis.ChatGPTLongChatPerf = {
    dispose() {
      chrome.storage.onChanged.removeListener(storageListener);
      document.documentElement.classList.remove(CLASS);
      delete globalThis.ChatGPTLongChatPerf;
    }
  };
})();
