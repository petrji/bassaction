'use strict';
// Open-Meteo daily forecast (free, no API key). Returns today's max temperature
// for the configured location (Praha-Libuš by default), used to pre-cool the AC
// on hot days. One cheap HTTP GET; the caller caches it (see index.js).
const axios = require('axios');
const cfg = require('./config');

async function getDaily() {
  const { lat, lon } = cfg.forecast;
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lon}`
    + '&daily=temperature_2m_max'
    + `&timezone=${encodeURIComponent(cfg.tz)}&forecast_days=1`;
  const res = await axios.get(url, { timeout: 10000 });
  const arr = res.data && res.data.daily && res.data.daily.temperature_2m_max;
  const max = Array.isArray(arr) && arr.length ? Number(arr[0]) : null;
  return { maxTempC: Number.isFinite(max) ? max : null };
}

module.exports = { getDaily };
