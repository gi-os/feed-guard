# feed-guard

Per-device time budgets for social feeds, enforced at the DNS layer by
[AdGuard Home](https://github.com/AdguardTeam/AdGuardHome). Five active minutes
of X, Instagram, TikTok or Reddit per device, then five minutes of `0.0.0.0`.
Every device and every site has its own budget. Sessions reset after ten idle
minutes.

## How it works

`guard/guard.py` polls AdGuard's query log every 15 seconds. A DNS query for one
of a site's domains marks that (device, site) pair active for the current
wall-clock minute. A device is its DoH ClientID when it has one
(`https://dns.example/dns-query/gio-iphone`, which must also be the persistent
client's name in AdGuard), otherwise its LAN IP. Once a device reaches the budget
the guard writes `||domain^$client=<device>` rules into AdGuard's user rules for
the cooldown, then removes them and the session starts fresh.

The guard owns only the rules between its two marker comments. Anything else in
the user-rules box is left alone.

Tune budgets, cooldown, idle reset and the domain lists in `guard/sites.yml`.

## Deploy

Copy `guard/` next to your AdGuard compose file as `feed-guard/`, paste the
service from `docker-compose.example.yml`, set the password, then:

```
docker compose up -d --build feed-guard
docker logs -f feed-guard
```

For the block to reach clients quickly, set AdGuard's minimum cache TTL to 0
and the maximum to 60 (Settings → DNS settings → DNS cache configuration).

## Companion (closes open tabs)

A DNS block cannot end a connection that is already open. A feed left scrolling
in a tab keeps its HTTP/2 sockets and never asks DNS again, so the block is
never felt. The guard therefore serves `GET /status` on port 8060, which answers
for the caller's own IP:

```
{"client":"192.168.68.94","blocked":{"x":{"seconds_left":211,"domains":[...]}},
 "used_minutes":{"reddit":2},"budget_minutes":5,"cooldown_minutes":5,"sites":{...}}
```

`companion/` is a Manifest V3 browser extension (Chrome, Dia, Arc, Brave, Edge)
that polls it every 10-30 s and sends every tab on a blocked site to a countdown
page, and catches new navigations to a blocked site on the spot. Load it with
`chrome://extensions` → Developer mode → Load unpacked → the `companion` folder.
The status URL is editable in the extension's options. The badge shows minutes
spent (`3/5`) or the number of sites resting.

## Limits

* Without the companion, a DNS block bites only on the next lookup. An open feed
  keeps going until its cached records expire and its HTTP/2 connections drop.
* Only devices that use this DNS are covered. iCloud Private Relay, browser DoH
  or a VPN bypass it, unless the device is pointed at AdGuard's own DoH endpoint.
* The query log must have `anonymize_client_ip` off or every device looks alike.

## Verified

2026-09-02 on BasilNet against AdGuard Home v0.107.79: five minutes of `api.x.com`
lookups from one LAN client produced eight `$client=` rules for that IP only,
`api.x.com → 0.0.0.0` for that client, `instagram.com` unaffected, release after
five minutes.

## Releases

* **v1.1.0** (2026-09-02) — `GET /status` endpoint on :8060 (per-caller blocks,
  minutes used, domain lists); `companion/` browser extension that closes tabs
  on blocked sites and intercepts new navigations. Fixes the "open tab never
  stops" gap.
* **v1.0.0** (2026-09-02) — first release: per-device, per-site 5/5 budgets via
  AdGuard user rules.
