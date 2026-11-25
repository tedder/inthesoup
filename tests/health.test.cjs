const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./helpers/register-ts.cjs');
const { tempDir } = require('./helpers/fixtures.cjs');
const { getDuckDbHealth } = require('../src/lib/health.ts');
const approaches = require('../src/pages/api/approaches.ts').default;
const health = require('../src/pages/api/health.ts').default;

const NOW = Date.parse('2026-11-25T12:00:00Z');
const iso = (offsetMs) => new Date(NOW - offsetMs).toISOString();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function setup(files) {
  const dir = tempDir('inthesoup-health-');
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const weather = (age) => ({
  finished_at: iso(age),
  format: 'parquet',
  tables: { 'weather.metar': { rows: 2601, latest_source_time: iso(age) } },
});
const aero = (age) => ({
  finished_at: iso(age),
  format: 'parquet',
  cycle: '2610',
  tables: { 'aeronautical.airport': { rows: 13319 }, 'aeronautical.faf': { rows: 10172 } },
});

test('healthy when weather is under 3 hours and CIFP under 35 days old', () => {
  const dir = setup({ 'weather.status.json': weather(HOUR), 'aeronautical.status.json': aero(20 * DAY) });
  const { httpStatus, body } = getDuckDbHealth(dir, {}, NOW);
  assert.equal(httpStatus, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.weather.age_hours, 1);
  assert.equal(body.weather.rows['weather.metar'], 2601);
  assert.equal(body.aeronautical.age_days, 20);
  assert.equal(body.aeronautical.cycle, '2610');
  assert.equal(body.aeronautical.rows['aeronautical.faf'], 10172);
  assert.equal(body.weather.finished_at, iso(HOUR));
});

test('503 when weather data is stale', () => {
  const dir = setup({ 'weather.status.json': weather(4 * HOUR), 'aeronautical.status.json': aero(DAY) });
  const { httpStatus, body } = getDuckDbHealth(dir, {}, NOW);
  assert.equal(httpStatus, 503);
  assert.equal(body.status, 'stale');
  assert.match(body.reasons[0], /weather data is 4 hours old/);
});

test('503 when CIFP data is stale', () => {
  const dir = setup({ 'weather.status.json': weather(HOUR), 'aeronautical.status.json': aero(36 * DAY) });
  const { httpStatus, body } = getDuckDbHealth(dir, {}, NOW);
  assert.equal(httpStatus, 503);
  assert.equal(body.status, 'stale');
  assert.match(body.reasons[0], /aeronautical data is 36 days old/);
});

test('thresholds can be overridden by environment', () => {
  const dir = setup({ 'weather.status.json': weather(4 * HOUR), 'aeronautical.status.json': aero(36 * DAY) });
  const env = { MAX_WEATHER_AGE_HOURS: '6', MAX_CIFP_AGE_DAYS: '40' };
  assert.equal(getDuckDbHealth(dir, env, NOW).httpStatus, 200);
  assert.equal(getDuckDbHealth(dir, { MAX_WEATHER_AGE_HOURS: '1' }, NOW).httpStatus, 503);
});

test('missing status files report loading', () => {
  const empty = setup({});
  const { httpStatus, body } = getDuckDbHealth(empty, {}, NOW);
  assert.equal(httpStatus, 503);
  assert.equal(body.status, 'loading');
  assert.equal(body.reasons.length, 2);

  const half = setup({ 'weather.status.json': weather(HOUR) });
  const result = getDuckDbHealth(half, {}, NOW);
  assert.equal(result.httpStatus, 503);
  assert.equal(result.body.status, 'loading');
  assert.equal(result.body.weather.age_hours, 1);
});

test('unreadable status file is a 503, not a crash', () => {
  const dir = setup({ 'weather.status.json': '{not json', 'aeronautical.status.json': aero(DAY) });
  const { httpStatus, body } = getDuckDbHealth(dir, {}, NOW);
  assert.equal(httpStatus, 503);
  assert.equal(body.status, 'stale');
  assert.match(body.reasons[0], /invalid/);
});

function call(handler, query = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    Promise.resolve(handler({ query }, res));
  });
}

test('health endpoint: bigquery backend is always 200', async () => {
  delete process.env.DATA_BACKEND;
  const { status, body } = await call(health);
  assert.equal(status, 200);
  assert.deepEqual(body, { backend: 'bigquery' });
});

test('health endpoint: duckdb backend reflects the data directory', async () => {
  process.env.DATA_BACKEND = 'duckdb';
  process.env.DATA_DIR = setup({});
  assert.equal((await call(health)).status, 503);
  const ok = setup({ 'weather.status.json': weather(0), 'aeronautical.status.json': aero(0) });
  process.env.DATA_DIR = ok;
  const { status, body } = await call(health);
  assert.equal(status, 200);
  assert.equal(body.backend, 'duckdb');
});

test('approaches endpoint returns 503 with a message when data files are missing', async () => {
  process.env.DATA_BACKEND = 'duckdb';
  process.env.DATA_DIR = setup({});
  const { status, body } = await call(approaches, { airport: 'KCVO', radius: '50' });
  assert.equal(status, 503);
  assert.match(body.error, /Data not available yet: missing .*weather\.nbh\.parquet/);
});
