/**
 * @jest-environment jsdom
 *
 * Tests for content.js — focuses on Firefox's `browser` API namespace
 * and the three deny-button detection strategies.
 */

const fs = require("fs");
const path = require("path");

const SCRIPT = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBrowserMock({ enabled = true } = {}) {
  return {
    storage: {
      local: {
        get: jest.fn().mockResolvedValue({ enabled }),
        set: jest.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: jest.fn() },
    },
    runtime: {
      sendMessage: jest.fn().mockResolvedValue(undefined),
    },
  };
}

/** Make an element appear visible to jsdom (offsetWidth/Height default to 0). */
function makeVisible(el) {
  Object.defineProperty(el, "offsetWidth", { value: 100, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: 40, configurable: true });
}

/**
 * Run the content script with the given browser mock and flush all timers
 * + pending microtasks so async storage calls resolve.
 */
async function runScript(browserMock) {
  eval(SCRIPT); // eslint-disable-line no-eval
  // Flush the storage.local.get promise
  await Promise.resolve();
  // Advance past the 500 ms initial delay
  jest.advanceTimersByTime(500);
  // Flush any microtasks triggered by the timer
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = "";
  delete global.browser;
  delete global.chrome;
  // Prevent MutationObservers from previous eval()s persisting across tests
  // and firing when DOM elements are added in subsequent tests.
  global.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Firefox API selection
// ---------------------------------------------------------------------------

describe("Firefox API selection", () => {
  test("uses browser namespace (Firefox) when available", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    await runScript(mock);

    expect(mock.storage.local.get).toHaveBeenCalled();
    expect(mock.runtime.sendMessage).not.toHaveBeenCalled(); // no banner on page
  });

  test("falls back to chrome namespace when browser is not defined", async () => {
    const mock = makeBrowserMock();
    global.chrome = mock;

    await runScript(mock);

    expect(mock.storage.local.get).toHaveBeenCalled();
  });

  test("prefers browser over chrome when both are present", async () => {
    const firefoxMock = makeBrowserMock();
    const chromeMock = makeBrowserMock();
    global.browser = firefoxMock;
    global.chrome = chromeMock;

    await runScript(firefoxMock);

    expect(firefoxMock.storage.local.get).toHaveBeenCalled();
    expect(chromeMock.storage.local.get).not.toHaveBeenCalled();
  });

  test("does nothing when extension is disabled", async () => {
    const mock = makeBrowserMock({ enabled: false });
    global.browser = mock;

    // Add a visible reject button that should NOT be clicked
    const btn = document.createElement("button");
    btn.id = "onetrust-reject-all-handler";
    btn.textContent = "Reject All";
    makeVisible(btn);
    document.body.appendChild(btn);
    const clickSpy = jest.spyOn(btn, "click");

    await runScript(mock);

    expect(clickSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Known-selector fast path
// ---------------------------------------------------------------------------

describe("Known selector detection (fast path)", () => {
  async function testKnownSelector(id, text = "Reject") {
    const mock = makeBrowserMock();
    global.browser = mock;

    const btn = document.createElement("button");
    btn.id = id;
    btn.textContent = text;
    makeVisible(btn);
    document.body.appendChild(btn);
    const clickSpy = jest.spyOn(btn, "click");

    await runScript(mock);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(mock.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cookie-denied", method: "known-selector" })
    );
  }

  test("clicks OneTrust reject-all button", () =>
    testKnownSelector("onetrust-reject-all-handler", "Reject All"));

  test("clicks Cookiebot decline button", () =>
    testKnownSelector("CybotCookiebotDialogBodyButtonDecline", "Decline"));

  test("clicks Didomi disagree button", () =>
    testKnownSelector("didomi-notice-disagree-button", "Disagree"));

  test("clicks Cookie Script reject button", () =>
    testKnownSelector("cookiescript_reject", "Reject"));

  test("reports correct hostname in sendMessage", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    const btn = document.createElement("button");
    btn.id = "onetrust-reject-all-handler";
    btn.textContent = "Reject";
    makeVisible(btn);
    document.body.appendChild(btn);

    await runScript(mock);

    expect(mock.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cookie-denied",
        url: window.location.hostname,
      })
    );
  });

  test("does not click a hidden known-selector button", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    const btn = document.createElement("button");
    btn.id = "onetrust-reject-all-handler";
    btn.textContent = "Reject";
    // offsetWidth/Height stay 0 → isVisible returns false
    document.body.appendChild(btn);
    const clickSpy = jest.spyOn(btn, "click");

    await runScript(mock);

    expect(clickSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Banner search (text-pattern matching inside a banner container)
// ---------------------------------------------------------------------------

describe("Banner search (text-pattern fallback)", () => {
  async function testBannerButton(bannerId, buttonText) {
    const mock = makeBrowserMock();
    global.browser = mock;

    const banner = document.createElement("div");
    banner.id = bannerId;
    makeVisible(banner);

    const btn = document.createElement("button");
    btn.textContent = buttonText;
    makeVisible(btn);
    banner.appendChild(btn);
    document.body.appendChild(banner);
    const clickSpy = jest.spyOn(btn, "click");

    await runScript(mock);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(mock.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cookie-denied", method: "banner-search" })
    );
  }

  test.each([
    ["Reject all"],
    ["Decline"],
    ["Refuse all"],
    ["No, thanks"],
    ["Only necessary"],
    ["Only essential"],
    ["Continue with necessary cookies only"],
    ["Accept Essentials Only"],
    ["Agree to necessary"],
    ["Do not accept"],
    ["Opt out"],
    ["I do not agree"],
    // German
    ["Alle ablehnen"],
    ["Ablehnen"],
    // French
    ["Tout refuser"],
    ["Refuser"],
    // Spanish
    ["Rechazar todo"],
    // Dutch
    ["Weigeren"],
    // Portuguese
    ["Recusar tudo"],
  ])('banner search clicks button with text "%s"', (text) =>
    testBannerButton("cookie-banner", text)
  );

  test("finds deny button inside a class-based banner container", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    const banner = document.createElement("div");
    banner.className = "cookie-consent-banner";
    makeVisible(banner);

    const btn = document.createElement("button");
    btn.textContent = "Decline all";
    makeVisible(btn);
    banner.appendChild(btn);
    document.body.appendChild(banner);
    const clickSpy = jest.spyOn(btn, "click");

    await runScript(mock);

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  test("ignores accept button inside banner", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    const banner = document.createElement("div");
    banner.id = "cookie-banner";
    makeVisible(banner);

    const acceptBtn = document.createElement("button");
    acceptBtn.textContent = "Accept all";
    makeVisible(acceptBtn);
    banner.appendChild(acceptBtn);
    document.body.appendChild(banner);
    const clickSpy = jest.spyOn(acceptBtn, "click");

    await runScript(mock);

    expect(clickSpy).not.toHaveBeenCalled();
    expect(mock.runtime.sendMessage).not.toHaveBeenCalled();
  });

  test.each([["Agree to all"], ["Accept all non-necessary cookies"]])(
    'does not treat "%s" as a deny action (guards the generic necessary/essential pattern)',
    async (text) => {
      const mock = makeBrowserMock();
      global.browser = mock;

      const banner = document.createElement("div");
      banner.id = "cookie-banner";
      makeVisible(banner);

      const acceptBtn = document.createElement("button");
      acceptBtn.textContent = text;
      makeVisible(acceptBtn);
      banner.appendChild(acceptBtn);
      document.body.appendChild(banner);
      const clickSpy = jest.spyOn(acceptBtn, "click");

      await runScript(mock);

      expect(clickSpy).not.toHaveBeenCalled();
      expect(mock.runtime.sendMessage).not.toHaveBeenCalled();
    }
  );
});

// ---------------------------------------------------------------------------
// 4. Broad search with scoring
// ---------------------------------------------------------------------------

describe("Broad search (scored fallback)", () => {
  test("clicks deny button inside a cookie-context parent (score >= 5)", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    // Not a known banner ID/class, but parent has 'cookie' in class
    const wrapper = document.createElement("div");
    wrapper.className = "my-cookie-dialog";

    const btn = document.createElement("button");
    btn.textContent = "Reject all";
    makeVisible(btn);
    wrapper.appendChild(btn);
    document.body.appendChild(wrapper);
    const clickSpy = jest.spyOn(btn, "click");

    await runScript(mock);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(mock.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ method: "broad-search" })
    );
  });

  test("does NOT click a deny-patterned button outside any cookie context (score < 5)", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    // Button text matches but is not in any cookie/consent context
    const btn = document.createElement("button");
    btn.textContent = "Decline";
    makeVisible(btn);
    document.body.appendChild(btn);
    const clickSpy = jest.spyOn(btn, "click");

    await runScript(mock);

    expect(clickSpy).not.toHaveBeenCalled();
  });

  test("clicks a high-signal deny button when the ancestor has a hashed class name but nearby text mentions cookies", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    // Simulates CSS Modules / styled-components hashed class names — no "cookie"/"consent"
    // substring anywhere in class/id attributes, only in the visible copy.
    const wrapper = document.createElement("div");
    wrapper.className = "a1b2c3";

    const copy = document.createElement("p");
    copy.textContent = "We use cookies to improve your experience.";
    wrapper.appendChild(copy);

    const btn = document.createElement("button");
    btn.textContent = "REJECT ALL";
    makeVisible(btn);
    wrapper.appendChild(btn);
    document.body.appendChild(wrapper);
    const clickSpy = jest.spyOn(btn, "click");

    await runScript(mock);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(mock.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ method: "broad-search" })
    );
  });

  test("does NOT award context credit from oversized ancestor text (stays capped at score 4)", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    const wrapper = document.createElement("div");
    wrapper.className = "a1b2c3";

    // Mentions "cookie" but is far longer than CONTEXT_TEXT_MAX_LENGTH (800 chars), so it
    // should not count as nearby context — otherwise any long legal boilerplate elsewhere on
    // the page could turn an unrelated "Reject All" button into a false positive.
    const copy = document.createElement("p");
    copy.textContent = "cookie ".repeat(200);
    wrapper.appendChild(copy);

    const btn = document.createElement("button");
    btn.textContent = "Reject All";
    makeVisible(btn);
    wrapper.appendChild(btn);
    document.body.appendChild(wrapper);
    const clickSpy = jest.spyOn(btn, "click");

    await runScript(mock);

    expect(clickSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Preferences panel flow (manage cookies → confirm)
// ---------------------------------------------------------------------------

describe("Preferences panel flow (manage cookies → confirm)", () => {
  /** Builds a "manage preferences" panel with a locked necessary toggle, one optional
   * toggle, and a Save button — mirrors the "Manage cookie settings" screenshot case. */
  function buildPanel({ optionalChecked = false } = {}) {
    const panel = document.createElement("div");
    panel.className = "cookie-consent-panel";
    makeVisible(panel);

    const necessaryToggle = document.createElement("input");
    necessaryToggle.type = "checkbox";
    necessaryToggle.checked = true;
    necessaryToggle.disabled = true;
    panel.appendChild(necessaryToggle);

    const optionalToggle = document.createElement("input");
    optionalToggle.type = "checkbox";
    optionalToggle.checked = optionalChecked;
    panel.appendChild(optionalToggle);

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save settings";
    makeVisible(saveBtn);
    panel.appendChild(saveBtn);

    return { panel, saveBtn };
  }

  function buildBannerWithTrigger(onTriggerClick) {
    const banner = document.createElement("div");
    banner.id = "cookie-banner";
    makeVisible(banner);

    const acceptBtn = document.createElement("button");
    acceptBtn.textContent = "Accept all";
    makeVisible(acceptBtn);
    banner.appendChild(acceptBtn);

    const manageBtn = document.createElement("button");
    manageBtn.textContent = "Manage cookies";
    makeVisible(manageBtn);
    if (onTriggerClick) manageBtn.addEventListener("click", onTriggerClick);
    banner.appendChild(manageBtn);

    document.body.appendChild(banner);
    return { banner, manageBtn };
  }

  test("clicks the Manage cookies trigger when no direct reject option exists", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    const { manageBtn } = buildBannerWithTrigger();
    const clickSpy = jest.spyOn(manageBtn, "click");

    await runScript(mock);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(mock.runtime.sendMessage).not.toHaveBeenCalled();
  });

  test("clicks Save settings and reports preferences-panel when every optional toggle is off", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    const { panel, saveBtn } = buildPanel({ optionalChecked: false });
    const { manageBtn } = buildBannerWithTrigger(() => document.body.appendChild(panel));
    jest.spyOn(manageBtn, "click");
    const saveSpy = jest.spyOn(saveBtn, "click");

    await runScript(mock);
    jest.advanceTimersByTime(800);
    await Promise.resolve();

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(mock.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cookie-denied", method: "preferences-panel" })
    );
  });

  test("does NOT click Save settings when an optional toggle is already checked", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    const { panel, saveBtn } = buildPanel({ optionalChecked: true });
    buildBannerWithTrigger(() => document.body.appendChild(panel));
    const saveSpy = jest.spyOn(saveBtn, "click");

    await runScript(mock);
    jest.advanceTimersByTime(800);
    await Promise.resolve();
    jest.advanceTimersByTime(800);
    await Promise.resolve();

    expect(saveSpy).not.toHaveBeenCalled();
    expect(mock.runtime.sendMessage).not.toHaveBeenCalled();
  });

  test("clicks the trigger at most once across multiple retry ticks", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    const { manageBtn } = buildBannerWithTrigger();
    const clickSpy = jest.spyOn(manageBtn, "click");

    await runScript(mock);
    jest.advanceTimersByTime(800);
    await Promise.resolve();
    jest.advanceTimersByTime(800);
    await Promise.resolve();
    jest.advanceTimersByTime(800);
    await Promise.resolve();

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  test("does not click a Manage cookies link that is a real page navigation", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    const banner = document.createElement("div");
    banner.id = "cookie-banner";
    makeVisible(banner);

    const link = document.createElement("a");
    link.setAttribute("href", "/privacy-settings");
    link.textContent = "Manage cookies";
    makeVisible(link);
    banner.appendChild(link);
    document.body.appendChild(banner);
    const clickSpy = jest.spyOn(link, "click");

    await runScript(mock);

    expect(clickSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Retry behaviour
// ---------------------------------------------------------------------------

describe("Retry behaviour", () => {
  test("retries if no banner found initially, then clicks when banner appears", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    // No banner yet — first attempt will find nothing
    await runScript(mock);
    expect(mock.runtime.sendMessage).not.toHaveBeenCalled();

    // Now inject a banner mid-retry cycle
    const btn = document.createElement("button");
    btn.id = "onetrust-reject-all-handler";
    btn.textContent = "Reject All";
    makeVisible(btn);
    document.body.appendChild(btn);
    const clickSpy = jest.spyOn(btn, "click");

    // Advance one retry interval (800 ms)
    jest.advanceTimersByTime(800);
    await Promise.resolve();

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  test("does not click again after already handling a banner (handled flag)", async () => {
    const mock = makeBrowserMock();
    global.browser = mock;

    const btn = document.createElement("button");
    btn.id = "onetrust-reject-all-handler";
    btn.textContent = "Reject All";
    makeVisible(btn);
    document.body.appendChild(btn);
    const clickSpy = jest.spyOn(btn, "click");

    await runScript(mock);

    // Advance well past all retry intervals
    jest.advanceTimersByTime(15000);
    await Promise.resolve();

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
