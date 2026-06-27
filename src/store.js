'use strict';
// Persistence layer. In CI we keep state + the dashboard feed in a single GitHub
// Gist (two files: state.json, status.json) — updated via the API, so the repo
// gets ZERO per-run commits. For local dev (no GIST env) we fall back to files.
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const GIST_ID    = process.env.GIST_ID;
const GIST_TOKEN = process.env.GIST_TOKEN;
const useGist    = !!(GIST_ID && GIST_TOKEN);

const LOCAL_STATE  = path.join(__dirname, '..', 'state.json');
const LOCAL_STATUS = path.join(__dirname, '..', 'docs', 'status.json');

const ghHeaders = () => ({
  Authorization: `Bearer ${GIST_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'bassaction',
  'X-GitHub-Api-Version': '2022-11-28',
});

// Return the raw state.json string (or null if none yet).
async function loadStateRaw() {
  if (useGist) {
    const res = await axios.get(`https://api.github.com/gists/${GIST_ID}`, { headers: ghHeaders() });
    const f = res.data.files && res.data.files['state.json'];
    return f && f.content ? f.content : null;
  }
  try { return fs.readFileSync(LOCAL_STATE, 'utf8'); } catch { return null; }
}

// Persist state + publish the dashboard status in one shot.
async function publish(stateStr, statusStr) {
  if (useGist) {
    await axios.patch(`https://api.github.com/gists/${GIST_ID}`,
      { files: { 'state.json': { content: stateStr }, 'status.json': { content: statusStr } } },
      { headers: ghHeaders() });
    return;
  }
  fs.writeFileSync(LOCAL_STATE, stateStr);
  fs.mkdirSync(path.dirname(LOCAL_STATUS), { recursive: true });
  fs.writeFileSync(LOCAL_STATUS, statusStr);
}

module.exports = { loadStateRaw, publish, useGist };
