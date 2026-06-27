'use strict';
// State shape + (de)serialization. The actual read/write is in store.js (Gist in
// CI, local file in dev), so this module is pure — no I/O.

const defaultDevice = () => ({
  ownedByAuto: false, // true only while WE hold the device on
  lastKnownOn: false, // last on/off state we set or observed
  lastChangeTs: 0,    // when the on/off state last changed (min-on/off timer)
  lastCmdTs: 0,       // when we last issued a command (settle window)
  overrideUntil: 0,   // automation suppressed until this epoch ms (manual override)
});

function defaults() {
  return {
    mspa: defaultDevice(),
    ac: defaultDevice(),
    filtration: {
      firedDay: { c1: '', c2: '', c3: '' }, // 'YYYY-MM-DD' last fired, per cycle
      active: null,                          // { key, until, ozone } while a cycle runs
    },
    cache: { ts: 0, mspa: null, ac: null },  // throttled spa/AC readings (see index.js)
    lastSoc: null,                            // last SOC we persisted (commit-on-change gate)
    history: [],                              // last N real actions: { ts, soc, text }
    updatedAt: 0,
  };
}

// Merge a raw JSON string (or null) onto the defaults.
function parse(raw) {
  if (!raw) return defaults();
  let o;
  try { o = JSON.parse(raw); } catch { return defaults(); }
  return { ...defaults(), ...o,
    mspa: { ...defaultDevice(), ...(o.mspa || {}) },
    ac:   { ...defaultDevice(), ...(o.ac || {}) },
    filtration: { ...defaults().filtration, ...(o.filtration || {}) },
    cache: { ...defaults().cache, ...(o.cache || {}) },
    history: Array.isArray(o.history) ? o.history : [],
  };
}

function serialize(state) {
  state.updatedAt = Date.now();
  return JSON.stringify(state, null, 2) + '\n';
}

module.exports = { defaults, parse, serialize };
