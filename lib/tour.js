// lib/tour.js
//
// Spotlight tour engine — a dimmed backdrop with a cutout over one element and
// a callout bubble pointing at it. Shared by welcome/welcome.js and
// sidepanel/sidepanel.js; both are regular extension pages, so this is a real
// shared module rather than a duplicated one (same reasoning as
// lib/settings-panel.js — content scripts couldn't import it, extension pages
// can).
//
// Deliberately NOT used on host pages. A tour there would have to live in
// content/content-script.js, which is a classic script and can't import this,
// so it would mean a second copy of all of it. The welcome page reproduces the
// in-page experience with the real content/popup.css instead.
//
// Progress is stored under its own top-level `tourState` key, not inside
// `config`: config is read-merge-written by four separate sites, and this isn't
// a user setting.

const STORAGE_KEY = "tourState";

// Bump to re-offer the tour after a release that adds something worth showing.
// shouldRunTour() treats an older stored version as "not seen".
export const TOUR_VERSION = 1;

export const TOUR_IDS = { welcome: "welcome", panel: "panel" };

const SEEN_FIELD = { welcome: "welcomeSeenAt", panel: "panelSeenAt" };

// How far the cutout is inset/outset from the target's own box.
const DEFAULT_PADDING = 6;
// Gap between the target and the callout.
const GAP = 12;
// Keep the callout this far from the viewport edge.
const MARGIN = 12;

// -----------------------------
// Stored state
// -----------------------------

export async function getTourState() {
  const { [STORAGE_KEY]: state } = await chrome.storage.local.get(STORAGE_KEY);
  return state && state.version === TOUR_VERSION ? state : { version: TOUR_VERSION };
}

async function patchTourState(patch) {
  const current = await getTourState();
  const next = { ...current, ...patch, version: TOUR_VERSION };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** Has this tour never been shown (or been shown under an older version)? */
export async function shouldRunTour(id) {
  const state = await getTourState();
  return !state[SEEN_FIELD[id]];
}

/** Mark a tour shown. `completed` distinguishes "ran to the end" from "skipped",
 *  which the welcome page uses to decide whether to open the chapter menu. */
export async function markTourSeen(id, { completed = false } = {}) {
  const patch = { [SEEN_FIELD[id]]: Date.now() };
  if (id === TOUR_IDS.welcome && completed) patch.welcomeCompletedAt = Date.now();
  await patchTourState(patch);
}

/** Recorded by background/service-worker.js when it opens the welcome tab.
 *  Deliberately separate from welcomeSeenAt (which means "the tour ran"): the
 *  worker must never mark the tour seen, or opening the tab would suppress the
 *  very tour it opened the tab for. */
export async function markWelcomeOpened() {
  await patchTourState({ welcomeOpenedAt: Date.now() });
}

export async function markChapterSeen(chapter) {
  const state = await getTourState();
  await patchTourState({ chaptersSeen: { ...(state.chaptersSeen || {}), [chapter]: Date.now() } });
}

/** Wipe every "seen" marker so the whole tutorial runs again. */
export async function resetTourState() {
  await chrome.storage.local.remove(STORAGE_KEY);
}

// -----------------------------
// Engine
// -----------------------------

let active = null; // only one tour at a time, per document

/**
 * Run a tour. Resolves { completed } when the user finishes or skips.
 *
 * Options:
 *   steps
 *   onFinish
 *   dismissOnClickAway  // default true. false = a click on the dimmed area
 *                       // does nothing instead of ending the tour, for a
 *                       // tour running over a live surface the user is being
 *                       // walked through. Esc and Skip still exit.
 *
 * A step:
 *   {
 *     target,      // CSS selector, Element, or null/missing for a centred step
 *     title,
 *     body,        // string, or an Element to adopt into the callout
 *     placement,   // "auto" (default) | "top" | "bottom" | "left" | "right"
 *     padding,     // cutout padding, px
 *     interactive, // true = let the user click the page through the backdrop
 *     nextLabel,   // override the Next button's text
 *     hideNext,    // hide Next entirely — the page advances this step
 *     showSkip,    // force Skip visible even on the final step — a step with
 *                  // two real outcomes (e.g. a consent gate) needs both
 *                  // buttons where an ordinary last step only ever needs "Done"
 *     skipLabel,   // override Skip's text (e.g. "Not now") when showSkip is set
 *     before,      // async () => {} — run before this step is measured
 *   }
 */
export function runTour({ steps, onFinish, dismissOnClickAway = true } = {}) {
  if (active) active.destroy(false);
  const list = (steps || []).filter(Boolean);
  if (!list.length) return Promise.resolve({ completed: false });

  return new Promise((resolve) => {
    active = new Tour(list, { dismissOnClickAway }, (result) => {
      active = null;
      onFinish?.(result);
      resolve(result);
    });
    active.start();
  });
}

export function isTourActive() {
  return !!active;
}

/** Advance the running tour one step, as if Next were pressed. Lets a caller
 *  drive progress from something the user did on the page — the welcome tour's
 *  "click any word" step moves on when a word is actually clicked, rather than
 *  asking them to confirm they did it. No-op if no tour is running. */
export function advanceTour() {
  active?.go(1);
}

/** Build a callout body from one <p> per line. Shared so every tour reads the
 *  same: paragraphs, not one dense block. Inner HTML is allowed (<strong>,
 *  <em>, <kbd>) because these strings are authored here, never user input. */
export function para(...lines) {
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const p = document.createElement("p");
    p.innerHTML = line;
    frag.appendChild(p);
  }
  return frag;
}

