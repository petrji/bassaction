'use strict';
// The decision engine. Pure logic: given readings + persisted state + the clock,
// it returns a list of intended actions and mutates state. The caller decides
// whether to actually send the commands (config.controlEnabled).
const cfg = require('./config');

// Prague-local time parts (the cron fires in UTC; we localise here).
function pragueNow(now = new Date()) {
  const local = new Date(now.toLocaleString('en-US', { timeZone: cfg.tz }));
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, '0');
  const d = String(local.getDate()).padStart(2, '0');
  return {
    hour: local.getHours(),
    minute: local.getMinutes(),
    weekday: local.getDay(),           // 0=Sun .. 6=Sat
    dateKey: `${y}-${m}-${d}`,
    isWeekday: local.getDay() >= 1 && local.getDay() <= 5,
  };
}

// Evaluate one solar-driven device (MSpa heater or AC). Returns an action string
// or null. Passive observations (manual-change detection, override timers, state
// sync) are always recorded; the *active* state transition for a start/stop is
// only committed when `actuate` is true — i.e. when a command is really sent. In
// read-only mode (actuate=false) we report what we WOULD do without pretending we
// did it, so state never drifts from reality.
// `fresh` = the device reading is a real fetch this run (not the cached value).
// Manual-change detection and lastKnownOn sync only make sense against a fresh
// reading; on cached runs we act on our own believed state (dev.lastKnownOn) so
// SOC-driven start/stop still works every minute without false override trips.
function evaluateDevice({ name, dev, actualOn, soc, socStart, socStop, canStart, reachedTarget, now, t, actuate, fresh, ignoreSoc = false }) {
  const commit = (on) => {
    dev.lastKnownOn = on; dev.ownedByAuto = on; dev.lastChangeTs = now; dev.lastCmdTs = now;
  };
  const effOn = fresh ? actualOn : dev.lastKnownOn;

  // 1. Detect a manual change (fresh reads only): device differs from what we
  //    last set, past the settle window (so it isn't our own pending command).
  if (fresh && actualOn !== dev.lastKnownOn && now > dev.lastCmdTs + cfg.settleMs) {
    dev.overrideUntil = now + cfg.overrideMs;
    dev.ownedByAuto = false;        // a human is in control now — relinquish
    dev.lastKnownOn = actualOn;
    dev.lastChangeTs = now;
    return { action: null, note: `manual change detected → backing off until ${new Date(dev.overrideUntil).toISOString()}` };
  }

  // 2. Honour an active manual override.
  if (now < dev.overrideUntil) {
    if (fresh) dev.lastKnownOn = actualOn;
    return { action: null, note: `override active (${Math.round((dev.overrideUntil - now) / 60000)} min left)` };
  }

  // 3. Night force-off: only ever stops what automation itself started.
  if (t.hour >= cfg.nightOffHour && effOn && dev.ownedByAuto) {
    if (now >= dev.lastChangeTs + cfg.minOnMs) {
      if (actuate) commit(false);
      return { action: 'off', note: 'night force-off' };
    }
  }

  // Comfort target reached → stop now, regardless of SOC (auto-owned only).
  if (effOn && dev.ownedByAuto && reachedTarget()) {
    if (now < dev.lastChangeTs + cfg.minOnMs) return { action: null, note: 'target reached — waiting min-on' };
    if (actuate) commit(false);
    return { action: 'off', note: 'target reached → stop' };
  }

  // Start window: from dayStartHour until noStartAfterHour (never START after that;
  // a running device keeps running — night force-off at nightOffHour still applies).
  const inStartWindow = t.hour >= cfg.dayStartHour && t.hour < cfg.noStartAfterHour;
  // ignoreSoc (hot-day pre-cool / hot indoor): run on the thermostat alone, no SOC gate.
  const socOkToStart = ignoreSoc || soc >= socStart;
  const wantOn  = inStartWindow && socOkToStart && canStart().ok;
  const wantOff = !ignoreSoc && soc <= socStop;

  // 4. Turn ON (in the start window, SOC ok or hot-override, device-specific ok).
  if (!effOn && wantOn) {
    if (now < dev.lastChangeTs + cfg.minOffMs) return { action: null, note: 'min-off not elapsed' };
    if (actuate) commit(true);
    const note = (ignoreSoc && soc < socStart)
      ? `start (hot override — SOC ${soc}% ignored)`
      : `start (SOC ${soc}% ≥ ${socStart}%)`;
    return { action: 'on', note };
  }
  if (!effOn && inStartWindow && socOkToStart && !canStart().ok) {
    return { action: null, note: `start blocked: ${canStart().reason}` };
  }

  // 5. Turn OFF — but NEVER stop a device a human started (only auto-owned).
  if (effOn && wantOff) {
    if (!dev.ownedByAuto) return { action: null, note: 'on, but user-owned — will not auto-stop' };
    if (now < dev.lastChangeTs + cfg.minOnMs) return { action: null, note: 'min-on not elapsed' };
    if (actuate) commit(false);
    return { action: 'off', note: `stop (SOC ${soc}% ≤ ${socStop}%)` };
  }

  // 6. Inside the hysteresis band — hold.
  if (fresh) dev.lastKnownOn = actualOn;
  return { action: null, note: fresh ? 'hold' : 'hold (cached)' };
}

