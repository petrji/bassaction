'use strict';
// Open-Meteo daily forecast (free, no API key). Returns today's max temperature
// (used to pre-cool the AC on hot days) plus min / current / condition for the
// dashboard's Weather card. One cheap HTTP GET; the caller caches it (index.js).
const axios = require('axios');
const cfg = require('./config');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const first = (a) => (Array.isArray(a) && a.length ? a[0] : null);

async function getDaily() {
  const { lat, lon } = cfg.forecast;
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,weather_code'
    + '&daily=temperature_2m_max,temperature_2m_min,weather_code'
    + `&timezone=${encodeURIComponent(cfg.tz)}&forecast_days=1`;
  const res = await axios.get(url, { timeout: 10000 });
  const d = res.data || {};
  const daily = d.daily || {};
  const cur = d.current || {};
  return {
    maxTempC:     num(first(daily.temperature_2m_max)),
    minTempC:     num(first(daily.temperature_2m_min)),
    currentTempC: num(cur.temperature_2m),
    weatherCode:  num(cur.weather_code != null ? cur.weather_code : first(daily.weather_code)),
  };
}

module.exports = { getDaily };