export function stopTour() {
  active?.destroy(false);
}

// -----------------------------
// Transient hint
//
// The same callout component a tour step uses, minus the scrim, the blocker
// and the footer — a one-line pointer that says its piece and leaves. The
// welcome page shows one over "Tour the workbook" the moment the core tour
// ends; that used to be a paragraph sitting in the page, which is exactly the
// kind of text nobody reads.
//
// Deliberately NOT routed through runTour(): a hint must never become the
// `active` tour, or isTourActive() would report a tour running and the demo
// bubble would stop dismissing itself on click.
// -----------------------------

let hint = null;

/**
 * Show a self-dismissing callout anchored to an element.
 *   { target, title, body, placement, padding, duration }
 * `duration` is ms on screen (0 = until dismissed). Returns a function that
 * dismisses it early; a second call replaces the first hint.
 */
export function showHint({ target, title, body, placement, padding, duration = 8000 } = {}) {
  dismissHint();

  const root = document.createElement("div");
  root.className = "fla-tour fla-tour--hint";
  root.setAttribute("role", "status");

  const callout = document.createElement("div");
  callout.className = "fla-tour__callout";

  const arrow = document.createElement("div");
  arrow.className = "fla-tour__arrow";
  arrow.setAttribute("aria-hidden", "true");

  const heading = document.createElement("h2");
  heading.className = "fla-tour__title";
  heading.textContent = title || "";

  const bodyEl = document.createElement("div");
  bodyEl.className = "fla-tour__body";
  // Clone, for the same reason render() does — a DocumentFragment from para()
  // is emptied by appending it, and callers build theirs once at module load.
  if (body instanceof Node) bodyEl.appendChild(body.cloneNode(true));
  else bodyEl.textContent = body || "";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "fla-tour__hint-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => dismissHint());

  callout.append(arrow, heading, bodyEl, close);
  root.appendChild(callout);
  document.body.appendChild(root);

  const place = () => {
    if (!hint) return;
    const el = resolveTarget(target);
    // A target that scrolled away or was hidden leaves the hint centred rather
    // than stranded over empty space.
    if (el) {
      root.classList.remove("fla-tour--centred");
      anchorCallout(callout, el, { placement, padding });
    } else {
      centreCallout(root, callout);
    }
  };

  const reposition = debounce(place, 60);
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);
  const observer = new ResizeObserver(reposition);
  observer.observe(document.documentElement);

  hint = {
    root,
    timer: duration > 0 ? setTimeout(() => dismissHint(), duration) : null,
    teardown() {
      clearTimeout(this.timer);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      observer.disconnect();
    }
  };

  place();
  callout.classList.add("is-in");
  return dismissHint;
}

export function dismissHint() {
  if (!hint) return;
  const { root } = hint;
  hint.teardown();
  hint = null;
  root.classList.add("fla-tour--out");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  setTimeout(() => root.remove(), reduce ? 0 : 160);
}

