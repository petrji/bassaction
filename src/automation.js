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
function evaluateDevice({ name, dev, actualOn, soc, socStart, socStop, canStart, now, t, actuate }) {
  // Record the effect of an actually-issued command.
  const commit = (on) => {
    dev.lastKnownOn = on; dev.ownedByAuto = on; dev.lastChangeTs = now; dev.lastCmdTs = now;
  };

  // 1. Detect a manual change: device state differs from what we last set, and
  //    we're past the settle window (so it isn't just our own pending command).
  if (actualOn !== dev.lastKnownOn && now > dev.lastCmdTs + cfg.settleMs) {
    dev.overrideUntil = now + cfg.overrideMs;
    dev.ownedByAuto = false;        // a human is in control now — relinquish
    dev.lastKnownOn = actualOn;
    dev.lastChangeTs = now;
    return { action: null, note: `manual change detected → backing off until ${new Date(dev.overrideUntil).toISOString()}` };
  }

  // 2. Honour an active manual override.
  if (now < dev.overrideUntil) {
    dev.lastKnownOn = actualOn;
    return { action: null, note: `override active (${Math.round((dev.overrideUntil - now) / 60000)} min left)` };
  }

  // 3. Night force-off: only ever stops what automation itself started.
  if (t.hour >= cfg.nightOffHour && actualOn && dev.ownedByAuto) {
    if (now >= dev.lastChangeTs + cfg.minOnMs) {
      if (actuate) commit(false);
      return { action: 'off', note: 'night force-off' };
    }
  }

  const inDayWindow = t.hour >= cfg.dayStartHour && t.hour < cfg.nightOffHour;
  const wantOn  = inDayWindow && soc >= socStart && canStart().ok;
  const wantOff = soc <= socStop;

  // 4. Turn ON (only in the day window, above start SOC, device-specific ok).
  if (!actualOn && wantOn) {
    if (now < dev.lastChangeTs + cfg.minOffMs) return { action: null, note: 'min-off not elapsed' };
    if (actuate) commit(true);
    return { action: 'on', note: `start (SOC ${soc}% ≥ ${socStart}%)` };
  }
  if (!actualOn && inDayWindow && soc >= socStart && !canStart().ok) {
    return { action: null, note: `start blocked: ${canStart().reason}` };
  }

  // 5. Turn OFF — but NEVER stop a device a human started (only auto-owned).
  if (actualOn && wantOff) {
    if (!dev.ownedByAuto) return { action: null, note: 'on, but user-owned — will not auto-stop' };
    if (now < dev.lastChangeTs + cfg.minOnMs) return { action: null, note: 'min-on not elapsed' };
    if (actuate) commit(false);
    return { action: 'off', note: `stop (SOC ${soc}% ≤ ${socStop}%)` };
  }

  // 6. Inside the hysteresis band — hold.
  dev.lastKnownOn = actualOn;
  return { action: null, note: 'hold' };
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

  return { mspaCanStart, acCanStart };
}

// Decide filtration. Returns { start?: {ozone,uvc}, stopOzone?, stop?, note }.
function evaluateFiltration({ fstate, mspa, t, now, actuate }) {
  const f = fstate;

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

function decide(readings, state, now = Date.now(), actuate = cfg.controlEnabled) {
  const t = pragueNow(new Date(now));
  const { mspaCanStart, acCanStart } = makePredicates(readings);
  const soc = readings.goodwe && readings.goodwe.ok ? readings.goodwe.batterySOC : null;

  const decisions = { time: t, soc, mspaHeater: null, ac: null, filtration: null };

  if (soc != null) {
    if (readings.mspa && readings.mspa.ok) {
      decisions.mspaHeater = evaluateDevice({
        name: 'mspaHeater', dev: state.mspa, actualOn: readings.mspa.heater,
        soc, socStart: cfg.soc.mspaStart, socStop: cfg.soc.mspaStop, canStart: mspaCanStart, now, t, actuate,
      });
    }
    if (readings.ac && readings.ac.ok) {
      decisions.ac = evaluateDevice({
        name: 'ac', dev: state.ac, actualOn: readings.ac.on,
        soc, socStart: cfg.soc.acStart, socStop: cfg.soc.acStop, canStart: acCanStart, now, t, actuate,
      });
    }
  } else {
    decisions.note = 'no SOC reading — solar automation skipped this run';
  }

  decisions.filtration = evaluateFiltration({ fstate: state.filtration, mspa: readings.mspa, t, now, actuate });
  return decisions;
}

module.exports = { decide, pragueNow };
