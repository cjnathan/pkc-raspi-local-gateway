# README — UniFi "Quota Guard": keep phones/laptops from draining the internet link

Goal: human devices (phones, laptops) get their own WiFi with a bandwidth cap,
while the 44 ESP meter converters stay untouched on their own SSID.
Everything below is **enforced by the APs themselves** — it works even though
the router behind the link is a Teltonika RUT241, not a UniFi gateway.

**Do NOT edit the `kwhpkj` SSID.** 44 converters ride on it; any change kicks
them all and stirs up the modem connection.

## Current state (checked 2026-11-16)

| Item | Value |
|---|---|
| SSIDs | `perum_pkc`, `kwhpkj` (both WPA2, no schedule, no rate limits) |
| User group | "Default" = unlimited down/up |
| WiFi clients | ~45: 44 ESP meters + 1 human device |

## What UniFi can and cannot do

- UniFi has **no monthly-GB quota feature**. Protection = rate limit + schedule + blocking.
- Rate limits / schedules / MAC block are **AP-enforced** → work in this setup.
- VLAN firewall rules and DPI traffic blocks need a **UniFi router (USG/UDM)** — skip unless one exists.

## Steps (manual, in the UniFi controller web UI)

### 1. Create the limited user group
Settings → Network → **User Groups** → *Create new*:
- Name: `Limited`
- Download: `2048` Kbps, Upload: `1024` Kbps (≈2 Mbps / 1 Mbps)

Rationale: the RUT241 (LTE Cat 1) tops out around 10/5 Mbps theoretical and
less in practice; capping humans at 2/1 leaves headroom for the meters and
your dashboard, and bounds any quota burn. Adjust to taste — even 1 Mbps
makes streaming impractical, which is the point.

### 2. Create the staff SSID
Settings → Network → **WLANs** → *Add new WLAN*:
- Name: `pkc-staff`
- Security: WPA2, **strong unique password** (not the meter SSID password)
- Advanced → **User Group: `Limited`**
- Advanced → optional: **WLAN Schedule** (e.g. disabled 23:00–06:00)
- Leave VLAN empty unless the router manages VLANs.

### 3. Move the human devices
On each phone/laptop: forget `perum_pkc`, join `pkc-staff`.
Then, in the controller: Clients → select any device still sitting on
`perum_pkc`/`kwhpkj` → **Block** (can be un-blocked later).

### 4. Verify
1. Connect a phone to `pkc-staff`, run a speed test → must plateau near the cap (~2 Mbps).
2. Dashboard `:8090` → Metering tab: meters keep writing/publishing as before.
3. Clients list: staff device shows group `Limited`; all `ESP_*` show `Default`.
4. UniFi Statistics → traffic: staff device share shrinks over time.

### 5. Rollback (if anything misbehaves)
Delete `pkc-staff` SSID and/or set the SSID's user group back to `Default`.
Nothing in this recipe touches `kwhpkj`, so the meter network is unaffected.

## Notes / caveats

- Rate caps protect the link but don't stop small background burns (app
  updates at 2 Mbps still burn GBs over hours). The schedule in step 2 is the
  complement — add it if quota pressure is real.
- If a UniFi router (USG/UDM) is ever installed, the stronger end-game is:
  staff SSID in its own VLAN + firewall rule denying WAN = zero internet.
- This is experimental: apply to the staff SSID only; the meter SSID stays
  out of scope by design.
