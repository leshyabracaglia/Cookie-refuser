// Cookie Refuser - Content Script
// Automatically finds and clicks "deny/reject" buttons on cookie consent banners.

(function () {
  "use strict";

  const browserAPI = typeof browser !== "undefined" ? browser : chrome;

  // Patterns that match "deny/reject cookies" buttons across languages
  const DENY_BUTTON_PATTERNS = [
    // English
    /\breject\s*(all)?\s*(cookies)?\b/i,
    /\bdeny\s*(all)?\s*(cookies)?\b/i,
    /\bdecline\s*(all)?\s*(cookies)?\b/i,
    /\brefuse\s*(all)?\s*(cookies)?\b/i,
    /\bno\s*,?\s*thanks\b/i,
    /\bonly\s*necessary\b/i,
    /\bnecessary\s*(?:cookies?\s*)?only\b/i,
    /\bonly\s*essentials?\b/i,
    /\bessentials?\s*only\b/i,
    /\bonly\s*required\b/i,
    /\b(?:agree|accept|allow|continue)\s+(?:to\s+|with\s+)?(?:the\s+)?(?:only\s+)?(?:necessary|essentials?)\b/i,
    /\bdo\s*not\s*(allow|accept|consent)\b/i,
    /\bopt[\s-]*out\b/i,
    /\bi\s*do\s*not\s*agree\b/i,
    /\bi\s*disagree\b/i,
    /\bdisagree\b/i,

    // German
    /\balle\s*ablehnen\b/i,
    /\bablehnen\b/i,
    /\bnur\s*notwendige\b/i,
    /\bnur\s*erforderliche\b/i,

    // French
    /\btout\s*refuser\b/i,
    /\brefuser\b/i,
    /\bcontinuer\s*sans\s*accepter\b/i,

    // Spanish
    /\brechazar\s*(todo|todas)?\b/i,
    /\bsolo\s*(las\s*)?necesarias\b/i,

    // Italian
    /\brifiuta\s*(tutto|tutti)?\b/i,
    /\bsolo\s*(i\s*)?necessari\b/i,

    // Dutch
    /\bweiger(en)?\s*(alles|alle)?\b/i,
    /\balleen\s*noodzakelijk\b/i,

    // Portuguese
    /\brecusar\s*(tudo|todos)?\b/i,
    /\bapenas\s*(os\s*)?necess[aá]rios\b/i,

    // Polish
    /\bodrzuć\s*(wszystk[ie]+)?\b/i,
    /\btylko\s*wymagane\b/i,

    // Swedish
    /\bavvisa\s*(alla)?\b/i,
    /\bendast\s*nödvändiga\b/i,
  ];

  // Selectors for common cookie consent banner containers
  const BANNER_SELECTORS = [
    "#onetrust-banner-sdk",
    "#CybotCookiebotDialog",
    "#cookiebanner",
    "#cookie-banner",
    "#cookie-consent",
    "#cookie-notice",
    "#cookie-popup",
    "#cookie-bar",
    "#cookie-law-info-bar",
    "#gdpr-cookie-notice",
    "#consent-banner",
    "#privacy-banner",
    '[class*="cookie-banner"]',
    '[class*="cookie-consent"]',
    '[class*="cookie-notice"]',
    '[class*="cookie-popup"]',
    '[class*="cookieBanner"]',
    '[class*="cookieConsent"]',
    '[class*="consent-banner"]',
    '[class*="consent-modal"]',
    '[class*="gdpr"]',
    '[class*="CookieConsent"]',
    '[id*="cookie-law"]',
    '[id*="cookie-consent"]',
    '[aria-label*="cookie" i]',
    '[aria-label*="consent" i]',
    '[role="dialog"][class*="cookie" i]',
    '[role="dialog"][class*="consent" i]',
    ".cc-banner",
    ".cc-window",
    ".cc-dialog",
    ".cmp-container",
  ];

  // Selectors for known deny/reject buttons on popular CMP platforms
  const KNOWN_DENY_SELECTORS = [
    // OneTrust
    "#onetrust-reject-all-handler",
    ".onetrust-close-btn-handler",

    // Cookiebot
    "#CybotCookiebotDialogBodyButtonDecline",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll",

    // Quantcast / TCF
    '[class*="qc-cmp2-summary-buttons"] button:last-child',
    ".qc-cmp-button[onclick*='reject']",

    // Didomi
    "#didomi-notice-disagree-button",

    // Klaro
    ".klaro .cn-decline",

    // Osano
    ".osano-cm-denyAll",

    // Complianz
    ".cmplz-deny",

    // Cookie Script
    "#cookiescript_reject",

    // GDPR Cookie Compliance
    '[data-cookie-set="reject"]',

    // Iubenda
    ".iubenda-cs-reject-btn",

    // Sourcepoint
    'button[title="Reject"]',
    'button[title="REJECT ALL"]',

    // Generic data attributes
    '[data-action="reject"]',
    '[data-action="deny"]',
    '[data-testid*="reject"]',
    '[data-testid*="deny"]',
    '[data-gdpr="reject"]',
    '[data-cookieconsent="reject"]',
  ];

  let handled = false;
  let attempts = 0;
  let panelTriggerClicked = false;
  const MAX_ATTEMPTS = 15;
  const RETRY_INTERVAL_MS = 800;

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      el.offsetWidth > 0 &&
      el.offsetHeight > 0
    );
  }

  function isClickable(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    return (
      tag === "button" ||
      tag === "a" ||
      tag === "input" ||
      role === "button" ||
      el.classList.contains("btn") ||
      el.onclick != null ||
      el.style.cursor === "pointer"
    );
  }

  function getVisibleText(el) {
    return (el.textContent || el.value || el.getAttribute("aria-label") || "").trim();
  }

  function matchesAnyPattern(text, patterns) {
    return patterns.some((pattern) => pattern.test(text));
  }

  function matchesDenyPattern(text) {
    return matchesAnyPattern(text, DENY_BUTTON_PATTERNS);
  }

  // Real cookie-reject controls apply consent client-side and never carry a real
  // destination href — they're buttons or JS-driven links. An <a> with a genuine href
  // is almost certainly an unrelated site link that happens to match deny wording (e.g.
  // "Security", "Settings"), and clicking it would navigate the user away entirely.
  function isLikelyPageNavigation(el) {
    if (el.tagName.toLowerCase() !== "a") return false;
    const href = el.getAttribute("href");
    return !!href && href !== "#" && !href.startsWith("javascript:");
  }

  // Fallback context signal for tryBroadSearch(): sites using hashed/obfuscated CSS class
  // names (CSS Modules, styled-components) carry no "cookie"/"consent" substring in their
  // class/id attributes, but real banners almost always mention it in nearby visible text.
  // Bounded by depth and length so we don't award context credit once we've walked past the
  // actual banner into general page chrome.
  const CONTEXT_TEXT_PATTERN = /cookie|consent|gdpr|privacy\s*(policy|settings|preferences)|tracking\s*preferences/i;
  const CONTEXT_SEARCH_MAX_DEPTH = 6;
  const CONTEXT_TEXT_MAX_LENGTH = 800;

  function hasNearbyCookieContextText(el) {
    let node = el.parentElement;
    let depth = 0;
    while (node && depth < CONTEXT_SEARCH_MAX_DEPTH) {
      const text = (node.textContent || "").trim();
      if (text.length > 0 && text.length <= CONTEXT_TEXT_MAX_LENGTH && CONTEXT_TEXT_PATTERN.test(text)) {
        return true;
      }
      node = node.parentElement;
      depth++;
    }
    return false;
  }

  // Try known deny button selectors first (fast path)
  function tryKnownSelectors() {
    for (const selector of KNOWN_DENY_SELECTORS) {
      try {
        const el = document.querySelector(selector);
        if (el && isVisible(el)) {
          el.click();
          notifyBackground("known-selector");
          return true;
        }
      } catch (_) {
        // Selector may be invalid on some pages
      }
    }
    return false;
  }

  // Search for deny buttons inside cookie banner containers
  function tryBannerSearch() {
    for (const selector of BANNER_SELECTORS) {
      try {
        const banner = document.querySelector(selector);
        if (!banner || !isVisible(banner)) continue;

        const clickables = banner.querySelectorAll(
          'button, a, input[type="button"], input[type="submit"], [role="button"], [class*="btn"]'
        );

        for (const el of clickables) {
          if (isLikelyPageNavigation(el)) continue;
          const text = getVisibleText(el);
          if (text && matchesDenyPattern(text) && isVisible(el)) {
            el.click();
            notifyBackground("banner-search");
            return true;
          }
        }
      } catch (_) {
        // Continue to next selector
      }
    }
    return false;
  }

  // Broad DOM search as a fallback
  function tryBroadSearch() {
    const candidates = document.querySelectorAll(
      'button, a, input[type="button"], input[type="submit"], [role="button"]'
    );
    const scored = [];

    for (const el of candidates) {
      if (!isVisible(el)) continue;
      if (isLikelyPageNavigation(el)) continue;
      const text = getVisibleText(el);
      if (!text || !matchesDenyPattern(text)) continue;

      // Score based on relevance — prefer elements that look like they are in a cookie context
      let score = 1;
      const hasAttrContext = el.closest('[class*="cookie" i], [class*="consent" i], [id*="cookie" i], [id*="consent" i]') != null;
      if (hasAttrContext) {
        score += 10;
      } else if (hasNearbyCookieContextText(el)) {
        score += 6; // weaker signal than an explicit class/id match, but still clears MIN_BROAD_SEARCH_SCORE
      }

      if (isClickable(el)) score += 2;
      if (text.length < 30) score += 1; // Prefer concise button labels

      scored.push({ el, score });
    }

    if (scored.length === 0) return false;

    // Only click if the best candidate is clearly in a cookie/consent context.
    // Max score without cookie context = 4 (1 base + 2 clickable + 1 short text),
    // so requiring >= MIN_BROAD_SEARCH_SCORE prevents false positives on unrelated page elements.
    const MIN_BROAD_SEARCH_SCORE = 5;
    scored.sort((a, b) => b.score - a.score);
    if (scored[0].score < MIN_BROAD_SEARCH_SCORE) return false;

    scored[0].el.click();
    notifyBackground("broad-search");
    return true;
  }

  // Some banners offer no direct reject option — only "Accept all" and a "Manage
  // cookies"/"Cookie settings" trigger that opens a panel with optional-category toggles
  // (already off by default, per GDPR) and a "Save settings" style confirm button.
  const PANEL_TRIGGER_PATTERNS = [
    /\bmanage\s*cookies?\b/i,
    /\bcookie\s*settings\b/i,
    /\bmanage\s*preferences\b/i,
    /\bmanage\s*consent\b/i,
    /\bcustomi[sz]e\b/i,
    /\bprivacy\s*settings\b/i,
  ];

  const PANEL_CONFIRM_PATTERNS = [
    /\bsave\s*(settings|preferences|choices)?\b/i,
    /\bconfirm\s*(choices|selection|settings)?\b/i,
    /\bapply\s*(settings|preferences)?\b/i,
  ];

  // Never confirm a panel unless every optional toggle is verifiably off — disabled toggles
  // are skipped since those are commonly the locked-on "necessary" category.
  function panelTogglesAreAllOff(panel) {
    const toggles = panel.querySelectorAll('input[type="checkbox"], input[type="radio"], [role="switch"]');
    for (const toggle of toggles) {
      if (toggle.disabled) continue;
      const isOn = toggle.checked === true || toggle.getAttribute("aria-checked") === "true";
      if (isOn) return false;
    }
    return true;
  }

  function findOpenPreferencesPanel() {
    const candidates = document.querySelectorAll(
      '[role="dialog"], [class*="cookie" i], [class*="consent" i], [id*="cookie" i], [id*="consent" i], [class*="privacy" i], [class*="preference" i]'
    );
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const hasToggle = el.querySelector('input[type="checkbox"], input[type="radio"], [role="switch"]');
      if (!hasToggle) continue;
      const hasConfirmBtn = Array.from(el.querySelectorAll('button, a, [role="button"]')).some(
        (btn) => isVisible(btn) && matchesAnyPattern(getVisibleText(btn), PANEL_CONFIRM_PATTERNS)
      );
      if (hasConfirmBtn) return el;
    }
    return null;
  }

  function tryPreferencesPanel() {
    const panel = findOpenPreferencesPanel();
    if (panel) {
      if (!panelTogglesAreAllOff(panel)) return false;
      const confirmBtn = Array.from(panel.querySelectorAll('button, a, [role="button"]')).find(
        (btn) => isVisible(btn) && matchesAnyPattern(getVisibleText(btn), PANEL_CONFIRM_PATTERNS)
      );
      if (confirmBtn) {
        confirmBtn.click();
        notifyBackground("preferences-panel");
        return true;
      }
      return false;
    }

    if (!panelTriggerClicked) {
      // Scope the trigger search to known banner containers, not the whole document, to avoid
      // clicking an unrelated "manage cookies" link elsewhere on the page.
      for (const selector of BANNER_SELECTORS) {
        try {
          const banner = document.querySelector(selector);
          if (!banner || !isVisible(banner)) continue;
          const clickables = banner.querySelectorAll('button, a, [role="button"], [class*="btn"]');
          for (const el of clickables) {
            if (!isVisible(el) || isLikelyPageNavigation(el)) continue;
            const text = getVisibleText(el);
            if (text && matchesAnyPattern(text, PANEL_TRIGGER_PATTERNS)) {
              el.click();
              panelTriggerClicked = true;
              return false; // not handled yet — retry/mutation loop will pick up the revealed panel
            }
          }
        } catch (_) {
          // Continue to next selector
        }
      }
    }

    return false;
  }

  function dismissCookies() {
    if (handled) return;

    if (tryKnownSelectors() || tryBannerSearch() || tryBroadSearch() || tryPreferencesPanel()) {
      handled = true;
      return;
    }

    // Retry if banner hasn't appeared yet
    attempts++;
    if (attempts < MAX_ATTEMPTS) {
      setTimeout(dismissCookies, RETRY_INTERVAL_MS);
    }
  }

  function showByeToast(method) {
    const toast = document.createElement("div");
    Object.assign(toast.style, {
      position: "fixed",
      top: "24px",
      right: "24px",
      background: "#e94560",
      color: "#fff",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      padding: "9px 16px",
      borderRadius: "10px",
      zIndex: "2147483647",
      opacity: "0",
      transform: "translateY(-6px)",
      transition: "opacity 0.2s, transform 0.2s",
      pointerEvents: "none",
      boxShadow: "0 4px 20px rgba(233,69,96,0.45)",
    });

    const title = document.createElement("div");
    title.textContent = "Cookies refused \u2713";
    Object.assign(title.style, {
      fontSize: "13px",
      fontWeight: "600",
      letterSpacing: "0.2px",
    });

    const subtitle = document.createElement("div");
    subtitle.textContent = "Cookie banner automatically blocked";
    Object.assign(subtitle.style, {
      fontSize: "11px",
      opacity: "0.8",
      marginTop: "2px",
    });

    toast.appendChild(title);
    toast.appendChild(subtitle);
    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    }));

    // Animate out and remove
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(-6px)";
      setTimeout(() => toast.remove(), 250);
    }, 1800);
  }

  function notifyBackground(method) {
    showByeToast(method);
    browserAPI.runtime.sendMessage({
      type: "cookie-denied",
      url: window.location.hostname,
      method,
    }).catch(() => {});
  }

  // Check if extension is enabled before running
  function init() {
    browserAPI.storage.local.get({ enabled: true }).then((result) => {
      if (result.enabled) {
        // Small delay to let banners render
        setTimeout(dismissCookies, 500);

        // Also watch for dynamically injected banners
        let debounceTimer;
        const observer = new MutationObserver(() => {
          if (handled) return;
          clearTimeout(debounceTimer);
          attempts = 0; // Reset so retry loop can run fresh on new DOM changes
          debounceTimer = setTimeout(dismissCookies, 100);
        });
        observer.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
        });

        // Stop observing after a reasonable time or when page unloads
        const disconnectObserver = () => observer.disconnect();
        setTimeout(disconnectObserver, 15000);
        window.addEventListener("beforeunload", disconnectObserver, { once: true });
      }

      // Re-run if extension is enabled while the page is already open
      browserAPI.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.enabled && changes.enabled.newValue === true && !handled) {
          attempts = 0;
          dismissCookies();
        }
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
