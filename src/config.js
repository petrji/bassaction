'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// All credentials and tunables. Every secret comes from an environment variable
// (GitHub Secrets in CI, a local .env for development). NOTHING sensitive is
// hard-coded here, so this file is safe to publish in a public repo.
// ─────────────────────────────────────────────────────────────────────────────
const env = (k, d) => (process.env[k] != null && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => Number(env(k, d));

// Required secret: read from env or fail loudly (collected so one run lists all).
const _missing = [];
const req = (k) => {
  const v = process.env[k];
  if (v == null || v === '') { _missing.push(k); return ''; }
  return v;
};

module.exports = {
  // ── GoodWe / SEMS cloud — OPTIONAL fallback only. ──
  // Primary SOC now arrives from the ESP via repository_dispatch (SOC_OVERRIDE).
  // SEMS is used only when no ESP value is present; missing creds just disable it.
  goodwe: {
    account:   env('SEMS_ACCOUNT'),
    password:  env('SEMS_PASSWORD'),
    stationId: env('SEMS_STATION_ID'),
    enabled:   !!(env('SEMS_ACCOUNT') && env('SEMS_PASSWORD') && env('SEMS_STATION_ID')),
  },

  // ── MSpa cloud ──
  mspa: {
    base:      'https://api.iot.the-mspa.com',
    appId:     req('MSPA_APP_ID'),
    appSecret: req('MSPA_APP_SECRET'),
    account:   req('MSPA_ACCOUNT'),
    passMd5:   req('MSPA_PASS_MD5'),
    deviceId:  req('MSPA_DEVICE_ID'),
    productId: req('MSPA_PRODUCT_ID'),
  },

  // ── Toshiba Home AC Control (cloud + Azure IoT Hub MQTT) ──
  toshiba: {
    base:        'https://mobileapi.toshibahomeaccontrols.com',
    iotHost:     'toshibasmaciothubprod.azure-devices.net',
    user:        req('TOSHIBA_USER'),
    password:    req('TOSHIBA_PASS'),
    clientId:    req('TOSHIBA_CLIENT_ID'),
    acUniqueId:  req('TOSHIBA_AC_UNIQUE_ID'),
  },

  // ── Automation tunables (mirrors the ESP firmware) ──
  tz: 'Europe/Prague',

  // When false, the run only reads + writes status.json (no commands sent).
  // Start here, watch the dashboard, then flip CONTROL_ENABLED=true.
  controlEnabled: env('CONTROL_ENABLED', 'false') === 'true',

  // Spa/AC state is re-fetched at most this often; runs in between reuse the
  // cached reading (so we can act on fresh SOC every minute without hammering
  // the device clouds). SOC itself always comes fresh from the ESP push.
  deviceReadMs: num('READ_INTERVAL_MIN', 5) * 60 * 1000,

  soc: {
    mspaStart: num('MSPA_SOC_START', 70),
    mspaStop:  num('MSPA_SOC_STOP',  60),
    acStart:   num('AC_SOC_START',   50),
    acStop:    num('AC_SOC_STOP',    40),
  },

  // Anti-short-cycle and override windows, in milliseconds.
  minOnMs:    10 * 60 * 1000,   // once ON, stay on >= 10 min
  minOffMs:    5 * 60 * 1000,   // once OFF, stay off >= 5 min
  settleMs:   90 * 1000,        // ignore state mismatch this long after a command (cloud lag)
  overrideMs:  2 * 60 * 60 * 1000, // human touched it -> back off 2 h, then re-arm

  acPriorityBlockC: 5.0,  // room this far above AC target -> block MSpa heater
  acPriorityClearC: 2.0,  // ...until back within this of target (hysteresis)

  dayStartHour:  7,   // earliest auto-start (Prague local hour)
  nightOffHour: 22,   // 10 PM — force auto-started devices off
  mspaTempMargin: 0.5, // only start heater if water is at least this far below target

  // Scheduled MSpa filtration (independent of solar). Each cycle fires once per
  // qualifying day when the run lands on/after its hour and it hasn't run yet.
  filtration: [
    { key: 'c1', hour: 23, minutes: 120, ozone: true,  weekdaysOnly: false }, // 11 PM full
    { key: 'c2', hour: 6,  minutes: 120, ozone: true,  weekdaysOnly: false }, // 6 AM full
    { key: 'c3', hour: 13, minutes: 90,  ozone: false, weekdaysOnly: true  }, // 1 PM filter+UVC, weekdays
  ],
};

// Fail fast with a clear list if any secret is missing (CI Secrets / local .env).
if (_missing.length) {
  throw new Error(
    'Missing required environment variables: ' + _missing.join(', ') +
    '\nSet them as GitHub Actions Secrets, or create a local .env (see .env.example).'
  );
}
