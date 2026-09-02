const q = new URLSearchParams(location.search);
  const site = q.get("site") || "this feed", until = +q.get("until") || Date.now();
  document.getElementById("site").textContent = site;
  document.title = `${site} · feed-guard`;
  function tick() {
    const s = Math.max(0, Math.round((until - Date.now()) / 1000));
    document.getElementById("t").textContent = `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
    if (s <= 0) { clearInterval(iv); setTimeout(() => history.length > 1 ? history.back() : location.replace("about:blank"), 1500); }
  }
  tick(); const iv = setInterval(tick, 500);
