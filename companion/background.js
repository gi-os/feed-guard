// feed-guard companion. Polls the guard's /status for this device and drives
// every tab on a blocked site to blocked.html. Also checks each new navigation
// so a fresh tab is caught in the same second, not at the next poll.

const DEFAULT_URL = "http://192.168.68.59:8060/status";
const POLL_MS = 10000;          // service worker keep-alive loop; alarms are the fallback
let status = { blocked: {}, sites: {} };

async function statusUrl() {
  const { url } = await chrome.storage.sync.get({ url: DEFAULT_URL });
  return url;
}

function hostMatches(host, domains) {
  host = host.toLowerCase();
  return domains.some(d => host === d || host.endsWith("." + d));
}

function siteOf(urlStr, sites) {
  let host;
  try { host = new URL(urlStr).hostname; } catch { return null; }
  for (const [site, domains] of Object.entries(sites)) {
    if (hostMatches(host, domains)) return site;
  }
  return null;
}

async function poll() {
  try {
    const r = await fetch(await statusUrl(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    status = await r.json();
    await chrome.storage.local.set({ lastStatus: status, lastOk: Date.now() });
    await enforce();
    badge();
  } catch (e) {
    // Guard unreachable: fail open, but say so.
    chrome.action.setBadgeText({ text: "?" });
    chrome.action.setBadgeBackgroundColor({ color: "#888" });
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

function blockPage(site) {
  const b = status.blocked[site];
  const until = Date.now() + (b.seconds_left * 1000);
  return chrome.runtime.getURL(`blocked.html?site=${encodeURIComponent(site)}&until=${until}`);
}

async function enforce() {
  const blocked = status.blocked || {};
  if (!Object.keys(blocked).length) return;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.url) continue;
    const site = siteOf(t.url, status.sites || {});
    if (site && blocked[site]) {
      chrome.tabs.update(t.id, { url: blockPage(site) }).catch(() => {});
    }
  }
}

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  const site = siteOf(details.url, status.sites || {});
  if (site && status.blocked && status.blocked[site]) {
    chrome.tabs.update(details.tabId, { url: blockPage(site) }).catch(() => {});
  }
});

chrome.alarms.create("poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === "poll") poll(); });
chrome.runtime.onStartup.addListener(poll);
chrome.runtime.onInstalled.addListener(poll);
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m === "status") { reply(status); return true; }
  if (m === "poll") { poll().then(() => reply(status)); return true; }
});

// Tighter loop while the worker is alive (it stays alive while tabs message it
// or while this timer chain keeps it busy; alarms cover the gaps).
(function loop() { poll().finally(() => setTimeout(loop, POLL_MS)); })();
