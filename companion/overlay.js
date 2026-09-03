// Runs at document_start on guarded sites. Freezes the page under a full-screen
// countdown while feed-guard says this device is resting; lifts it in place.

(() => {
  const ID = "__feed_guard_overlay";
  let until = 0, timer = null, scrollY = 0;

  const swallow = e => { e.stopImmediatePropagation(); e.preventDefault(); };
  const EVENTS = ["wheel", "touchstart", "touchmove", "keydown", "keyup", "keypress", "mousedown", "mouseup", "click", "dblclick", "pointerdown", "pointerup", "contextmenu"];

  function mount() {
    if (document.getElementById(ID)) return;
    const root = document.documentElement;
    scrollY = window.scrollY;
    const el = document.createElement("div");
    el.id = ID;
    el.setAttribute("style", [
      "position:fixed", "inset:0", "z-index:2147483647", "background:#111", "color:#eee",
      "display:flex", "flex-direction:column", "align-items:center", "justify-content:center",
      "gap:14px", "font:16px/1.4 -apple-system,system-ui,sans-serif", "text-align:center",
      "cursor:default", "user-select:none"
    ].join(";"));
    el.innerHTML = `<div style="color:#999"><span data-site style="color:#eee;text-transform:capitalize"></span> is resting.</div>
      <div data-t style="font-size:64px;font-weight:300;font-variant-numeric:tabular-nums;letter-spacing:.02em">--:--</div>`;
    (document.body || root).appendChild(el);
    for (const ev of EVENTS) window.addEventListener(ev, swallow, { capture: true, passive: false });
    document.querySelectorAll("video, audio").forEach(m => { try { m.pause(); } catch {} });
    timer = setInterval(tick, 500);
    tick();
  }

  function unmount() {
    const el = document.getElementById(ID);
    if (!el) return;                       // nothing up: never touch the page
    el.remove();
    for (const ev of EVENTS) window.removeEventListener(ev, swallow, { capture: true });
    clearInterval(timer); timer = null;
    if (Math.abs(window.scrollY - scrollY) > 2) window.scrollTo(0, scrollY);
  }

  function tick() {
    const el = document.getElementById(ID);
    if (!el) return;
    const s = Math.max(0, Math.round((until - Date.now()) / 1000));
    el.querySelector("[data-t]").textContent =
      `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    if (s <= 0) unmount();
  }

  function apply(v) {
    if (!v) return;
    if (v.blocked) {
      until = v.until;
      const go = () => { mount(); const n = document.getElementById(ID); if (n) n.querySelector("[data-site]").textContent = v.site; };
      document.body ? go() : document.addEventListener("DOMContentLoaded", go, { once: true });
    } else {
      unmount();
    }
  }

  chrome.runtime.onMessage.addListener(m => { if (m && m.type === "verdict") apply(m); });
  chrome.runtime.sendMessage({ type: "verdict?", url: location.href }, apply);
  // Re-ask when the SPA changes route (x.com never reloads).
  let last = location.href;
  setInterval(() => { if (location.href !== last) { last = location.href; chrome.runtime.sendMessage({ type: "verdict?", url: last }, apply); } }, 2000);
})();
