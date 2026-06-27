'use strict';
// MSpa cloud API (read state + send commands). Ported from the proven Electron
// module; credentials now come from config (env / GitHub Secrets).
const axios = require('axios');
const crypto = require('crypto');
const { mspa } = require('./config');

let token = null;

function sign(nonce, ts) {
  return crypto.createHash('md5')
    .update(`${mspa.appId},${mspa.appSecret},${nonce},${ts}`)
    .digest('hex').toUpperCase();
}

function makeHeaders(withToken = true) {
  const ts    = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const h = {
    appid: mspa.appId, ts, nonce, sign: sign(nonce, ts),
    lan_code: 'en', 'User-Agent': 'okhttp/4.9.0', 'Content-Type': 'application/json',
  };
  if (withToken && token) h.Authorization = `token ${token}`;
  return h;
}

async function login() {
  const res = await axios.post(`${mspa.base}/api/enduser/get_token/`,
    { account: mspa.account, password: mspa.passMd5, registration_id: '', country: 'EN', app_id: mspa.appId, push_type: 'android' },
    { headers: makeHeaders(false) });
  if (res.data.code !== 0) throw new Error(res.data.message || 'MSpa login failed');
  token = res.data.data.token;
}

async function post(path, body) {
  if (!token) await login();
  const run = () => axios.post(`${mspa.base}${path}`, body, { headers: makeHeaders() });
  let res = await run();
  if (res.data.code === 403) { token = null; await login(); res = await run(); }
  if (res.data.code !== 0) throw new Error(res.data.message || `MSpa API error ${res.data.code}`);
  return res.data.data;
}

async function getState() {
  const d = await post('/api/device/thing_shadow/', { device_id: mspa.deviceId, product_id: mspa.productId });
  return {
    waterTempC:  d.water_temperature / 2,
    targetTempC: d.temperature_setting / 2,
    filter:  d.filter_state  === 1,
    heater:  d.heater_state  === 1,
    ozone:   d.ozone_state   === 1,
    uvc:     d.uvc_state     === 1,
    bubble:  d.bubble_state  === 1,
    online:  !!d.is_online,
  };
}

async function set(field, on) {
  return post('/api/device/command/', {
    desired: { state: { desired: { [field]: on ? 1 : 0 } } },
    device_id: mspa.deviceId, product_id: mspa.productId,
  });
}

const setHeater = (on) => set('heater_state', on);
const setFilter = (on) => set('filter_state', on);
const setOzone  = (on) => set('ozone_state',  on);
const setUvc    = (on) => set('uvc_state',    on);

async function setTemperature(celsius) {
  return post('/api/device/command/', {
    desired: { state: { desired: { temperature_setting: Math.round(celsius * 2) } } },
    device_id: mspa.deviceId, product_id: mspa.productId,
  });
}

module.exports = { getState, set, setHeater, setFilter, setOzone, setUvc, setTemperature };