// Build the per-device "may I start?" predicates from current readings.
function makePredicates(readings) {
  const { mspa, ac } = readings;

  const mspaCanStart = () => {
    if (!mspa || !mspa.ok) return { ok: false, reason: 'MSpa unreachable' };
    if (!mspa.online) return { ok: false, reason: 'MSpa offline' };
    if (mspa.waterTempC >= mspa.targetTempC - cfg.mspaTempMargin)
      return { ok: false, reason: `water ${mspa.waterTempC}°C already near target ${mspa.targetTempC}°C` };
    // Load priority: if the room is much hotter than the AC target, cooling wins.
    if (ac && ac.ok && ac.on && ac.mode === 'cool' && ac.indoorTemp != null &&
        ac.indoorTemp > ac.targetTemp + cfg.acPriorityBlockC)
      return { ok: false, reason: `AC priority: room ${ac.indoorTemp}°C ≫ target ${ac.targetTemp}°C` };
    return { ok: true };
  };

  const acCanStart = () => {
    if (!ac || !ac.ok) return { ok: false, reason: 'AC unreachable' };
    if (ac.indoorTemp == null) return { ok: false, reason: 'no indoor temp' };
    // Mode-aware useful-work check.
    if (ac.mode === 'cool' && ac.indoorTemp <= ac.targetTemp)
      return { ok: false, reason: `cool: room ${ac.indoorTemp}°C ≤ target ${ac.targetTemp}°C` };
    if (ac.mode === 'heat' && ac.indoorTemp >= ac.targetTemp)
      return { ok: false, reason: `heat: room ${ac.indoorTemp}°C ≥ target ${ac.targetTemp}°C` };
    return { ok: true };
  };

  // Comfort target reached → stop the device even if SOC is still high.
  const mspaReachedTarget = () => {
    if (!mspa || !mspa.ok) return false;
    return mspa.waterTempC >= mspa.targetTempC;          // spa: stop at/above target
  };

  const acReachedTarget = () => {
    if (!ac || !ac.ok || ac.indoorTemp == null) return false;
    const m = cfg.acStopMarginC;
    if (ac.mode === 'cool' || ac.mode === 'dry') return ac.indoorTemp <= ac.targetTemp - m;
    if (ac.mode === 'heat') return ac.indoorTemp >= ac.targetTemp + m;
    if (ac.mode === 'auto') {                            // infer direction from current temp
      if (ac.indoorTemp > ac.targetTemp) return ac.indoorTemp <= ac.targetTemp - m;
      if (ac.indoorTemp < ac.targetTemp) return ac.indoorTemp >= ac.targetTemp + m;
      return true;                                       // exactly at target
    }
    return false;                                        // fan: no temperature goal
  };

  return { mspaCanStart, acCanStart, mspaReachedTarget, acReachedTarget };
}

