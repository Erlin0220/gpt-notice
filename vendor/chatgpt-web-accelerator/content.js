/**
 * ChatGPT Web Accelerator - Content Script
 * 
 * Optimizes page rendering performance in long ChatGPT conversations
 * using content-visibility and DOM height-locking techniques.
 */

// Configuration State
let config = {
  enabled: true,
  mode: 'js',            // 'js' | 'css' | 'unload'
  buffer: 1.5,           // viewports buffer size
  gpuAcceleration: true,
  debugMode: false,
  customSelector: '[data-testid^="conversation-turn-"]'
};

// Internal State
let scrollContainer = null;
let intersectionObserver = null;
let mutationObserver = null;
let observedElements = new Set();
const nodeCountCache = new WeakMap();

// Logger helper
function log(...args) {
  console.log('[ChatGPT Accelerator]', ...args);
}

// 1. Initial configuration load
chrome.storage.local.get(Object.keys(config), (items) => {
  config = { ...config, ...items };
  // Migration: If the user has the old selector stored, auto-migrate to the new, more robust selector
  if (config.customSelector === 'article[data-testid^="conversation-turn-"], article') {
    config.customSelector = '[data-testid^="conversation-turn-"]';
  }
  log('Config loaded:', config);
  init();
});

// Listen for updates from Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_STATS') {
    sendResponse(getStats());
  } else if (request.type === 'UPDATE_CONFIG') {
    config = { ...config, ...request.config };
    log('Config updated:', config);
    applyConfig();
    sendResponse({ success: true });
  } else if (request.type === 'PING') {
    sendResponse({ success: true });
  }
  return true;
});

// 2. Initialize Virtualization
function init() {
  applyConfig();
  
  // Setup MutationObserver to watch for dynamic content loading
  if (mutationObserver) mutationObserver.disconnect();
  mutationObserver = new MutationObserver(handleMutations);
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
  
  // Initial scan
  scanAndVirtualize();
}

// 3. Apply active configuration settings
function applyConfig() {
  // Apply document-level debug class
  if (config.enabled && config.debugMode) {
    document.documentElement.classList.add('chatgpt-accelerator-debug');
  } else {
    document.documentElement.classList.remove('chatgpt-accelerator-debug');
  }

  // Clear existing CSS mode style tags
  removeStyleTag('chatgpt-acc-css-style');
  removeStyleTag('chatgpt-acc-gpu-style');

  // Apply GPU acceleration style if enabled
  if (config.enabled && config.gpuAcceleration) {
    const style = document.createElement('style');
    style.id = 'chatgpt-acc-gpu-style';
    style.textContent = `
      ${config.customSelector} {
        will-change: transform, opacity;
      }
    `;
    document.head.appendChild(style);
  }

  // Clear JS virtualization states if disabled or changing modes
  if (!config.enabled || config.mode !== 'js') {
    clearJSVirtualization();
  }
  if (!config.enabled || config.mode !== 'unload') {
    clearUnloadVirtualization();
  }

  if (!config.enabled) {
    log('Virtualization disabled.');
    return;
  }

  // Set up selected mode
  if (config.mode === 'css') {
    applyCssMode();
  } else if (config.mode === 'js') {
    setupIntersectionObserver();
    scanAndVirtualize();
  } else if (config.mode === 'unload') {
    setupIntersectionObserver();
    scanAndVirtualize();
  }
}

// Remove style tag helper
function removeStyleTag(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// 4. CSS Mode implementation (content-visibility: auto)
function applyCssMode() {
  log('Applying Pure CSS Mode...');
  const style = document.createElement('style');
  style.id = 'chatgpt-acc-css-style';
  style.textContent = `
    ${config.customSelector} {
      content-visibility: auto !important;
      contain-intrinsic-size: auto 150px !important;
    }
  `;
  document.head.appendChild(style);
}

// 5. JS Mode implementation (IntersectionObserver + content-visibility: hidden)
function setupIntersectionObserver() {
  if (intersectionObserver) {
    intersectionObserver.disconnect();
  }
  
  // Find current scroll container (for root margin context)
  findScrollContainer();

  // Create observer
  const rootMarginValue = `${Math.round(config.buffer * 100)}% 0px ${Math.round(config.buffer * 100)}% 0px`;
  log(`Setting up IntersectionObserver with rootMargin: ${rootMarginValue}`);
  
  intersectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const element = entry.target;
      if (entry.isIntersecting) {
        // Visible (within buffer)
        makeVisible(element);
      } else {
        // Offscreen (outside buffer)
        makeHidden(element);
      }
    });
  }, {
    root: scrollContainer,
    rootMargin: rootMarginValue
  });

  // Re-observe all already-scanned elements
  observedElements.forEach(el => {
    if (document.body.contains(el)) {
      intersectionObserver.observe(el);
    } else {
      observedElements.delete(el);
    }
  });
}

