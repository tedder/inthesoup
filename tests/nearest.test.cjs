const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/register-ts.cjs');
const { buildFixtures, tempDir } = require('./helpers/fixtures.cjs');

const dir = tempDir('inthesoup-nearest-');
process.env.DATA_BACKEND = 'duckdb';
process.env.DATA_DIR = dir;

const { nearestAirport } = require('../src/lib/db');
const handler = require('../src/pages/api/nearest.ts').default;

before(async () => {
  await buildFixtures(dir);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function call(query) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, headers: this.headers }); },
    };
    handler({ query }, res);
  });
}

test('nearest airport with an approach, with distance in nm', async () => {
  const result = await nearestAirport(45.0, -122.0);
  assert.equal(result.icao, 'KTGT');
  assert.equal(result.name, 'Target Field');
  assert.ok(result.distance_nm < 0.01);

  const near = await nearestAirport(45.19, -122.0);
  assert.equal(near.icao, 'KNEAR');
  assert.ok(Math.abs(near.distance_nm - 0.6) < 0.01, String(near.distance_nm));
});

test('airports without approaches are skipped', async () => {
  // KNOAP sits exactly here but has no FAF records; KFAR (30 nm north) has one.
  const result = await nearestAirport(46.5, -122.0);
  assert.equal(result.icao, 'KFAR');
  assert.ok(Math.abs(result.distance_nm - 30) < 0.1, String(result.distance_nm));
});

test('API returns the nearest airport and is not cached', async () => {
  const { status, body, headers } = await call({ lat: '45.01', lon: '-122.0' });
  assert.equal(status, 200);
  assert.equal(body.icao, 'KTGT');
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.doesNotThrow(() => JSON.stringify(body));
});

test('API validates coordinates', async () => {
  for (const query of [{}, { lat: '45' }, { lat: 'abc', lon: '-122' }, { lat: '91', lon: '0' }, { lat: '0', lon: '-181' }, { lat: '', lon: '' }]) {
    const { status, body } = await call(query);
    assert.equal(status, 400, JSON.stringify(query));
    assert.match(body.error, /valid coordinates/);
  }
});

test('API returns 503 while data files are missing', async () => {
  const empty = tempDir('inthesoup-nearest-empty-');
  process.env.DATA_DIR = empty;
  try {
    const { status, body } = await call({ lat: '45', lon: '-122' });
    assert.equal(status, 503);
    assert.match(body.error, /loading/);
  } finally {
    process.env.DATA_DIR = dir;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
