/**
 * skeletal-picker.js — reusable "skeletal structures & carbon chains" explorer.
 *
 * Shared by the public /demo route and the Session 0 tutorial. Renders an
 * interactive molecule picker (chain<->ring toggle, 10 carbon-chain prefix
 * buttons, carbon-numbering toggle) into a host element and manages its own
 * internal state.
 *
 *   mountSkeletalPicker(hostEl, opts?) -> void
 *     opts.initialKey — starting chain prefix (default "prop")
 *
 * The host only needs to be an empty container; the picker injects all of its
 * own markup. Call again on the same host to get a fresh picker. Styling lives
 * in v2-style.css (.picker-*).
 *
 * Chain and ring SVGs live in public/images/session0/{chains,rings}/. The
 * "Show carbon numbering" toggle swaps the image to the matching
 * <name>_numbered.svg, which carries the numbers inside the SVG.
 */

/* Escapes the five HTML-significant characters for safe interpolation. */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ── Skeletal-structures data ────────────────────────────────────────────── */
export const CHAIN_DATA = {
  meth: { name: "Methane", n: 1,  chain: "images/session0/chains/methane.svg",  ring: null },
  eth:  { name: "Ethane",  n: 2,  chain: "images/session0/chains/ethane.svg",   ring: null },
  prop: { name: "Propane", n: 3,  chain: "images/session0/chains/propane.svg",  ring: "images/session0/rings/cyclopropane.svg" },
  but:  { name: "Butane",  n: 4,  chain: "images/session0/chains/butane.svg",   ring: "images/session0/rings/cyclobutane.svg" },
  pent: { name: "Pentane", n: 5,  chain: "images/session0/chains/pentane.svg",  ring: "images/session0/rings/cyclopentane.svg" },
  hex:  { name: "Hexane",  n: 6,  chain: "images/session0/chains/hexane.svg",   ring: "images/session0/rings/cyclohexane.svg" },
  hept: { name: "Heptane", n: 7,  chain: "images/session0/chains/heptane.svg",  ring: "images/session0/rings/cycloheptane.svg" },
  oct:  { name: "Octane",  n: 8,  chain: "images/session0/chains/octane.svg",   ring: "images/session0/rings/cyclooctane.svg" },
  non:  { name: "Nonane",  n: 9,  chain: "images/session0/chains/nonane.svg",   ring: null },
  dec:  { name: "Decane",  n: 10, chain: "images/session0/chains/decane.svg",   ring: null },
};
export const CHAIN_ORDER = ["meth", "eth", "prop", "but", "pent", "hex", "hept", "oct", "non", "dec"];

/* Uppercases the first character of a string. */
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/* ── Mountable picker component ──────────────────────────────────────────── */
/* Renders the picker into hostEl and wires its controls. Any existing content
 * in the host is replaced. */