function makeVisible(element) {
  if (config.mode === 'js') {
    element.style.removeProperty('contain-intrinsic-size');
    element.classList.remove('chatgpt-accelerator-hidden');
  } else if (config.mode === 'unload') {
    element.classList.remove('chatgpt-accelerator-unloaded');
    element.style.removeProperty('height');
    element.style.removeProperty('overflow');
    // Restore children display styles
    Array.from(element.children).forEach(child => {
      child.style.removeProperty('display');
    });
  }
}

function makeHidden(element) {
  // Only optimize if we can measure a valid height (don't hide if height is 0)
  const rect = element.getBoundingClientRect();
  if (rect.height <= 0) return;

  if (config.mode === 'js') {
    element.style.setProperty('contain-intrinsic-size', `auto ${rect.height}px`);
    element.classList.add('chatgpt-accelerator-hidden');
  } else if (config.mode === 'unload') {
    element.style.setProperty('height', `${rect.height}px`);
    element.style.setProperty('overflow', 'hidden');
    element.classList.add('chatgpt-accelerator-unloaded');
    // Hide children to release browser memory/DOM rendering overhead
    Array.from(element.children).forEach(child => {
      child.style.setProperty('display', 'none', 'important');
    });
  }
}

// 6. Cleaners
function clearJSVirtualization() {
  observedElements.forEach(el => {
    el.style.removeProperty('contain-intrinsic-size');
    el.classList.remove('chatgpt-accelerator-hidden');
  });
}

function clearUnloadVirtualization() {
  observedElements.forEach(el => {
    el.classList.remove('chatgpt-accelerator-unloaded');
    el.style.removeProperty('height');
    el.style.removeProperty('overflow');
    Array.from(el.children).forEach(child => {
      child.style.removeProperty('display');
    });
  });
}

// 7. Dynamic Scroll Container and Message detection
function findScrollContainer() {
  // Locate a known message row first
  const match = document.querySelector(config.customSelector);
  if (match) {
    let parent = match.parentElement;
    while (parent) {
      const style = window.getComputedStyle(parent);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        scrollContainer = parent;
        return;
      }
      parent = parent.parentElement;
    }
  }
  scrollContainer = null; // fallback to browser viewport
}

function scanAndVirtualize() {
  if (!config.enabled || (config.mode !== 'js' && config.mode !== 'unload')) return;

  const elements = document.querySelectorAll(config.customSelector);
  let newElementsFound = false;

  elements.forEach(el => {
    if (!observedElements.has(el)) {
      observedElements.add(el);
      if (intersectionObserver) {
        intersectionObserver.observe(el);
        newElementsFound = true;
      }
    }
  });

  if (newElementsFound && !scrollContainer) {
    // Scroll container might be available now
    findScrollContainer();
    if (scrollContainer && intersectionObserver) {
      // Re-setup observer to bind to correct root
      setupIntersectionObserver();
    }
  }
}

// Handle mutations
let mutationDebounceTimeout = null;
function handleMutations(mutations) {
  let shouldScan = false;
  
  for (let mutation of mutations) {
    if (mutation.addedNodes.length > 0) {
      shouldScan = true;
      break;
    }
    // Also invalidate node count cache of mutated text blocks
    if (mutation.type === 'characterData' || mutation.type === 'childList') {
      let target = mutation.target;
      while (target && target !== document.body) {
        if (target.matches && target.matches(config.customSelector)) {
          nodeCountCache.delete(target);
          break;
        }
        target = target.parentElement;
      }
    }
  }

  if (shouldScan) {
    // Debounce scan slightly to batch DOM updates
    clearTimeout(mutationDebounceTimeout);
    mutationDebounceTimeout = setTimeout(() => {
      scanAndVirtualize();
    }, 100);
  }
}

// 8. Statistics Calculation
function getStats() {
  const elements = Array.from(document.querySelectorAll(config.customSelector));
  const totalMessages = elements.length;
  
  let optimizedMessages = 0;
  let totalNodes = 0;
  let optimizedNodes = 0;

  elements.forEach(el => {
    // Count nodes (cached for performance)
    let nodeCount = nodeCountCache.get(el);
    if (nodeCount === undefined) {
      nodeCount = el.querySelectorAll('*').length;
      nodeCountCache.set(el, nodeCount);
    }

    totalNodes += nodeCount;

    const isOptimized = el.classList.contains('chatgpt-accelerator-hidden') || 
                      el.classList.contains('chatgpt-accelerator-unloaded');
                      
    if (isOptimized) {
      optimizedMessages++;
      optimizedNodes += nodeCount;
    }
  });

  // Calculate memory savings: roughly 1.5KB per DOM node (rendering memory structure overhead)
  const memorySavedBytes = optimizedNodes * 1500; 

  return {
    enabled: config.enabled,
    mode: config.mode,
    totalMessages,
    optimizedMessages,
    totalNodes,
    optimizedNodes,
    memorySavedMB: (memorySavedBytes / (1024 * 1024)).toFixed(1),
    debugMode: config.debugMode
  };
}

