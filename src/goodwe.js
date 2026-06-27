'use strict';
// GoodWe SOC + power flow via the SEMS portal cloud API.
// (GitHub's runners can't reach the inverter on your LAN, so we read the cloud.)
const axios = require('axios');
const { goodwe } = require('./config');

const LOGIN_URL   = 'https://www.semsportal.com/api/v1/Common/CrossLogin';
const BASE_URL    = 'https://www.semsportal.com';
const DETAIL_PATH = '/api/v2/PowerStation/GetMonitorDetailByPowerstationId';
const BASE_TOKEN  = JSON.stringify({ version: 'v2.1.0', client: 'web', language: 'en' });
const UA          = 'PVMaster/2.1.0 (iPhone; iOS 14.4.2; Scale/3.00)';

let tokenHeader = null; // full login `data` object, stringified — SEMS wants the whole thing

async function login() {
  const res = await axios.post(LOGIN_URL,
    { account: goodwe.account, pwd: goodwe.password, is_local: true },
    { headers: { 'Content-Type': 'application/json', Token: BASE_TOKEN, 'User-Agent': UA } });
  if (res.data.code !== 0) throw new Error(res.data.msg || 'SEMS login failed');
  tokenHeader = JSON.stringify(res.data.data);
}

async function apiPost(path, body) {
  if (!tokenHeader) await login();
  const run = () => axios.post(`${BASE_URL}${path}`, body, {
    headers: { 'Content-Type': 'application/json', Token: tokenHeader, 'User-Agent': UA },
  });
  let res = await run();
  if (String(res.data.code) === '100002') { // authorization expired -> re-login once
    tokenHeader = null;
    await login();
    res = await run();
  }
  if (String(res.data.code) !== '0') throw new Error(res.data.msg || `SEMS error ${res.data.code}`);
  return res.data.data;
}

// "3110.4(W)" -> 3110.4 ; "50.3V/-42.7A/-2148W" -> -2148 (last signed number before W)
const parseW = (s) => {
  if (s == null) return null;
  const m = String(s).match(/(-?\d+(?:\.\d+)?)\s*\(?W\)?\s*$/i);
  return m ? Number(m[1]) : null;
};

async function getStatus() {
  const d = await apiPost(DETAIL_PATH, { powerStationId: goodwe.stationId });
  const pf  = d.powerflow || {};
  const kpi = d.kpi || {};
  const inv = (d.inverter && d.inverter[0] && d.inverter[0].d) || {};

  const batW = parseW(inv.battery);            // negative = charging
  const charging = batW != null ? batW < 0 : null;

  return {
    batterySOC:   pf.soc != null ? Number(pf.soc) : null,        // %
    pvPower:      parseW(pf.pv),                                 // W
    batteryPower: batW != null ? Math.abs(batW) : parseW(pf.bettery),
    charging,                                                    // true=charging, false=discharging
    loadPower:    parseW(pf.load),                              // W house consumption
    gridPower:    parseW(pf.grid),                             // W
    energyToday:  kpi.power != null ? Number(kpi.power) : null, // kWh
    stationName:  (d.info && d.info.stationname) || null,
    online:       pf.hasEquipment === true,
  };
}

module.exports = { getStatus };