export function mountSkeletalPicker(hostEl, opts = {}) {
  if (!hostEl) return;
  let activeChainKey  = (opts.initialKey && CHAIN_DATA[opts.initialKey]) ? opts.initialKey : "prop";
  let cycloMode       = false;
  let pickerNumbering = false;

  hostEl.innerHTML = `
    <div class="picker-image-wrap" data-skp="imageWrap"></div>
    <p class="picker-label" data-skp="label"></p>
    <p class="picker-detail" data-skp="detail"></p>

    <p class="picker-control-label">Structure type</p>
    <div class="picker-toggle-row">
      <button type="button" class="picker-btn" data-skp="cycloToggle" aria-pressed="false">○ Chain</button>
      <span class="picker-hint" data-skp="cycloHint">Toggle to see ring (cyclo) structures</span>
    </div>

    <p class="picker-control-label">Carbon-number labels</p>
    <div class="picker-toggle-row">
      <button type="button" class="picker-btn" data-skp="numberToggle" aria-pressed="false">Show carbon numbering</button>
    </div>

    <p class="picker-control-label">Carbon-chain prefix (click any to explore)</p>
    <div class="picker-btn-row" data-skp="prefixRow">
      ${CHAIN_ORDER.map(renderPrefixButton).join("")}
    </div>
  `;

  const $    = sel => hostEl.querySelector(sel);
  const $all = sel => hostEl.querySelectorAll(sel);

  // Markup for one prefix button, marked active or disabled as the state requires.
  function renderPrefixButton(key) {
    const d = CHAIN_DATA[key];
    const isActive   = key === activeChainKey;
    const isDisabled = cycloMode && !d.ring;
    const classes = ["picker-btn"];
    if (isActive) classes.push("is-active");
    return `<button type="button" class="${classes.join(" ")}" data-prefix="${key}" ${isDisabled ? "disabled" : ""}>${escapeHtml(key)}–</button>`;
  }

  // Alt text for the current structure image.
  function structureAlt(d) {
    if (cycloMode && d.ring) return `Cyclo${d.name.toLowerCase()} ring structure`;
    return `${d.name} skeletal structure`;
  }

  // Markup for the image of the active chain or ring, numbered if the toggle is on.
  function renderPickerMolecule() {
    const d = CHAIN_DATA[activeChainKey];
    let src = (cycloMode && d.ring) ? d.ring : d.chain;
    if (pickerNumbering) src = src.replace(/\.svg$/, "_numbered.svg");   // swap to the numbered SVG
    // Wrapper is sized from the SVG's own dimensions once it loads (sizePickerImage).
    return `
      <div class="picker-image-inner" data-skp="imageInner" style="min-height:160px;">
        <img class="picker-image" src="${src}" alt="${escapeHtml(structureAlt(d))}" draggable="false">
      </div>
    `;
  }

  // Sizes the wrapper from the loaded SVG's intrinsic size: 160px tall, capped
  // at 540px wide, keeping the aspect ratio.
  function sizePickerImage() {
    const inner = $('[data-skp="imageInner"]');
    const img = inner && inner.querySelector(".picker-image");
    if (!img) return;
    const apply = () => {
      const vw = img.naturalWidth || 1, vh = img.naturalHeight || 1;
      const TARGET_H = 160, MAX_W = 540;
      let w = (TARGET_H * vw) / vh, h = TARGET_H;
      if (w > MAX_W) { w = MAX_W; h = (MAX_W * vh) / vw; }
      inner.style.width = w + "px";
      inner.style.height = h + "px";
      inner.style.minHeight = "";
    };
    if (img.complete && img.naturalWidth) apply();
    else img.addEventListener("load", apply, { once: true });
  }

  // Re-renders the image, labels, and button states from the current state.
  function refreshPicker() {
    const d    = CHAIN_DATA[activeChainKey];
    const wrap = $('[data-skp="imageWrap"]');
    if (!wrap) return;
    wrap.innerHTML = renderPickerMolecule();

    const ringName = d.ring ? `cyclo${d.name.toLowerCase()}` : null;
    const label    = (cycloMode && ringName) ? capitalize(ringName) : d.name;
    const detail   = (cycloMode && d.ring)
      ? `${d.n}-membered ring · prefix: cyclo${activeChainKey}–`
      : `${d.n} carbon${d.n === 1 ? "" : "s"} · prefix: ${activeChainKey}–`;
    $('[data-skp="label"]').textContent  = label;
    $('[data-skp="detail"]').textContent = detail;

    const cycloBtn = $('[data-skp="cycloToggle"]');
    if (cycloBtn) {
      cycloBtn.setAttribute("aria-pressed", String(cycloMode));
      cycloBtn.textContent = cycloMode ? "● Cyclo" : "○ Chain";
    }
    const cycloHint = $('[data-skp="cycloHint"]');
    if (cycloHint) {
      cycloHint.textContent = cycloMode
        ? "Toggle to see linear chains"
        : "Toggle to see ring (cyclo) structures";
    }

    $all('[data-skp="prefixRow"] .picker-btn').forEach(btn => {
      const key  = btn.dataset.prefix;
      const data = CHAIN_DATA[key];
      btn.classList.toggle("is-active", key === activeChainKey);
      btn.disabled = cycloMode && !data.ring;
    });

    sizePickerImage();
  }

  // Attaches the click handlers for the two toggles and the prefix buttons.
  function wireControls() {
    $('[data-skp="cycloToggle"]')?.addEventListener("click", () => {
      cycloMode = !cycloMode;
      // If cyclo just turned on but the active chain has no ring, fall back to prop.
      if (cycloMode && !CHAIN_DATA[activeChainKey].ring) activeChainKey = "prop";
      refreshPicker();
    });

    $('[data-skp="numberToggle"]')?.addEventListener("click", (e) => {
      pickerNumbering = !pickerNumbering;
      const btn = e.currentTarget;
      btn.setAttribute("aria-pressed", String(pickerNumbering));
      btn.textContent = pickerNumbering ? "Hide carbon numbering" : "Show carbon numbering";
      refreshPicker();   // re-render with the numbered / plain SVG swapped in
    });

    $all('[data-skp="prefixRow"] .picker-btn').forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        activeChainKey = btn.dataset.prefix;
        refreshPicker();
      });
    });
  }

  refreshPicker();
  wireControls();
}