// Decide filtration. Returns { start?: {ozone,uvc}, stopOzone?, stop?, note }.
function evaluateFiltration({ fstate, mspa, t, now, actuate, fresh }) {
  const f = fstate;

  // On cached runs, only the time-based "end of cycle" needs handling; starting
  // a cycle and the bubbles-abort safety both need a fresh spa reading.
  if (!fresh) {
    if (f.active && now >= f.active.until) {
      const key = f.active.key; if (actuate) f.active = null;
      return { stop: true, note: `filtration ${key} complete` };
    }
    return { note: f.active ? `filtration ${f.active.key} running` : 'filtration: cached, waiting for fresh read' };
  }

  // If a cycle is running and bubbles came on, abort ozone immediately.
  if (f.active && f.active.ozone && mspa && mspa.ok && mspa.bubble) {
    if (actuate) f.active.ozone = false;
    return { stopOzone: true, note: 'bubbles on → abort ozone' };
  }

  // End an active cycle.
  if (f.active && now >= f.active.until) {
    const key = f.active.key; if (actuate) f.active = null;
    return { stop: true, note: `filtration ${key} complete` };
  }
  if (f.active) return { note: `filtration ${f.active.key} running` };

  // Look for a cycle due now that hasn't fired today.
  for (const c of cfg.filtration) {
    if (c.weekdaysOnly && !t.isWeekday) continue;
    if (f.firedDay[c.key] === t.dateKey) continue;
    if (t.hour < c.hour) continue; // not yet time today
    // Don't start while bubbles are on.
    if (mspa && mspa.ok && mspa.bubble) return { note: `filtration ${c.key} due but bubbles on` };
    if (!mspa || !mspa.ok || !mspa.online) return { note: `filtration ${c.key} due but spa offline` };
    if (actuate) {
      f.firedDay[c.key] = t.dateKey;
      f.active = { key: c.key, until: now + c.minutes * 60000, ozone: c.ozone };
    }
    return { start: { ozone: c.ozone, uvc: true }, note: `filtration ${c.key} start (${c.minutes} min, ozone=${c.ozone})` };
  }
  return { note: 'no filtration due' };
}

function decide(readings, state, now = Date.now(), actuate = cfg.controlEnabled, fresh = true) {
  const t = pragueNow(new Date(now));
  const { mspaCanStart, acCanStart, mspaReachedTarget, acReachedTarget } = makePredicates(readings);
  const soc = readings.goodwe && readings.goodwe.ok ? readings.goodwe.batterySOC : null;

  const decisions = { time: t, soc, devicesFresh: fresh, mspaHeater: null, ac: null, filtration: null };

  if (soc != null) {
    if (readings.mspa && readings.mspa.ok) {
      decisions.mspaHeater = evaluateDevice({
        name: 'mspaHeater', dev: state.mspa, actualOn: readings.mspa.heater,
        soc, socStart: cfg.soc.mspaStart, socStop: cfg.soc.mspaStop,
        canStart: mspaCanStart, reachedTarget: mspaReachedTarget, now, t, actuate, fresh,
      });
    }
    // AC control has moved to the ESP (local actuation over MQTT). The cloud no
    // longer decides or commands the AC — it only reads its state for the
    // dashboard. Relinquish any ownership the cloud still held so it can't claim
    // the AC, and surface an informational note instead of a decision.
    if (state.ac) state.ac.ownedByAuto = false;
    decisions.ac = { action: null, note: 'AC control moved to ESP (local)' };
  } else {
    decisions.note = 'no SOC reading — solar automation skipped this run';
  }

  decisions.filtration = evaluateFiltration({ fstate: state.filtration, mspa: readings.mspa, t, now, actuate, fresh });
  return decisions;
}

module.exports = { decide, pragueNow };
