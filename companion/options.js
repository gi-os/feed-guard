const $ = id => document.getElementById(id);
chrome.storage.sync.get({ url: "http://192.168.68.59:8060/status" }, v => $("url").value = v.url);
$("save").onclick = () => chrome.storage.sync.set({ url: $("url").value.trim() }, () =>
  chrome.runtime.sendMessage("poll", s => $("st").textContent = JSON.stringify(s, null, 1)));
chrome.runtime.sendMessage("status", s => $("st").textContent = JSON.stringify(s, null, 1));
