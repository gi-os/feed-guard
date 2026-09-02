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

## Limits

* DNS blocks bite on the next lookup. An open feed keeps going until its cached
  records expire and its HTTP/2 connections drop. Expect a lag of one to two
  minutes before the block is felt.
* Only devices that use this DNS are covered. iCloud Private Relay, browser DoH
  or a VPN bypass it, unless the device is pointed at AdGuard's own DoH endpoint.
* The query log must have `anonymize_client_ip` off or every device looks alike.

## Verified

2026-09-02 on BasilNet against AdGuard Home v0.107.79: five minutes of `api.x.com`
lookups from one LAN client produced eight `$client=` rules for that IP only,
`api.x.com → 0.0.0.0` for that client, `instagram.com` unaffected, release after
five minutes.
