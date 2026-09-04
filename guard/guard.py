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

A DNS block cannot close a connection that is already open, so the guard also
serves `GET /status` on STATUS_PORT. It answers for the caller's own IP with the
sites currently blocked and the budget already spent, so a companion on the
device (see `companion/`) can shut the open tabs itself.
"""

import json
import logging
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
STATUS_PORT = int(os.environ.get("STATUS_PORT", "8060"))

# Shared with the status server. Replaced wholesale by tick(), never mutated.
SNAPSHOT = {"state": {"sessions": {}, "blocks": {}}, "sites": {}, "budget": 0, "cooldown": 0}

MARK_BEGIN = "! feed-guard begin (managed, do not edit)"
MARK_END = "! feed-guard end"

_FRAC = re.compile(r"\.(\d+)")


ONLY = set()  # device identities the guard acts on; empty = everyone


def load_sites():
    global ONLY
    cfg = yaml.safe_load(SITES_PATH.read_text())
    ONLY = set(str(x) for x in (cfg.get("only") or []))
    return (
        {name: tuple(d.lower().strip(".") for d in doms) for name, doms in cfg["sites"].items()},
        int(BUDGET_OVERRIDE or cfg.get("budget_minutes", 5)),
        int(cfg.get("cooldown_minutes", 5)),
        float(cfg.get("regen_every_minutes", cfg.get("idle_reset_minutes", 10) / 5)),
    )


def used_now(sess, now, regen_every):
    """Minutes of budget spent, after time away has earned some back.

    The minute of the last activity is itself spent, so only the gap beyond it
    counts as time away. One minute returns per `regen_every` minutes away.
    """
    away = max(0.0, (now - sess["last"]) / 60 - 1)
    return max(0.0, sess["used"] - away / regen_every)


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


class StatusHandler(BaseHTTPRequestHandler):
    """GET /status -> the caller's own blocks and budgets, keyed by site.

    Bridge-mode published ports keep the client's real source address, so the
    peer IP is the same identity the guard uses for its rules. `?client=` lets a
    DoH-ClientID device ask about itself by name.
    """

    server_version = "feed-guard"

    def log_message(self, *_):
        pass

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path != "/status":
            self.send_response(404)
            self.end_headers()
            return
        who = self.client_address[0]
        for part in query.split("&"):
            k, _, v = part.partition("=")
            if k == "client" and v:
                who = v
        snap = SNAPSHOT
        now = time.time()
        blocked = {}
        for key, until in snap["state"]["blocks"].items():
            ip, site = key.split("|", 1)
            if ip == who and until > now:
                blocked[site] = {"seconds_left": int(until - now),
                                 "domains": list(snap["sites"].get(site, ()))}
        used, full_in = {}, {}
        for key, sess in snap["state"]["sessions"].items():
            ip, site = key.split("|", 1)
            if ip == who and site not in blocked and "used" in sess:
                u = used_now(sess, now, snap["regen_every"])
                if u > 0:
                    used[site] = round(u, 2)
                    # seconds until this budget is whole again, if left alone
                    full_in[site] = int(max(0, (sess["last"] + 60 - now)) + u * snap["regen_every"] * 60)
        body = json.dumps({"client": who, "blocked": blocked, "used_minutes": used, "full_in_seconds": full_in,
                           "budget_minutes": snap["budget"], "cooldown_minutes": snap["cooldown"],
                           "regen_every_minutes": snap["regen_every"],
                           "sites": {k: list(v) for k, v in snap["sites"].items()}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def start_status_server():
    srv = ThreadingHTTPServer(("0.0.0.0", STATUS_PORT), StatusHandler)
    threading.Thread(target=srv.serve_forever, name="status", daemon=True).start()
    log.info("status endpoint on :%d", STATUS_PORT)


def tick(state, sites, budget, cooldown, regen_every):
    global SNAPSHOT
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
        if not site or not ip or (ONLY and ip not in ONLY):
            continue
        key = f"{ip}|{site}"
        if key in blocks:
            continue  # blocked queries don't extend the budget
        minute = int(ts // 60)
        s = sessions.get(key)
        if s is None or "used" not in s:
            s = sessions[key] = {"used": 0.0, "last": ts, "minute": None}
        if minute != s["minute"]:
            # Settle what time away gave back, then spend this minute.
            s["used"] = used_now(s, ts, regen_every) + 1
            s["minute"] = minute
            s["last"] = max(s["last"], ts)
            log.info("%s active %.1f/%d min", key, s["used"], budget)
        else:
            s["last"] = max(s["last"], ts)

    # 3. drop fully-regenerated sessions, block exhausted ones
    for key, s in list(sessions.items()):
        if key in blocks:
            continue
        if used_now(s, now, regen_every) <= 0:
            del sessions[key]
            continue
        if s["used"] >= budget:
            blocks[key] = now + cooldown * 60
            log.info("BLOCK %s for %dm", key, cooldown)
            dirty = True

    if dirty:
        sync_rules(blocks, sites)
    save_state(state)
    SNAPSHOT = {"state": json.loads(json.dumps(state)), "sites": sites,
                "budget": budget, "cooldown": cooldown, "regen_every": regen_every}


def main():
    sites, budget, cooldown, regen_every = load_sites()
    state = load_state()
    state["sessions"] = {k: v for k, v in state["sessions"].items() if "used" in v}  # drop v1 shape
    log.info("watching %s | budget %dm, cooldown %dm, 1 min back per %.1f min away | devices: %s",
             ", ".join(sites), budget, cooldown, regen_every, ", ".join(sorted(ONLY)) or "all")
    global SNAPSHOT
    SNAPSHOT = {"state": json.loads(json.dumps(state)), "sites": sites,
                "budget": budget, "cooldown": cooldown, "regen_every": regen_every}
    start_status_server()
    while True:
        try:
            sync_rules(state["blocks"], sites)  # reconcile after a restart
            break
        except requests.RequestException as ex:
            log.warning("waiting for adguard: %s", ex)
            time.sleep(POLL)
    while True:
        try:
            tick(state, sites, budget, cooldown, regen_every)
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
