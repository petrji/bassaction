'use strict';
try { require('dotenv').config(); } catch { /* dotenv optional; CI uses real env */ }
// Entry point for one scheduled run:
//   1. read all three services (resilient — one failure doesn't sink the rest)
//   2. run the automation engine
//   3. optionally send commands (config.controlEnabled)
//   4. write docs/status.json (dashboard) and state.json (persisted), then exit
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const state = require('./state');
const { decide } = require('./automation');
const goodwe = require('./goodwe');
const mspa = require('./mspa');
const toshiba = require('./toshiba');

const STATUS_FILE = path.join(__dirname, '..', 'docs', 'status.json');

async function safe(label, fn) {
  try { return { ok: true, ...(await fn()) }; }
  catch (e) { console.error(`[${label}] ${e.message}`); return { ok: false, error: e.message }; }
}

async function main() {
  console.log(`BassAction run @ ${new Date().toISOString()}  control=${cfg.controlEnabled}`);

  // 1. Read everything in parallel.
  const [g, m, a] = await Promise.all([
    safe('goodwe',  () => goodwe.getStatus()),
    safe('mspa',    () => mspa.getState()),
    safe('toshiba', () => toshiba.getState()),
  ]);
  const readings = { goodwe: g, mspa: m, ac: a };

  // 2. Decide.
  const st = state.load();
  const decisions = decide(readings, st);
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

  // 4. Persist + publish.
  state.save(st);

  const status = {
    updatedAt: new Date().toISOString(),
    controlEnabled: cfg.controlEnabled,
    localTime: decisions.time,
    solar: g,
    mspa: m,
    ac: a,
    automation: {
      soc: decisions.soc,
      mspaHeater: decisions.mspaHeater,
      ac: decisions.ac,
      filtration: decisions.filtration,
      ownership: { mspa: st.mspa.ownedByAuto, ac: st.ac.ownedByAuto },
    },
    actions,
  };
  fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + '\n');
  console.log('actions:', actions);
  console.log('status written →', STATUS_FILE);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
