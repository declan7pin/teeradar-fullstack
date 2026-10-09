
// TeeRadar booking-search load test — Node.js 18+
// Run locally/staging by default. Explicitly opt in before testing production.
// No external dependencies.

const BASE_URL = (process.env.LOAD_TEST_URL || 'http://localhost:3000').replace(/\/$/, '');
const IS_PRODUCTION = /(^|\.)teeradar\.com\.au$/i.test(new URL(BASE_URL).hostname);
if (IS_PRODUCTION && process.env.ALLOW_PRODUCTION_LOAD_TEST !== 'yes') {
  console.error('Production test blocked. Set ALLOW_PRODUCTION_LOAD_TEST=yes only after confirming a quiet test window.');
  process.exit(1);
}

const TOKEN = process.env.LOAD_TEST_TOKEN;
if (!TOKEN) {
  console.error('Set LOAD_TEST_TOKEN to a valid TeeRadar JWT for a test account.');
  process.exit(1);
}

const USERS = Math.min(20, Math.max(1, Number(process.env.LOAD_TEST_USERS || 20)));
const TIMEOUT_MS = Math.max(1000, Number(process.env.LOAD_TEST_TIMEOUT_MS || 60000));
const DATE = process.env.LOAD_TEST_DATE || nextSaturday();
const SEARCH = {
  date: DATE,
  earliest: process.env.LOAD_TEST_EARLIEST || '07:00',
  latest: process.env.LOAD_TEST_LATEST || '11:00',
  holes: process.env.LOAD_TEST_HOLES || '18',
  partySize: Number(process.env.LOAD_TEST_PARTY_SIZE || 2),
  state: process.env.LOAD_TEST_STATE || 'WA',
};

function nextSaturday() {
  const date = new Date();
  date.setDate(date.getDate() + ((6 - date.getDay() + 7) % 7 || 7));
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

async function probe(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const start = performance.now();
  try {
    const res = await fetch(BASE_URL + path, { signal: controller.signal });
    const body = await res.text();
    return { path, status: res.status, ms: Math.round(performance.now() - start), body: body.slice(0, 400) };
  } catch (err) {
    return { path, error: err.message, ms: Math.round(performance.now() - start) };
  } finally { clearTimeout(timer); }
}

async function simulateUser(index) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();
  try {
    const response = await fetch(BASE_URL + '/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(SEARCH),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { /* report non-JSON response */ }
    return {
      user: index + 1,
      status: response.status,
      ms: Math.round(performance.now() - start),
      ok: response.ok && payload !== undefined,
      error: response.ok ? (payload === undefined ? 'Non-JSON response' : null) : raw.slice(0, 160),
    };
  } catch (err) {
    return { user: index + 1, status: '-', ms: Math.round(performance.now() - start), ok: false, error: err.name === 'AbortError' ? 'Timed out' : err.message };
  } finally { clearTimeout(timer); }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}

async function main() {
  console.log('TeeRadar load test');
  console.log({ url: BASE_URL, users: USERS, timeoutMs: TIMEOUT_MS, criteria: SEARCH });
  console.log('Before:', await probe('/health'), await probe('/health/db'));
  console.log(`Starting ${USERS} simultaneous authenticated searches...`);
  const start = performance.now();
  const results = await Promise.all(Array.from({ length: USERS }, (_, i) => simulateUser(i)));
  console.table(results);
  const successful = results.filter(r => r.ok);
  console.log('Summary:', {
    users: USERS,
    success: successful.length,
    failed: USERS - successful.length,
    totalWallTimeMs: Math.round(performance.now() - start),
    medianResponseMs: percentile(results.map(r => r.ms), 50),
    p95ResponseMs: percentile(results.map(r => r.ms), 95),
    slowestResponseMs: Math.max(...results.map(r => r.ms)),
  });
  console.log('After:', await probe('/health'), await probe('/health/db'));
  if (successful.length !== USERS) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exitCode = 1; });
