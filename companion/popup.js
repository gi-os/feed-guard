const $ = id => document.getElementById(id);
let st = null;
const usedNow = (st, site) => { const u = (st.used_minutes || {})[site]; if (u == null) return 0;
  return Math.max(0, u - ((Date.now() - st.fetchedAt) / 60000) / (st.regen_every_minutes || 2)); };
const mmss = s => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
function render() {
  if (!st) { $("big").textContent = "?"; $("sub").textContent = "guard unreachable"; return; }
  const blocked = st.blocked || {}, keys = Object.keys(blocked);
  const list = $("list"); list.innerHTML = "";
  if (keys.length) {
    const soon = keys.map(k => [k, st.fetchedAt + blocked[k].seconds_left * 1000 - Date.now()]).sort((a, b) => a[1] - b[1])[0];
    $("big").textContent = mmss(Math.max(0, Math.round(soon[1] / 1000)));
    $("sub").innerHTML = `<span class="site">${soon[0]}</span> is resting`;
  } else {
    const worst = Object.keys(st.used_minutes || {}).map(k => [k, usedNow(st, k)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1])[0];
    if (worst) {
      const left = Math.max(0, st.budget_minutes - worst[1]);
      $("big").textContent = mmss(Math.round(left * 60));
      $("sub").innerHTML = `left on <span class="site">${worst[0]}</span> · refilling`;
    } else { $("big").textContent = "·"; $("sub").textContent = "all budgets full"; }
  }
  for (const site of Object.keys(st.sites || {})) {
    const li = document.createElement("li");
    if (blocked[site]) { li.className = "rest"; li.innerHTML = `<b>${site}</b><span>${mmss(Math.max(0, Math.round((st.fetchedAt + blocked[site].seconds_left * 1000 - Date.now()) / 1000)))}</span>`; }
    else { const u = usedNow(st, site); li.innerHTML = `<b>${site}</b><span>${mmss(Math.round(Math.max(0, st.budget_minutes - u) * 60))} left</span>`; }
    list.appendChild(li);
  }
}
chrome.runtime.sendMessage("status", s => { st = s && s.fetchedAt ? s : null; render(); });
setInterval(() => { chrome.runtime.sendMessage("status", s => { st = s && s.fetchedAt ? s : null; render(); }); }, 1000);
$("gear").onclick = () => chrome.runtime.openOptionsPage();
