(() => {
  "use strict";
  if (globalThis.ChatGPTScrollStabilizer) return;

  const SETTING = "notice:scroll-stabilizer-enabled";
  const HOST_ID = "gpt-notice-scroll-stabilizer";
  const BOTTOM_ARM = 320;
  const BUTTON_DISTANCE = 120;
  const REPAIR_DISTANCE = 96;
  const USER_GUARD_MS = 700;
  const JUMP_LIMIT_WINDOW_MS = 1400;
  const JUMP_LIMIT = 2;

  let enabled = false;
  let scroller = null;
  let content = null;
  let turn = null;
  let lastUrl = "";
  let lastTop = 0;
  let lastHeight = 0;
  let followBottom = false;
  let pointerDown = false;
  let lastUserAt = 0;
  let userUpAt = 0;
  let raf = 0;
  let jumpRepairs = [];
  let host = null;
  let button = null;
  const events = new AbortController();

  const observer = new ResizeObserver(() => schedule());
  const now = () => performance.now();
  const metrics = target => {
    if (!target) return { top: 0, height: 0, client: 0, distance: 0 };
    const top = target.scrollTop || 0;
    const height = target.scrollHeight || 0;
    const client = target.clientHeight || 0;
    return { top, height, client, distance: Math.max(0, height - client - top) };
  };
  const editable = target => Boolean(target?.closest?.('input,textarea,[contenteditable="true"],[role="textbox"]'));
  const inside = target => scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body || Boolean(scroller?.contains?.(target));

  function ensureUi() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "position:fixed;right:24px;bottom:148px;z-index:20;pointer-events:none;display:none";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ":host{all:initial}button{pointer-events:auto;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:999px;background:Canvas;color:CanvasText;box-shadow:0 4px 18px rgba(0,0,0,.14);padding:8px 12px;font:600 12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer}button:hover{background:color-mix(in srgb,CanvasText 7%,Canvas)}button:focus-visible{outline:2px solid Highlight;outline-offset:2px}";
    button = document.createElement("button");
    button.type = "button";
    button.textContent = "↓ 最新消息";
    button.setAttribute("aria-label", "跳到最新消息");
    button.title = "跳到最新消息";
    button.addEventListener("click", event => { event.stopPropagation(); jump(); });
    shadow.append(style, button);
    document.documentElement.append(host);
  }

  function refreshButton(value = metrics(scroller)) {
    ensureUi();
    const wanted = enabled && scroller && value.distance > BUTTON_DISTANCE;
    host.style.display = wanted ? "block" : "none";
    if (wanted && globalThis.ChatGPTQueueUI?.blocksRect?.(button.getBoundingClientRect())) host.style.display = "none";
  }

  function scrollableAncestor(node) {
    for (let current = node?.parentElement; current && current !== document.body && current !== document.documentElement; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (/^(auto|scroll|overlay)$/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 8) return current;
    }
    return document.scrollingElement || document.documentElement;
  }

  function observe() {
    observer.disconnect();
    const nodes = new Set([scroller, content, turn]);
    for (const node of nodes) if (node instanceof Element) observer.observe(node);
  }

  function detach() {
    observer.disconnect();
    scroller = null;
    content = null;
    turn = null;
    followBottom = false;
    jumpRepairs = [];
    refreshButton();
  }

  function armFrom(value) {
    followBottom = value.distance <= BOTTOM_ARM;
    lastTop = value.top;
    lastHeight = value.height;
    jumpRepairs = [];
    refreshButton(value);
  }

  function attach(anchor) {
    const nextTurn = anchor?.closest?.('[data-testid^="conversation-turn-"], [data-turn-key]') || null;
    if (!nextTurn?.isConnected) { detach(); return; }
    const nextScroller = scrollableAncestor(nextTurn);
    const nextContent = nextTurn.parentElement;
    const sameRoute = lastUrl === location.href;
    const preserve = sameRoute && nextScroller === scroller ? followBottom : null;
    const changed = nextScroller !== scroller || nextContent !== content || nextTurn !== turn;
    lastUrl = location.href;
    if (!changed) { schedule(); return; }
    scroller = nextScroller;
    content = nextContent;
    turn = nextTurn;
    observe();
    const value = metrics(scroller);
    if (preserve === null) armFrom(value);
    else {
      followBottom = preserve;
      lastTop = value.top;
      lastHeight = value.height;
      refreshButton(value);
    }
  }

  function setBottom() {
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
  }

  function jump() {
    if (!enabled || !scroller) return;
    followBottom = true;
    userUpAt = 0;
    jumpRepairs = [];
    setBottom();
    const value = metrics(scroller);
    lastTop = value.top;
    lastHeight = value.height;
    refreshButton(value);
    requestAnimationFrame(() => {
      if (!enabled || !followBottom || !scroller) return;
      setBottom();
      const settled = metrics(scroller);
      lastTop = settled.top;
      lastHeight = settled.height;
      refreshButton(settled);
    });
  }

  function disarmUp(at = now()) {
    userUpAt = at;
    followBottom = false;
    jumpRepairs = [];
  }

  function check() {
    raf = 0;
    if (!enabled || !scroller) return;
    const value = metrics(scroller);
    const at = now();
    const backward = lastTop - value.top;
    const grew = value.height > lastHeight + 1;
    const abnormalJump = backward > 48;
    const canRepair = followBottom && at - userUpAt > USER_GUARD_MS && value.distance > REPAIR_DISTANCE && (grew || abnormalJump);
    if (!canRepair) {
      lastTop = value.top;
      lastHeight = value.height;
      refreshButton(value);
      return;
    }

    if (abnormalJump) {
      jumpRepairs = jumpRepairs.filter(value => at - value < JUMP_LIMIT_WINDOW_MS);
      if (jumpRepairs.length >= JUMP_LIMIT) {
        followBottom = false;
        lastTop = value.top;
        lastHeight = value.height;
        refreshButton(value);
        return;
      }
      jumpRepairs.push(at);
    }

    setBottom();
    const repaired = metrics(scroller);
    lastTop = repaired.top;
    lastHeight = repaired.height;
    refreshButton(repaired);
  }

  function schedule() {
    if (!enabled || !scroller || raf) return;
    raf = requestAnimationFrame(check);
  }

  document.addEventListener("wheel", event => {
    if (!enabled || !scroller || !inside(event.target)) return;
    const at = now();
    lastUserAt = at;
    if (event.deltaY < -1) disarmUp(at);
  }, { capture: true, passive: true, signal: events.signal });

  document.addEventListener("pointerdown", event => {
    if (!enabled || !scroller || !inside(event.target)) return;
    pointerDown = true;
    lastUserAt = now();
  }, { capture: true, passive: true, signal: events.signal });

  for (const type of ["pointerup", "pointercancel"]) addEventListener(type, () => { pointerDown = false; }, { passive: true, signal: events.signal });

  document.addEventListener("keydown", event => {
    if (!enabled || !scroller || editable(event.target)) return;
    if (!["ArrowUp", "PageUp", "Home", "ArrowDown", "PageDown", "End"].includes(event.key)) return;
    const at = now();
    lastUserAt = at;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) disarmUp(at);
  }, { capture: true, signal: events.signal });

  document.addEventListener("scroll", event => {
    if (!enabled || !scroller) return;
    const target = event.target === document ? document.scrollingElement : event.target;
    if (target !== scroller) return;
    const value = metrics(scroller);
    const at = now();
    const userDriven = pointerDown || at - lastUserAt < 180;
    if (userDriven) {
      if (value.top < lastTop - 2) disarmUp(at);
      else if (value.distance <= BOTTOM_ARM && at - userUpAt > USER_GUARD_MS) followBottom = true;
      lastTop = value.top;
      lastHeight = value.height;
      schedule();
      return;
    }
    if (followBottom && value.distance > REPAIR_DISTANCE) {
      refreshButton(value);
      schedule();
      return;
    }
    if (value.distance <= BOTTOM_ARM && at - userUpAt > USER_GUARD_MS) followBottom = true;
    lastTop = value.top;
    lastHeight = value.height;
    schedule();
  }, { capture: true, passive: true, signal: events.signal });

  const storageListener = (changes, area) => {
    if (area !== "local" || !Object.hasOwn(changes, SETTING)) return;
    enabled = changes[SETTING].newValue !== false;
    if (!enabled) {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      followBottom = false;
      refreshButton();
    } else if (turn?.isConnected && scroller) {
      observe();
      armFrom(metrics(scroller));
    }
  };
  chrome.storage.onChanged.addListener(storageListener);
  chrome.storage.local.get(SETTING, values => {
    enabled = values[SETTING] !== false;
    if (!enabled) refreshButton();
  });

  globalThis.ChatGPTScrollStabilizer = {
    sample(anchor) { if (enabled) attach(anchor); else if (anchor == null) detach(); },
    jump,
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      events.abort();
      chrome.storage.onChanged.removeListener(storageListener);
      host?.remove();
      delete globalThis.ChatGPTScrollStabilizer;
    }
  };
})();
