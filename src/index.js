'use strict';
try { require('dotenv').config(); } catch { /* dotenv optional; CI uses real env */ }
// Entry point for one scheduled run:
//   1. read all three services (resilient — one failure doesn't sink the rest)
//   2. run the automation engine
//   3. optionally send commands (config.controlEnabled)
//   4. persist state + publish the dashboard status (Gist in CI, files in dev)
const cfg = require('./config');
const state = require('./state');
const store = require('./store');
const { decide } = require('./automation');
const goodwe = require('./goodwe');
const mspa = require('./mspa');
const toshiba = require('./toshiba');
const forecast = require('./forecast');

async function safe(label, fn) {
  try { return { ok: true, ...(await fn()) }; }
  catch (e) { console.error(`[${label}] ${e.message}`); return { ok: false, error: e.message }; }
}

async function main() {
  console.log(`BassAction run @ ${new Date().toISOString()}  control=${cfg.controlEnabled}`);

  // 1. Read everything.
  const socOverride = process.env.SOC_OVERRIDE;
  const haveEspSoc = socOverride != null && socOverride !== '' && !Number.isNaN(Number(socOverride));

  const st = state.parse(await store.loadStateRaw());
  const now = Date.now();

  // Informational PV/load/grid figures. The ESP fetches these from SEMS (its
  // residential IP works where GitHub's datacenter IP is geo-blocked) and sends
  // them in the dispatch payload. We only fall back to a direct GitHub→SEMS pull
  // when the ESP didn't supply them (and even then SEMS usually rejects CI's IP).
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const espExtras = num(process.env.ESP_PV) != null || num(process.env.ESP_LOAD) != null ? {
    pvPower: num(process.env.ESP_PV), loadPower: num(process.env.ESP_LOAD),
    gridPower: num(process.env.ESP_GRID), batteryPower: num(process.env.ESP_BATT),
    charging: process.env.ESP_CHG === '1' || process.env.ESP_CHG === 'true',
  } : null;

  let semsFetched = false;
  if (espExtras) {
    st.semsCache = { ts: now, data: espExtras };
  } else if (cfg.goodwe.enabled && now - (st.semsCache.ts || 0) >= cfg.semsInfoMs) {
    const s = await safe('goodwe', () => goodwe.getStatus());
    semsFetched = true;
    if (s.ok) {
      st.semsCache = { ts: now, data: {
        pvPower: s.pvPower, loadPower: s.loadPower, gridPower: s.gridPower,
        batteryPower: s.batteryPower, charging: s.charging, energyToday: s.energyToday,
      }};
    } else {
      st.semsCache = { ...st.semsCache, ts: now, error: s.error }; // back off; keep last good extras
    }
  }
  const extras = st.semsCache.data || {};

  // Daily weather forecast (Open-Meteo), refreshed every few hours and cached in
  // state. Drives the hot-day AC pre-cool. Best-effort: a failure keeps the last
  // value and never blocks the run.
  let forecastFetched = false;
  if (now - (st.forecastCache.ts || 0) >= cfg.forecast.refreshMs) {
    const fc = await safe('forecast', () => forecast.getDaily());
    forecastFetched = true;
    st.forecastCache = (fc.ok && fc.maxTempC != null)
      ? { ts: now, data: { maxTempC: fc.maxTempC, minTempC: fc.minTempC, currentTempC: fc.currentTempC, weatherCode: fc.weatherCode } }
      : { ...st.forecastCache, ts: now }; // back off; keep last good value
  }
  const forecastData = st.forecastCache.data || null;

  let g;
  if (haveEspSoc) {
    g = { ok: true, source: 'esp-local', batterySOC: Number(socOverride), online: true,
          pvPower: extras.pvPower ?? null, loadPower: extras.loadPower ?? null,
          gridPower: extras.gridPower ?? null, batteryPower: extras.batteryPower ?? null,
          charging: extras.charging ?? null, energyToday: extras.energyToday ?? null,
          semsError: st.semsCache.error || null };  // diagnostic: why SEMS extras are blank
  } else if (extras.semsSoc != null) {
    g = { ok: true, source: 'sems', batterySOC: extras.semsSoc, online: true, ...extras };
  } else {
    g = { ok: false, error: 'no ESP SOC and SEMS unavailable' };
  }

  // Spa/AC: re-fetch only when the cache is stale; otherwise reuse last reading.
  const cacheAge = now - (st.cache.ts || 0);
  const haveCache = st.cache.mspa && st.cache.ac;
  const devicesFresh = !(haveCache && cacheAge < cfg.deviceReadMs);

  let m, a;
  if (devicesFresh) {
    [m, a] = await Promise.all([
      safe('mspa',    () => mspa.getState()),
      safe('toshiba', () => toshiba.getState()),
    ]);
    m = m.ok ? m : (st.cache.mspa || m);   // keep last good reading on failure
    a = a.ok ? a : (st.cache.ac || a);
    st.cache = { ts: now, mspa: m, ac: a };
  } else {
    m = st.cache.mspa;
    a = st.cache.ac;
  }
  const readings = { goodwe: g, mspa: m, ac: a, forecast: forecastData };

  // 2. Decide.
  const decisions = decide(readings, st, now, cfg.controlEnabled, devicesFresh);
  console.log('decisions:', JSON.stringify(decisions, null, 2));

  // 3. Act (only if enabled). Each command is best-effort.
  const actions = [];
  const run = async (label, fn) => {
    if (!cfg.controlEnabled) { actions.push(`[dry-run] ${label}`); return; }
    try { await fn(); actions.push(`[done] ${label}`); }
    catch (e) { actions.push(`[FAIL] ${label}: ${e.message}`); console.error(`[act] ${label}: ${e.message}`); }
  };

  if (decisions.mspaHeater && decisions.mspaHeater.action)
    await run(`MSpa heater → ${decisions.mspaHeater.action}`, () => mspa.setHeater(decisions.mspaHeater.action === 'on'));
  if (decisions.ac && decisions.ac.action)
    await run(`AC → ${decisions.ac.action}`, () => toshiba.setPower(decisions.ac.action === 'on'));

  const f = decisions.filtration || {};
  if (f.start) {
    await run('filtration filter ON', () => mspa.setFilter(true));
    if (f.start.uvc)   await run('filtration UVC ON',   () => mspa.setUvc(true));
    if (f.start.ozone) await run('filtration ozone ON', () => mspa.setOzone(true));
  }
  if (f.stopOzone) await run('filtration ozone OFF', () => mspa.setOzone(false));
  if (f.stop) {
    await run('filtration ozone OFF', () => mspa.setOzone(false));
    await run('filtration UVC OFF',   () => mspa.setUvc(false));
    await run('filtration filter OFF', () => mspa.setFilter(false));
  }

  // Turning the heater on implicitly starts the spa filter, so when the heater
  // auto-stops, stop the filter too — UNLESS a scheduled filtration cycle is
  // running, in which case keep filtering. (f.stop already handles its own off.)
  if (decisions.mspaHeater && decisions.mspaHeater.action === 'off' && !st.filtration.active && !f.stop)
    await run('heater stopped → filter OFF', () => mspa.setFilter(false));

  // 3b. Confirm: if we actually changed a device, re-read JUST that device so the
  //     dashboard reflects the new state immediately instead of lagging a full
  //     read interval. These commands fire only a few times a day, so the extra
  //     cloud reads are negligible. A short settle lets the cloud apply the change
  //     before we read it back (same reason settleMs guards manual detection).
  if (cfg.controlEnabled) {
    const mspaTouched = (decisions.mspaHeater && decisions.mspaHeater.action) || f.start || f.stop || f.stopOzone;
    const acTouched   = decisions.ac && decisions.ac.action;
    if (mspaTouched || acTouched) {
      await new Promise((r) => setTimeout(r, 5000)); // settle for cloud propagation
      if (mspaTouched) {
        const m2 = await safe('mspa', () => mspa.getState());
        if (m2.ok) { m = m2; st.cache = { ...st.cache, ts: now, mspa: m2 }; }
      }
      if (acTouched) {
        const a2 = await safe('toshiba', () => toshiba.getState());
        if (a2.ok) { a = a2; st.cache = { ...st.cache, ts: now, ac: a2 }; }
      }
    }
  }

  // 4. Persist + publish — but only when something worth recording changed, so a
  //    1-minute cadence doesn't commit ~1400 near-identical files/day. A fresh
  //    device read, any action, a SOC change, or a filtration event all qualify;
  //    a fresh read happens at least every deviceReadMs, bounding dashboard lag.
  const f2 = decisions.filtration || {};
  const socChanged = decisions.soc != null && decisions.soc !== st.lastSoc;
  if (decisions.soc != null) st.lastSoc = decisions.soc;
  const realAction = cfg.controlEnabled && (actions.length > 0 || f2.start || f2.stop || f2.stopOzone);
  const meaningful = devicesFresh || socChanged || semsFetched || forecastFetched || !!realAction;
  if (!meaningful) {
    console.log('no meaningful change since last run — skipping write');
    return;
  }

  // Append this run's REAL actions to the persisted history (newest first, last 10).
  if (cfg.controlEnabled && actions.length) {
    const ts = new Date().toISOString();
    for (const text of actions) st.history.unshift({ ts, soc: decisions.soc, text });
    st.history = st.history.slice(0, 10);
  }

  const status = {
    updatedAt: new Date().toISOString(),
    version: process.env.GIT_SHA || null,        // deployed commit (short SHA)
    deployedAt: process.env.GIT_TIME || null,    // that commit's timestamp
    controlEnabled: cfg.controlEnabled,
    localTime: decisions.time,
    solar: g,
    weather: forecastData,
    mspa: m,
    ac: a,
    devices: { fresh: devicesFresh, ageSec: Math.round((now - st.cache.ts) / 1000) },
    automation: {
      soc: decisions.soc,
      mspaHeater: decisions.mspaHeater,
      ac: decisions.ac,
      filtration: decisions.filtration,
      ownership: { mspa: st.mspa.ownedByAuto, ac: st.ac.ownedByAuto },
    },
    actions,
    history: st.history,
    rules: {
      socStart:    { mspa: cfg.soc.mspaStart, ac: cfg.soc.acStart },
      socStop:     { mspa: cfg.soc.mspaStop,  ac: cfg.soc.acStop, acWeekend: cfg.soc.acStopWeekend },
      mspaTempMargin: cfg.mspaTempMargin,
      acStopMarginC:  cfg.acStopMarginC,
      dayStartHour:   cfg.dayStartHour,
      nightOffHour:   cfg.nightOffHour,
      minOnMin:    Math.round(cfg.minOnMs / 60000),
      minOffMin:   Math.round(cfg.minOffMs / 60000),
      overrideHr:  Math.round(cfg.overrideMs / 3600000),
      acPriorityBlockC: cfg.acPriorityBlockC,
      acPriorityClearC: cfg.acPriorityClearC,
      acHotForecast: {
        thresholdC: cfg.acHotForecastC,
        from: `${String(cfg.acEarlyHour).padStart(2, '0')}:${String(cfg.acEarlyMin).padStart(2, '0')}`,
        todayMaxC: forecastData ? forecastData.maxTempC : null,
      },
      filtration: cfg.filtration.map((c) => ({
        key: c.key, hour: c.hour, minutes: c.minutes,
        ozone: c.ozone, weekdaysOnly: c.weekdaysOnly,
      })),
    },
  };

  await store.publish(state.serialize(st), JSON.stringify(status, null, 2) + '\n');
  console.log('actions:', actions);
  console.log(`published (${store.useGist ? 'gist' : 'local files'})`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
