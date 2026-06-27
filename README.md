# BassAction

Solar-surplus automation for an **MSpa** hot tub and a **Toshiba** aircon, driven by
**GoodWe** battery SOC. Runs entirely on a **GitHub Actions** schedule — no server,
no always-on PC. A read-only dashboard is hosted on **GitHub Pages**.

This is the cloud sibling of the `BassESP` firmware. The ESP8266 couldn't complete
the MSpa cloud TLS handshake; Node on GitHub's runners has no such trouble.

## How it works

```
 GitHub Actions (cron, every 15 min)
        │  reads
        ├─ GoodWe SOC + power  ← SEMS portal cloud API
        ├─ MSpa state          ← MSpa cloud API
        └─ Toshiba AC state    ← Toshiba cloud API
        │  decides (src/automation.js — same rules as the firmware)
        │  acts (only if CONTROL_ENABLED=true)
        │  writes
        ├─ state.json          → committed back (timers/ownership survive between runs)
        └─ docs/status.json    → committed back; the Pages dashboard reads it
```

`docs/index.html` is the dashboard. GitHub Pages serves `docs/`; the page fetches
`status.json` and refreshes every 60 s. Read-only for now.

## Setup

1. **Create a repo** and push this folder.
2. **Settings → Pages**: Source = "Deploy from a branch", Branch = `main`, Folder = `/docs`.
   Your dashboard appears at `https://<user>.github.io/<repo>/`.
3. **Settings → Secrets and variables → Actions**:
   - Add the secrets listed in `.env.example` (or rely on the fallbacks baked into
     `src/config.js` if the repo is **private**).
   - Add a **variable** `CONTROL_ENABLED` = `false` to start (read-only). Flip to
     `true` once the dashboard looks right and you trust the decisions.
4. **Actions tab → BassAction → Run workflow** to trigger the first run manually.

> ⚠️ The fallback credentials in `src/config.js` are real. Keep the repo **private**,
> or blank them out and use Secrets only, before making it public.

## Behaviour (mirrors the firmware)

- MSpa heater: start at SOC ≥ 70 %, auto-stop ≤ 60 %. AC: start ≥ 50 %, stop ≤ 40 %.
- Only auto-starts 07:00–22:00 Prague; auto-started devices are forced off at 22:00.
- Won't start the heater if water is already near target, nor the AC if it has no
  useful work to do (mode-aware). Room ≫ AC target → cooling gets priority over the spa.
- **Never auto-stops a device a human switched on.** If you touch a device, automation
  backs off 2 h, then re-arms.
- Scheduled filtration: 11 PM + 6 AM (full, ozone), 1 PM (filter+UVC, weekdays).
  Won't run while bubbles are on; aborts ozone if bubbles come on.

## Local testing

```
npm install
cp .env.example .env   # optional; edit values
npm start              # one run; writes docs/status.json + state.json
```

## Notes / limits vs. the ESP

- SOC comes from the **SEMS cloud**, not the local inverter (CI can't reach your LAN).
- Cron granularity is ~15 min and can be delayed a few minutes under GitHub load.
- An **ESP32** could run this whole thing locally (it handles the cloud TLS the
  ESP8266 choked on) — kept as a future option.
