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

async function safe(label, fn) {
  try { return { ok: true, ...(await fn()) }; }
  catch (e) { console.error(`[${label}] ${e.message}`); return { ok: false, error: e.message }; }
}

async function main() {
  console.log(`BassAction run @ ${new Date().toISOString()}  control=${cfg.controlEnabled}`);

  // 1. Read everything. SOC comes from the ESP (repository_dispatch payload) when
  //    present; otherwise fall back to the SEMS cloud if it's configured.
  const socOverride = process.env.SOC_OVERRIDE;
  const haveEspSoc = socOverride != null && socOverride !== '' && !Number.isNaN(Number(socOverride));

  const readSolar = async () => {
    if (haveEspSoc) {
      return { ok: true, source: 'esp-local', batterySOC: Number(socOverride), online: true,
               pvPower: null, batteryPower: null, charging: null, loadPower: null, gridPower: null };
    }
    if (cfg.goodwe.enabled) return safe('goodwe', async () => ({ source: 'sems', ...(await goodwe.getStatus()) }));
    return { ok: false, error: 'no ESP SOC and SEMS not configured' };
  };

  const st = state.parse(await store.loadStateRaw());
  const now = Date.now();

  // Spa/AC: re-fetch only when the cache is stale; otherwise reuse last reading.
  const cacheAge = now - (st.cache.ts || 0);
  const haveCache = st.cache.mspa && st.cache.ac;
  const devicesFresh = !(haveCache && cacheAge < cfg.deviceReadMs);

  let g, m, a;
  if (devicesFresh) {
    [g, m, a] = await Promise.all([
      readSolar(),
      safe('mspa',    () => mspa.getState()),
      safe('toshiba', () => toshiba.getState()),
    ]);
    // Keep the last *good* reading if a fetch failed this round.
    m = m.ok ? m : (st.cache.mspa || m);
    a = a.ok ? a : (st.cache.ac || a);
    st.cache = { ts: now, mspa: m, ac: a };
  } else {
    g = await readSolar();                 // SOC is always fresh (cheap / from ESP)
    m = st.cache.mspa;
    a = st.cache.ac;
  }
  const readings = { goodwe: g, mspa: m, ac: a };

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

  // 4. Persist + publish — but only when something worth recording changed, so a
  //    1-minute cadence doesn't commit ~1400 near-identical files/day. A fresh
  //    device read, any action, a SOC change, or a filtration event all qualify;
  //    a fresh read happens at least every deviceReadMs, bounding dashboard lag.
  const f2 = decisions.filtration || {};
  const socChanged = decisions.soc != null && decisions.soc !== st.lastSoc;
  if (decisions.soc != null) st.lastSoc = decisions.soc;
  const realAction = cfg.controlEnabled && (actions.length > 0 || f2.start || f2.stop || f2.stopOzone);
  const meaningful = devicesFresh || socChanged || !!realAction;
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
    controlEnabled: cfg.controlEnabled,
    localTime: decisions.time,
    solar: g,
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
  };

  await store.publish(state.serialize(st), JSON.stringify(status, null, 2) + '\n');
  console.log('actions:', actions);
  console.log(`published (${store.useGist ? 'gist' : 'local files'})`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
