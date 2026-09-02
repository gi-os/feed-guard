"""feed-guard: per-device time budgets for social feeds, enforced through AdGuard Home.

Every POLL_SECONDS it reads AdGuard's query log. A query for one of a site's
domains marks that (device, site) pair active for the current minute. A device
is its DoH ClientID when it has one (`.../dns-query/gio-iphone`, which must also
be the persistent client's name in AdGuard), otherwise its LAN IP. Once a
device has BUDGET active minutes on a site inside one session, the guard writes
`||domain^$client=<ip>` rules into AdGuard's user rules for COOLDOWN minutes,
then removes them and the session starts fresh. A session is forgotten after
IDLE_RESET minutes with no traffic.

The guard owns only the block of user rules between its two marker lines;
anything else in the user-rules box is preserved verbatim.
"""

import json
import logging
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import requests
import yaml

log = logging.getLogger("feed-guard")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

ADGUARD_URL = os.environ["ADGUARD_URL"].rstrip("/")
AUTH = (os.environ["ADGUARD_USER"], os.environ["ADGUARD_PASS"])
BUDGET_OVERRIDE = os.environ.get("BUDGET_MINUTES")  # testing hook
POLL = int(os.environ.get("POLL_SECONDS", "15"))
STATE_PATH = Path(os.environ.get("STATE_PATH", "/state/state.json"))
SITES_PATH = Path(os.environ.get("SITES_PATH", "/app/sites.yml"))

MARK_BEGIN = "! feed-guard begin (managed, do not edit)"
MARK_END = "! feed-guard end"

_FRAC = re.compile(r"\.(\d+)")


def load_sites():
    cfg = yaml.safe_load(SITES_PATH.read_text())
    return (
        {name: tuple(d.lower().strip(".") for d in doms) for name, doms in cfg["sites"].items()},
        int(BUDGET_OVERRIDE or cfg.get("budget_minutes", 5)),
        int(cfg.get("cooldown_minutes", 5)),
        int(cfg.get("idle_reset_minutes", 10)),
    )


def site_for(qname, sites):
    q = qname.lower().rstrip(".")
    for name, doms in sites.items():
        for d in doms:
            if q == d or q.endswith("." + d):
                return name
    return None


def api(method, path, **kw):
    r = requests.request(method, f"{ADGUARD_URL}/control{path}", auth=AUTH, timeout=20, **kw)
    r.raise_for_status()
    return r.json() if r.content and "json" in r.headers.get("content-type", "") else None


def load_state():
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except Exception:
            log.warning("state file unreadable, starting clean")
    return {"sessions": {}, "blocks": {}, "last_seen": None}


def save_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    tmp.replace(STATE_PATH)


def parse_time(s):
    """AdGuard emits RFC3339 with nanoseconds; Python wants <= 6 fractional digits."""
    s = _FRAC.sub(lambda m: "." + m.group(1)[:6].ljust(6, "0"), s, count=1)
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def fetch_new_queries(state):
    """Return [(epoch, client_ip, qname)] for log entries newer than the last poll."""
    last = state.get("last_seen")  # RFC3339 string of the newest entry already processed
    data = api("GET", "/querylog", params={"limit": 1000, "response_status": "all"})
    newest, out = None, []
    for e in data.get("data", []):  # newest first
        t = e.get("time")
        if newest is None:
            newest = t
        if last and t <= last:
            break
        q = e.get("question", {}).get("name", "")
        who = e.get("client_id") or e.get("client", "")  # DoH ClientID beats IP
        if q:
            out.append((parse_time(t), who, q))
    if newest:
        state["last_seen"] = newest
    return out


def sync_rules(blocks, sites):
    """Rewrite the managed block of AdGuard user rules to mirror `blocks`."""
    status = api("GET", "/filtering/status")
    rules = status.get("user_rules", []) or []
    if MARK_BEGIN in rules and MARK_END in rules:
        b, e = rules.index(MARK_BEGIN), rules.index(MARK_END)
        rules = rules[:b] + rules[e + 1 :]
    managed = [MARK_BEGIN]
    for key in sorted(blocks):
        ip, site = key.split("|", 1)
        for d in sites.get(site, ()):
            managed.append(f"||{d}^$client={ip}")
    managed.append(MARK_END)
    api("POST", "/filtering/set_rules", json={"rules": rules + managed})


def tick(state, sites, budget, cooldown, idle_reset):
    now = time.time()
    sessions, blocks = state["sessions"], state["blocks"]
    dirty = False

    # 1. expire finished cooldowns
    for key in [k for k, until in blocks.items() if until <= now]:
        del blocks[key]
        sessions.pop(key, None)
        log.info("release %s", key)
        dirty = True

    # 2. count activity, one tick per (device, site, wall-clock minute)
    for ts, ip, qname in fetch_new_queries(state):
        site = site_for(qname, sites)
        if not site or not ip:
            continue
        key = f"{ip}|{site}"
        if key in blocks:
            continue  # blocked queries don't extend the budget
        minute = int(ts // 60)
        s = sessions.setdefault(key, {"minutes": [], "last": ts})
        if ts - s["last"] > idle_reset * 60:
            s["minutes"] = []
        s["last"] = max(s["last"], ts)
        if minute not in s["minutes"]:
            s["minutes"].append(minute)
            log.info("%s active %d/%d min", key, len(s["minutes"]), budget)

    # 3. forget idle sessions, block exhausted ones
    for key, s in list(sessions.items()):
        if key in blocks:
            continue
        if now - s["last"] > idle_reset * 60:
            del sessions[key]
            continue
        if len(s["minutes"]) >= budget:
            blocks[key] = now + cooldown * 60
            log.info("BLOCK %s for %dm", key, cooldown)
            dirty = True

    if dirty:
        sync_rules(blocks, sites)
    save_state(state)


def main():
    sites, budget, cooldown, idle_reset = load_sites()
    state = load_state()
    log.info("watching %s | budget %dm, cooldown %dm, idle reset %dm",
             ", ".join(sites), budget, cooldown, idle_reset)
    while True:
        try:
            sync_rules(state["blocks"], sites)  # reconcile after a restart
            break
        except requests.RequestException as ex:
            log.warning("waiting for adguard: %s", ex)
            time.sleep(POLL)
    while True:
        try:
            tick(state, sites, budget, cooldown, idle_reset)
        except requests.RequestException as ex:
            log.warning("adguard unreachable: %s", ex)
        except Exception:
            log.exception("tick failed")
        time.sleep(POLL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
