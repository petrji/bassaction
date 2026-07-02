'use strict';
// Toshiba Home AC Control: HTTP login + state read ONLY.
//
// AC start/stop was moved to the ESP (hikvision-stream), which now owns the AC
// and sends commands locally over MQTT (Azure IoT Hub). The cloud deliberately
// no longer has any command path — it only reads the AC state for the dashboard,
// so this module exposes just getState().
const axios = require('axios');
const { toshiba } = require('./config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let _token = null, _consumerId = null;

async function login() {
  const res = await axios.post(`${toshiba.base}/api/Consumer/Login`,
    { Username: toshiba.user, Password: toshiba.password },
    { headers: { 'Content-Type': 'application/json', 'User-Agent': UA } });
  const obj = res.data.ResObj || res.data;
  if (!obj.access_token) throw new Error('Toshiba login failed');
  _token = obj.access_token;
  const jwt = JSON.parse(Buffer.from(_token.split('.')[1], 'base64').toString());
  _consumerId = jwt.ConsumerId;
}

function authHeaders() {
  return { Authorization: `Bearer ${_token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA };
}

const MODES = { 0x41: 'auto', 0x42: 'cool', 0x43: 'heat', 0x44: 'dry', 0x45: 'fan' };
const FANS  = { 0x41: 'auto', 0x31: 'quiet', 0x32: 'low', 0x33: 'med-low', 0x34: 'medium', 0x35: 'med-high', 0x36: 'high' };

function decodeState(hexState) {
  const ext = hexState.slice(0, 12) + '0' + hexState[12] + '0' + hexState.slice(13, 38);
  const b   = Buffer.from(ext, 'hex');
  const indoor  = b.readInt8(9);
  const outdoor = b.readInt8(10);
  return {
    on:          b[0] === 0x30,
    mode:        MODES[b[1]] || 'auto',
    targetTemp:  b.readInt8(2),
    fan:         FANS[b[3]] || 'auto',
    indoorTemp:  (indoor  > -50 && indoor  < 100) ? indoor  : null,
    outdoorTemp: (outdoor > -50 && outdoor < 100) ? outdoor : null,
  };
}

async function getState() {
  if (!_token) await login();
  const res = await axios.get(`${toshiba.base}/api/AC/GetConsumerACMapping`,
    { headers: authHeaders(), params: { consumerId: _consumerId }, validateStatus: () => true });
  if (!res.data.IsSuccess) throw new Error(res.data.Message || 'Toshiba mapping failed');
  const device = res.data.ResObj && res.data.ResObj[0] && res.data.ResObj[0].ACList && res.data.ResObj[0].ACList[0];
  if (!device) throw new Error('No AC device found');
  return decodeState(device.ACStateData);
}

module.exports = { getState };
