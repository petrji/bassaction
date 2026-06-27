'use strict';
// Persistent state between runs. GitHub Actions are stateless, so this file is
// committed back to the repo each run (see the workflow).
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'state.json');

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
    updatedAt: 0,
  };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { ...defaults(), ...raw,
      mspa: { ...defaultDevice(), ...(raw.mspa || {}) },
      ac:   { ...defaultDevice(), ...(raw.ac || {}) },
      filtration: { ...defaults().filtration, ...(raw.filtration || {}) },
    };
  } catch {
    return defaults();
  }
}

function save(state) {
  state.updatedAt = Date.now();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

module.exports = { load, save, STATE_FILE };
