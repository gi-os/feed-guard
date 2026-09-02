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
    chrome.action.setBadgeText({ text: "?" });
    chrome.action.setBadgeBackgroundColor({ color: "#888" });
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

function badge() {
  const n = Object.keys(status.blocked || {}).length;
  if (n) {
    chrome.action.setBadgeText({ text: String(n) });
    chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
  } else {
    const used = Object.values(status.used_minutes || {});
    const worst = used.length ? Math.max(...used) : 0;
    chrome.action.setBadgeText({ text: worst ? `${worst}/${status.budget_minutes}` : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#2c3e50" });
  }
}

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
