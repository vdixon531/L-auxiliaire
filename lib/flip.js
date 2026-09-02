// lib/flip.js
//
// The measuring half of the flip card (styles live in lib/flip.css). Shared by
// sidepanel.js's saved-word cards and welcome.js's demo card, so the two can't
// drift apart.
//
// Why any JS at all: the back face is absolutely positioned so it doesn't
// contribute to layout, which means the container's natural height is the
// front's. Flipping to a taller back — a conjugation table against a two-line
// word card — would clip it. So each flip sets an explicit height, and
// lib/flip.css transitions between them.

/** Markup for the ">" affordance. Inline SVG isn't needed — flip.css draws it
 *  from two borders, which stays crisp and needs no font support. */
export function chevron(direction = "right") {
  return `<span class="fla-chev${direction === "left" ? " fla-chev--left" : ""}"></span>`;
}

/** Flip (or unflip) a .entry-flip, sizing it to whichever face is coming up. */
export function setFlipped(flip, on) {
  if (!flip) return;
  const face = flip.querySelector(on ? ".entry--back" : ".entry--front");
  if (!face) return;
  flip.classList.toggle("is-flipped", on);
  flip.style.height = `${face.offsetHeight}px`;

  if (!on) {
    // Hand the height back to the content once the animation is done, so the
    // card resizes normally if anything re-renders it.
    setTimeout(() => {
      if (!flip.classList.contains("is-flipped")) flip.style.height = "";
    }, 480);
  }
}

export function isFlipped(flip) {
  return !!flip?.classList.contains("is-flipped");
}