class Tour {
  constructor(steps, { dismissOnClickAway = true } = {}, done) {
    this.steps = steps;
    this.dismissOnClickAway = dismissOnClickAway;
    this.done = done;
    this.index = 0;
    this.target = null;
    this.previousFocus = null;
    this.reposition = debounce(() => this.place(), 60);
  }

  start() {
    this.previousFocus = document.activeElement;
    this.build();
    document.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("resize", this.reposition);
    // Capture phase: a scroll inside any pane must move the spotlight too, and
    // scroll events from inner elements don't bubble.
    window.addEventListener("scroll", this.reposition, true);
    // The side panel is user-resizable, so the viewport can change without a
    // window resize event ever firing.
    this.resizeObserver = new ResizeObserver(this.reposition);
    this.resizeObserver.observe(document.documentElement);
    this.render();
  }

  build() {
    const root = document.createElement("div");
    root.className = "fla-tour";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Tutorial");

    // Transparent, and it swallows clicks on the dimmed area. By default it
    // also closes the tour when clicked: waiting for the Done button reads as
    // a trap, and clicking away is what people expect a popover to respond to.
    // A tour can opt out (dismissOnClickAway: false) when a stray click
    // shouldn't be able to end it — the side panel's tours do, since the
    // whole panel is a live surface the user is being walked through and
    // clicking a workbook row shouldn't quietly cancel the tutorial. Esc and
    // Skip still work either way; a tour with no exit at all is a trap.
    // Interactive steps have no blocker at all (the point there is to let the
    // page through), so those are dismissed by Skip or Esc.
    const blocker = document.createElement("div");
    blocker.className = "fla-tour__blocker";

    // The cutout. Its huge spread box-shadow is what paints the scrim over
    // everything else, so there's no separate dimming layer to keep in sync.
    const spot = document.createElement("div");
    spot.className = "fla-tour__spot";

    const callout = document.createElement("div");
    callout.className = "fla-tour__callout";
    callout.tabIndex = -1;
    callout.innerHTML = `
      <div class="fla-tour__arrow" aria-hidden="true"></div>
      <h2 class="fla-tour__title"></h2>
      <div class="fla-tour__body"></div>
      <div class="fla-tour__foot">
        <span class="fla-tour__count" aria-live="polite"></span>
        <div class="fla-tour__btns">
          <button type="button" class="fla-tour__skip">Skip</button>
          <button type="button" class="fla-tour__back">Back</button>
          <button type="button" class="fla-tour__next">Next</button>
        </div>
      </div>
    `;

    root.append(blocker, spot, callout);
    document.body.appendChild(root);

    this.root = root;
    this.blocker = blocker;
    this.spot = spot;
    this.callout = callout;
    this.titleEl = callout.querySelector(".fla-tour__title");
    this.bodyEl = callout.querySelector(".fla-tour__body");
    this.countEl = callout.querySelector(".fla-tour__count");
    this.backBtn = callout.querySelector(".fla-tour__back");
    this.nextBtn = callout.querySelector(".fla-tour__next");
    this.skipBtn = callout.querySelector(".fla-tour__skip");

    if (this.dismissOnClickAway) blocker.addEventListener("click", () => this.destroy(false));
    this.backBtn.addEventListener("click", () => this.go(-1));
    this.nextBtn.addEventListener("click", () => this.go(1));
    this.skipBtn.addEventListener("click", () => this.destroy(false));
  }

  onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      this.destroy(false);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      this.go(1);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      this.go(-1);
      return;
    }
    // Focus trap — keep Tab inside the callout while the tour owns the screen.
    if (e.key === "Tab") {
      const focusables = [this.skipBtn, this.backBtn, this.nextBtn].filter(
        (b) => !b.disabled && !b.hidden
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  go(delta) {
    const next = this.index + delta;
    if (next < 0) return;
    if (next >= this.steps.length) {
      this.destroy(true);
      return;
    }
    this.index = next;
    this.render();
  }

  async render() {
    const step = this.steps[this.index];

    try {
      await step.before?.();
    } catch (err) {
      console.error("[FLA tour] step.before failed", err);
    }
    if (!this.root) return; // destroyed while awaiting

    // A missing target is not fatal: the side panel's lists are empty on first
    // run, so some steps legitimately have nothing to point at. Fall back to a
    // centred step rather than throwing halfway through the tour.
    this.target = resolveTarget(step.target);
    if (step.target && !this.target) {
      console.warn("[FLA tour] no element for target", step.target, "— centring instead");
    }

    this.titleEl.textContent = step.title || "";
    this.bodyEl.replaceChildren();
    // CLONE. Appending a DocumentFragment MOVES its children out, emptying it —
    // and step bodies are built once, at module load, by para(). Appending the
    // original meant a step's text rendered the first time it was shown and
    // never again: go Back and forward, or replay the tour, and every visited
    // step came up as a bare heading.
    if (step.body instanceof Node) this.bodyEl.appendChild(step.body.cloneNode(true));
    else this.bodyEl.textContent = step.body || "";

    this.countEl.textContent = `${this.index + 1} of ${this.steps.length}`;
    this.backBtn.hidden = this.index === 0;
    // A step can hide Next when something on the page is meant to advance it
    // (see advanceTour) — leaving it there invites clicking past the very
    // thing the step is asking the user to try.
    this.nextBtn.hidden = !!step.hideNext;
    this.nextBtn.textContent =
      step.nextLabel || (this.index === this.steps.length - 1 ? "Done" : "Next");
    // A step with two real outcomes (showSkip) keeps Skip visible even as the
    // last step, where it would otherwise be hidden on the assumption that a
    // final step only ever needs "Done".
    this.skipBtn.hidden = this.index === this.steps.length - 1 && !step.showSkip;
    this.skipBtn.textContent = step.skipLabel || "Skip";
    this.blocker.hidden = !!step.interactive;

    // Watch the target as well as the viewport. A spotlit element can change
    // size under its own step — the welcome tour's passage bubble swaps a
    // preview for a full translation while its step is on screen — and the
    // cutout has to follow it rather than stay on the box it used to fill.
    this.resizeObserver.disconnect();
    this.resizeObserver.observe(document.documentElement);
    if (this.target) this.resizeObserver.observe(this.target);

    if (this.target) {
      scrollIntoViewIfNeeded(this.target);
      // Let a smooth scroll settle before measuring, or the cutout lands where
      // the target used to be.
      await nextFrame();
      await nextFrame();
      if (!this.root) return;
    }

    this.place();
    // Restart the pop animation for each step. Removing and re-adding the class
    // isn't enough on its own — the reflow read in between is what makes the
    // browser treat it as a new animation rather than a continuing one.
    this.callout.classList.remove("is-in");
    void this.callout.offsetWidth;
    this.callout.classList.add("is-in");
    this.callout.focus({ preventScroll: true });
  }

  place() {
    if (!this.root) return;
    const step = this.steps[this.index];

    if (!this.target) {
      this.spot.hidden = true;
      centreCallout(this.root, this.callout);
      return;
    }

    this.root.classList.remove("fla-tour--centred");
    this.spot.hidden = false;

    const box = anchorCallout(this.callout, this.target, {
      placement: step.placement,
      padding: step.padding
    });

    this.spot.style.left = `${box.left}px`;
    this.spot.style.top = `${box.top}px`;
    this.spot.style.width = `${box.width}px`;
    this.spot.style.height = `${box.height}px`;
  }

  destroy(completed) {
    if (!this.root) return;
    document.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
    this.resizeObserver?.disconnect();

    // Null the reference first so anything still in flight (a pending
    // step.before, a debounced reposition) bails out, then let it fade.
    const root = this.root;
    this.root = null;
    root.classList.add("fla-tour--out");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(() => root.remove(), reduce ? 0 : 160);

    if (this.previousFocus?.isConnected) this.previousFocus.focus?.({ preventScroll: true });
    this.done({ completed });
  }
}

// -----------------------------
// Helpers
// -----------------------------

function resolveTarget(target) {
  if (!target) return null;
  const el = typeof target === "string" ? document.querySelector(target) : target;
  if (!el || !el.isConnected) return null;
  // An element with no box (display:none, or an empty container) can't be
  // spotlighted — treat it as absent so the step centres instead.
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

/** Put a callout in the middle of the viewport, with the scrim painted by its
 *  own ::before (there's no cutout to paint it). Position only — the width is
 *  deliberately the same as an anchored callout's. */
function centreCallout(root, callout) {
  root.classList.add("fla-tour--centred");
  callout.style.left = "";
  callout.style.top = "";
  callout.dataset.placement = "centre";
}

/**
 * Position a callout beside a target's padded box and aim its arrow at the
 * target's centre. Returns the padded box, which the tour reuses as the
 * cutout's rect. Shared by tour steps and showHint().
 */
function anchorCallout(callout, target, { placement: preferred, padding } = {}) {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const pad = padding ?? DEFAULT_PADDING;
  const r = target.getBoundingClientRect();
  const box = {
    left: r.left - pad,
    top: r.top - pad,
    right: r.right + pad,
    bottom: r.bottom + pad,
    width: r.width + pad * 2,
    height: r.height + pad * 2
  };

  // Measure the callout before positioning it — its height depends on the
  // copy, which changes every step.
  const cw = callout.offsetWidth;
  const ch = callout.offsetHeight;

  // Try each placement and take the first that doesn't sit on top of the
  // thing it's pointing at. A single preferred placement plus a clamp isn't
  // enough: the side panel is ~400px wide, so "left"/"right" never fit, and
  // clamping a too-wide callout back into view lands it squarely over the
  // spotlight — which is exactly how a callout ends up hiding its own target.
  const order = dedupe([
    preferred && preferred !== "auto" ? preferred : null,
    "bottom",
    "top",
    "right",
    "left"
  ]);

  let best = null;
  for (const placement of order) {
    const rect = rectFor(placement, box, cw, ch, vw, vh);
    const overlap = overlapArea(rect, box);
    if (overlap === 0) {
      best = { placement, rect };
      break;
    }
    if (!best || overlap < best.overlap) best = { placement, rect, overlap };
  }

  const { placement, rect } = best;
  callout.style.left = `${rect.left}px`;
  callout.style.top = `${rect.top}px`;
  callout.dataset.placement = placement;

  // Point the arrow at the target's centre even after the callout was clamped
  // sideways, so it never aims off into empty space.
  const isVertical = placement === "top" || placement === "bottom";
  const centre = isVertical
    ? box.left + box.width / 2 - rect.left
    : box.top + box.height / 2 - rect.top;
  const limit = isVertical ? cw : ch;
  callout.style.setProperty("--fla-tour-arrow-pos", `${clamp(centre, 16, limit - 16)}px`);
  return box;
}

/** Where the callout lands for one placement, already clamped into view. */
function rectFor(placement, box, cw, ch, vw, vh) {
  let left;
  let top;
  if (placement === "bottom") {
    top = box.bottom + GAP;
    left = box.left + box.width / 2 - cw / 2;
  } else if (placement === "top") {
    top = box.top - ch - GAP;
    left = box.left + box.width / 2 - cw / 2;
  } else if (placement === "right") {
    left = box.right + GAP;
    top = box.top + box.height / 2 - ch / 2;
  } else {
    left = box.left - cw - GAP;
    top = box.top + box.height / 2 - ch / 2;
  }
  left = clamp(left, MARGIN, Math.max(MARGIN, vw - cw - MARGIN));
  top = clamp(top, MARGIN, Math.max(MARGIN, vh - ch - MARGIN));
  return { left, top, right: left + cw, bottom: top + ch };
}

function overlapArea(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}

function scrollIntoViewIfNeeded(el) {
  const r = el.getBoundingClientRect();
  const vh = document.documentElement.clientHeight;
  const vw = document.documentElement.clientWidth;
  const visible = r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw;
  if (visible) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior = reduce ? "auto" : "smooth";

  // A target taller than the viewport can never be shown in full, and
  // centring one guarantees its top scrolls off — which is where the part
  // the step is actually about lives (the verb and its first tense, the first
  // row of a list). The conjugation table is exactly this: centring it landed
  // the panel halfway down the tenses with the verb input pushed off the top.
  // So: if its top is already on screen, don't scroll at all; otherwise bring
  // the top to the top rather than the middle to the middle.
  if (r.height >= vh) {
    if (r.top >= 0) return;
    el.scrollIntoView({ block: "start", inline: "nearest", behavior });
    return;
  }
  el.scrollIntoView({ block: "center", inline: "nearest", behavior });
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
