'use strict';
// Toshiba Home AC Control: HTTP login + state read, MQTT (Azure IoT Hub) commands.
// Ported from the proven Electron module; credentials come from config.
const axios = require('axios');
const mqtt  = require('mqtt');
const { toshiba } = require('./config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let _token = null, _consumerId = null, _sasToken = null;

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

async function registerDevice() {
  if (!_token) await login();
  const res = await axios.post(`${toshiba.base}/api/Consumer/RegisterMobileDevice`,
    { DeviceID: toshiba.clientId, DeviceType: '1', Username: toshiba.user },
    { headers: authHeaders(), validateStatus: () => true });
  if (!res.data.IsSuccess) throw new Error(res.data.Message || 'Toshiba register failed');
  _sasToken = res.data.ResObj.SasToken;
  return _sasToken;
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

// Only the fields you change; everything else stays 0xFF (ignored).
function encodeCommand(fields) {
  const buf = Buffer.alloc(20, 0xff);
  if (fields.status !== undefined) buf[0] = fields.status;
  if (fields.mode   !== undefined) buf[1] = fields.mode;
  if (fields.temp   !== undefined) buf.writeInt8(fields.temp, 2);
  if (fields.fan    !== undefined) buf[3] = fields.fan;
  const hex = buf.toString('hex');
  return hex.slice(0, 12) + hex[13] + hex[15] + hex.slice(16); // Merit A/B nibble compression
}

function sendMqttCommand(hexCmd) {
  return new Promise(async (resolve, reject) => {
    try { if (!_sasToken) await registerDevice(); } catch (e) { return reject(e); }
    const cmd = {
      sourceId: toshiba.clientId, messageId: '0000000', targetId: [toshiba.acUniqueId],
      cmd: 'CMD_FCU_TO_AC', payload: { data: hexCmd }, timeStamp: '0000000',
    };
    const topic = `devices/${toshiba.clientId}/messages/events/type=mob&$.ct=application%2Fjson&$.ce=utf-8`;
    const client = mqtt.connect(`mqtts://${toshiba.iotHost}:8883`, {
      clientId: toshiba.clientId,
      username: `${toshiba.iotHost}/${toshiba.clientId}/?api-version=2021-04-12`,
      password: _sasToken, rejectUnauthorized: true, connectTimeout: 10000, reconnectPeriod: 0,
    });
    const done = (err) => { client.end(); err ? reject(err) : resolve(); };
    client.once('connect', () => client.publish(topic, JSON.stringify(cmd), { qos: 1 }, (err) => done(err)));
    client.once('error', (err) => done(err));
    setTimeout(() => done(new Error('MQTT timeout')), 12000);
  });
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

const setPower = (on) => sendMqttCommand(encodeCommand({ status: on ? 0x30 : 0x31 }));

module.exports = { getState, setPower };
