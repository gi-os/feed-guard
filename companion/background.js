// feed-guard companion. Polls the guard's /status for this device and tells the
// content script in every tab on a blocked site to freeze the page in place.
// Nothing navigates, so the feed is exactly where it was when the block lifts.

const DEFAULT_URL = "http://192.168.68.59:8060/status";
const POLL_MS = 10000;
let status = { blocked: {}, sites: {}, fetchedAt: 0 };

async function statusUrl() {
  const { url } = await chrome.storage.sync.get({ url: DEFAULT_URL });
  return url;
}

function siteOf(urlStr, sites) {
  let host;
  try { host = new URL(urlStr).hostname.toLowerCase(); } catch { return null; }
  for (const [site, domains] of Object.entries(sites)) {
    if (domains.some(d => host === d || host.endsWith("." + d))) return site;
  }
  return null;
}

// What a given page URL should be doing right now.
function verdict(urlStr) {
  const site = siteOf(urlStr, status.sites || {});
  const b = site && status.blocked && status.blocked[site];
  if (!b) return { blocked: false, site };
  const until = status.fetchedAt + b.seconds_left * 1000;
  return { blocked: until > Date.now(), site, until };
}

async function poll() {
  try {
    const r = await fetch(await statusUrl(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    status = await r.json();
    status.fetchedAt = Date.now();
    await push();
    badge();
  } catch (e) {
    lastIconKey = "";
    chrome.action.setIcon({ imageData: { 16: drawIcon(16, { frac: 0, label: "?", color: "#888", faint: "rgba(136,136,136,.3)" }),
                                         32: drawIcon(32, { frac: 0, label: "?", color: "#888", faint: "rgba(136,136,136,.3)" }) } }).catch(() => {});
  }
}

// Tell every tab on a guarded site its current verdict (freeze or release).
async function push() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.url || !t.id) continue;
    const v = verdict(t.url);
    if (!v.site) continue;
    chrome.tabs.sendMessage(t.id, { type: "verdict", ...v }).catch(() => {});
  }
}

// The toolbar icon is the timer. Resting: a red ring draining with the cooldown
// and the minutes left in the middle (seconds under a minute). Otherwise: a
// ring filling with the budget spent and the minutes used. Nothing: idle mark.
function drawIcon(size, { frac, label, color, faint }) {
  const c = new OffscreenCanvas(size, size), g = c.getContext("2d");
  const r = size / 2, lw = Math.max(1.5, size * 0.11);
  g.clearRect(0, 0, size, size);
  g.beginPath(); g.arc(r, r, r - lw / 2 - 0.5, 0, Math.PI * 2);
  g.strokeStyle = faint; g.lineWidth = lw; g.stroke();
  if (frac > 0) {
    g.beginPath(); g.arc(r, r, r - lw / 2 - 0.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, frac));
    g.strokeStyle = color; g.lineCap = "round"; g.stroke();
  }
  if (label) {
    g.fillStyle = color;
    g.font = `${label.length > 1 ? 600 : 700} ${Math.round(size * (label.length > 1 ? 0.42 : 0.6))}px -apple-system,system-ui,sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(label, r, r + size * 0.04);
  }
  return g.getImageData(0, 0, size, size);
}

function iconSpec() {
  const blocked = status.blocked || {};
  const keys = Object.keys(blocked);
  if (keys.length) {
    // Soonest release drives the icon.
    const left = Math.max(0, Math.min(...keys.map(k => status.fetchedAt + blocked[k].seconds_left * 1000)) - Date.now()) / 1000;
    const total = (status.cooldown_minutes || 5) * 60;
    return { frac: left / total, color: "#e74c3c", faint: "rgba(231,76,60,.25)",
             label: left >= 60 ? String(Math.ceil(left / 60)) : String(Math.ceil(left)) };
  }
  const used = Object.values(status.used_minutes || {});
  const worst = used.length ? Math.max(...used) : 0;
  const budget = status.budget_minutes || 5;
  if (worst) return { frac: worst / budget, color: worst >= budget - 1 ? "#e67e22" : "#ecf0f1", faint: "rgba(236,240,241,.25)", label: String(worst) };
  return { frac: 0, color: "#ecf0f1", faint: "rgba(236,240,241,.35)", label: "" };
}

let lastIconKey = "";
function badge() {
  chrome.action.setBadgeText({ text: "" });
  const spec = iconSpec();
  const key = JSON.stringify(spec);
  if (key === lastIconKey) return;
  lastIconKey = key;
  chrome.action.setIcon({ imageData: { 16: drawIcon(16, spec), 32: drawIcon(32, spec) } }).catch(() => {});
}
setInterval(badge, 1000);

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m && m.type === "verdict?") {            // content script asking on load
    reply(verdict(m.url || (sender.tab && sender.tab.url) || ""));
    return true;
  }
  if (m === "status") { reply(status); return true; }
  if (m === "poll") { poll().then(() => reply(status)); return true; }
});

chrome.alarms.create("poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === "poll") poll(); });
chrome.runtime.onStartup.addListener(poll);
chrome.runtime.onInstalled.addListener(poll);
(function loop() { poll().finally(() => setTimeout(loop, POLL_MS)); })();
