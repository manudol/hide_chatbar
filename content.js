(() => {
  // ─── Site configs ──────────────────────────────────────────────────────────
  const SITE_CONFIGS = [
    {
      hostMatch: 'claude.ai',
      chatbarSelectors: ['[data-chat-input-container="true"]'],
      textareaSelector: '[data-testid="chat-input"]',
      injectInside: true,
    },
    {
      hostMatch: 'chatgpt.com',
      chatbarSelectors: ['#thread-bottom-container', '[data-testid*="composer"]'],
      textareaSelector: '#prompt-textarea',
      injectInside: true,
    },
    {
      hostMatch: 'perplexity.ai',
      // footer.fixed = /you/:id layout; .bottom-safeAreaInsetBottom = /search/:id layout
      chatbarSelectors: ['footer.fixed', 'footer[class*="fixed"]', '.bottom-safeAreaInsetBottom'],
      textareaSelector: '#ask-input',
      injectInside: true,
    },
    {
      hostMatch: 'gemini.google.com',
      chatbarSelectors: ['input-container'],
      textareaSelector: '.ql-editor[contenteditable="true"]',
      injectInside: false, // inject as sibling to avoid Shadow DOM issues
    },
  ];

  // ─── State ─────────────────────────────────────────────────────────────────
  const state = {
    config: null,
    chatbarEl: null,
    chatbarParentEl: null,  // stable visible reference for position tracking
    hideButtonEl: null,
    showButtonEl: null,
    isHidden: false,
    findObserver: null,
    guardObserver: null,
    guardPending: false,
    positionResizeObs: null,
    positionMutationObs: null,
  };

  // ─── Helpers ───────────────────────────────────────────────────────────────
  function getConfig() {
    const host = window.location.hostname;
    return SITE_CONFIGS.find(c => host.includes(c.hostMatch)) || null;
  }

  // Only activate on actual conversation pages, not homepages / new-chat pages
  function isActivePage() {
    const { hostname, pathname } = window.location;
    if (hostname.includes('claude.ai')) {
      return pathname !== '/' && pathname !== '/new';
    }
    if (hostname.includes('chatgpt.com')) {
      return pathname !== '/';
    }
    if (hostname.includes('perplexity.ai')) {
      return pathname !== '/';
    }
    if (hostname.includes('gemini.google.com')) {
      // /app is the main landing; conversations live at /app/<id>
      return pathname !== '/app' && pathname !== '/app/';
    }
    return false;
  }

  function queryChatbar(config) {
    for (const sel of config.chatbarSelectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // ─── Button injection ──────────────────────────────────────────────────────
  function injectButtons(chatbarEl) {
    // Guard: already injected on this exact node
    if (chatbarEl.dataset.hcbInjected === '1') return;
    chatbarEl.dataset.hcbInjected = '1';

    state.chatbarEl = chatbarEl;
    state.chatbarParentEl = chatbarEl.parentElement;

    // "Hide Chatbar" button
    const hideBtn = document.createElement('button');
    hideBtn.className = 'hcb-btn hcb-hide-btn';
    hideBtn.textContent = 'Hide Chatbar';
    hideBtn.dataset.shortcut = '⌘⇧L';
    hideBtn.addEventListener('click', hideChatbar);
    state.hideButtonEl = hideBtn;

    if (state.config.injectInside) {
      chatbarEl.prepend(hideBtn);
    } else {
      // Gemini: inject as sibling before input-container
      chatbarEl.parentElement?.insertBefore(hideBtn, chatbarEl);
    }

    // "Show Chatbar" button (fixed, appended to body once)
    if (!document.getElementById('hcb-show-btn')) {
      const showBtn = document.createElement('button');
      showBtn.id = 'hcb-show-btn';
      showBtn.className = 'hcb-btn hcb-show-btn';
      showBtn.textContent = 'Show Chatbar';
      showBtn.dataset.shortcut = '⌘⇧L';
      showBtn.addEventListener('click', showChatbar);
      document.body.appendChild(showBtn);
      state.showButtonEl = showBtn;
    } else {
      state.showButtonEl = document.getElementById('hcb-show-btn');
    }

    startGuardObserver();
  }

  // ─── Show / Hide ───────────────────────────────────────────────────────────

  const SHOW_BTN_X_OFFSET = 8; // px to shift right (compensates for sidebar visual weight)

  // rAF animation loop state for smooth sidebar tracking
  let positionAnimFrame = null;
  let positionAnimEnd = 0;

  function updateShowBtnPositionNow() {
    if (!state.isHidden || !state.showButtonEl || !state.chatbarParentEl) return;
    const rect = state.chatbarParentEl.getBoundingClientRect();
    state.showButtonEl.style.left = (rect.left + rect.width / 2 + SHOW_BTN_X_OFFSET) + 'px';
  }

  // Runs a 60fps rAF loop for `duration` ms — tracks the button through sidebar CSS transitions.
  // Multiple calls simply extend the window; the loop never stacks.
  function schedulePositionAnimation(duration = 350) {
    positionAnimEnd = performance.now() + duration;
    if (positionAnimFrame !== null) return;
    function step() {
      updateShowBtnPositionNow();
      if (performance.now() < positionAnimEnd) {
        positionAnimFrame = requestAnimationFrame(step);
      } else {
        positionAnimFrame = null;
      }
    }
    positionAnimFrame = requestAnimationFrame(step);
  }

  function startPositionTracking() {
    if (!state.chatbarParentEl) return;

    // 1. ResizeObserver on parent: catches push-type sidebars (content width changes)
    state.positionResizeObs = new ResizeObserver(() => schedulePositionAnimation());
    state.positionResizeObs.observe(state.chatbarParentEl);

    // 2. MutationObserver on the whole document tree: catches sidebar class/style
    //    changes on ANY ancestor (body, layout wrappers, etc.) — needed for Claude
    //    which toggles classes on a deep layout div, not on <body>.
    state.positionMutationObs = new MutationObserver(() => schedulePositionAnimation());
    state.positionMutationObs.observe(document.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ['class', 'style'],
    });
  }

  function stopPositionTracking() {
    state.positionResizeObs?.disconnect();
    state.positionResizeObs = null;
    state.positionMutationObs?.disconnect();
    state.positionMutationObs = null;
    if (positionAnimFrame !== null) {
      cancelAnimationFrame(positionAnimFrame);
      positionAnimFrame = null;
    }
  }

  function hideChatbar() {
    if (!state.chatbarEl) return;
    // Set initial position from chatbar rect (most accurate, before display:none)
    const rect = state.chatbarEl.getBoundingClientRect();
    state.chatbarEl.style.display = 'none';
    // Bug fix: explicitly hide the hide button — for Gemini it lives as a sibling
    // outside the chatbar, so hiding the chatbar alone won't hide it.
    if (state.hideButtonEl) state.hideButtonEl.style.display = 'none';
    if (state.showButtonEl) {
      state.showButtonEl.style.left = (rect.left + rect.width / 2 + SHOW_BTN_X_OFFSET) + 'px';
      state.showButtonEl.style.display = 'flex';
    }
    state.isHidden = true;
    startPositionTracking();
    document.addEventListener('keydown', onKeydownWhileHidden);
  }

  function showChatbar() {
    if (!state.chatbarEl) return;
    state.chatbarEl.style.display = '';
    if (state.hideButtonEl) state.hideButtonEl.style.display = '';
    if (state.showButtonEl) state.showButtonEl.style.display = 'none';
    state.isHidden = false;
    stopPositionTracking();
    document.removeEventListener('keydown', onKeydownWhileHidden);
    // Focus the textarea
    const textarea = document.querySelector(state.config.textareaSelector);
    textarea?.focus();
  }

  // ─── Typing detection ──────────────────────────────────────────────────────
  function onKeydownWhileHidden(e) {
    if (!state.isHidden) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1) {
      showChatbar();
    }
  }

  // ─── Observers ─────────────────────────────────────────────────────────────
  function attemptInjection() {
    if (!isActivePage()) return false;
    const chatbarEl = queryChatbar(state.config);
    if (!chatbarEl) return false;
    injectButtons(chatbarEl);
    return true;
  }

  function startFindObserver() {
    if (state.findObserver) return;
    state.findObserver = new MutationObserver(() => {
      if (!isActivePage()) return;
      if (attemptInjection()) {
        state.findObserver.disconnect();
        state.findObserver = null;
      }
    });
    state.findObserver.observe(document.body, { childList: true, subtree: true });
  }

  function startGuardObserver() {
    if (state.guardObserver) return;
    state.guardObserver = new MutationObserver(() => {
      if (state.guardPending) return;
      state.guardPending = true;
      requestAnimationFrame(() => {
        state.guardPending = false;
        if (!isActivePage()) return;
        const chatbarEl = queryChatbar(state.config);
        if (chatbarEl && chatbarEl.dataset.hcbInjected !== '1') {
          // Chatbar was re-rendered by the framework — re-inject
          injectButtons(chatbarEl);
        }
      });
    });
    state.guardObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ─── SPA navigation detection ───────────────────────────────────────────────
  function onNavigate() {
    // Restore chatbar before tearing down state (handles React prefetch reuse)
    if (state.chatbarEl) {
      state.chatbarEl.style.display = '';
      delete state.chatbarEl.dataset.hcbInjected;
    }
    // Remove the hide button from the DOM — if React reuses the same chatbar
    // node across navigations, nulling the reference without removing the element
    // causes a duplicate button to appear on the next injection.
    if (state.hideButtonEl) {
      state.hideButtonEl.remove();
    }
    if (state.showButtonEl) {
      state.showButtonEl.style.display = 'none';
    }
    state.chatbarEl = null;
    state.chatbarParentEl = null;
    state.hideButtonEl = null;
    state.isHidden = false;
    stopPositionTracking();
    document.removeEventListener('keydown', onKeydownWhileHidden);

    if (state.findObserver) {
      state.findObserver.disconnect();
      state.findObserver = null;
    }
    if (state.guardObserver) {
      state.guardObserver.disconnect();
      state.guardObserver = null;
    }

    // Re-init for the new page
    setTimeout(init, 300);
  }

  function startNavigationPolling() {
    // Content scripts run in an isolated JS world — wrapping history.pushState
    // in the content script does NOT intercept calls from the page's own scripts.
    // URL polling is the only reliable cross-framework detection method.
    let lastUrl = location.pathname + location.search;
    setInterval(() => {
      const url = location.pathname + location.search;
      if (url !== lastUrl) {
        lastUrl = url;
        onNavigate();
      }
    }, 300);

    // popstate handles back/forward browser navigation
    window.addEventListener('popstate', onNavigate);
  }

  // ─── Entry point ────────────────────────────────────────────────────────────
  function init() {
    state.config = getConfig();
    if (!state.config) return;
    if (!isActivePage()) return;

    if (!attemptInjection()) {
      startFindObserver();
    }
  }

  // ─── Keyboard shortcut: Cmd+\ to toggle chatbar ────────────────────────────
  function onToggleShortcut(e) {
    if (!state.chatbarEl) return;
    // Use e.code (physical key) — more reliable than e.key across modifier combos.
    // capture:true (below) ensures we fire before ProseMirror/Lexical stopPropagation.
    if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.code === 'KeyL') {
      e.preventDefault();
      state.isHidden ? showChatbar() : hideChatbar();
    }
  }

  startNavigationPolling();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init();
      document.addEventListener('keydown', onToggleShortcut, true);
    }, { once: true });
  } else {
    init();
    document.addEventListener('keydown', onToggleShortcut, true);
  }
})();
