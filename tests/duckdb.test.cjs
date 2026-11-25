const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/register-ts.cjs');
const { buildFixtures, tempDir } = require('./helpers/fixtures.cjs');

const dir = tempDir('inthesoup-duckdb-');
process.env.DATA_BACKEND = 'duckdb';
process.env.DATA_DIR = dir;

const { queryApproaches } = require('../src/lib/db');
const handler = require('../src/pages/api/approaches.ts').default;

const base = { airport: 'KTGT', radius: 50, minCeiling: 0, startHour: 0, endHour: 23, forecast: 'nbh' };
const hoursOf = (rows, icao) => rows.filter((r) => r.Airport_Identifier === icao).map((r) => new Date(r.Time).getUTCHours());

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
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    handler({ query }, res);
  });
}

test('returns the target and nearby airports sorted by distance, filtering approaches by ceiling', async () => {
  const rows = await queryApproaches(base);
  const airports = [...new Set(rows.map((r) => r.Airport_Identifier))];
  assert.deepEqual(airports, ['KTGT', 'KNEAR']); // KFAR is out of radius, KLOW's FAF is below the ceiling

  const near = rows.find((r) => r.Airport_Identifier === 'KNEAR');
  // R28 (AGL 200) is under the 1000 ft ceiling, so only I10 (AGL 1500) is listed
  assert.deepEqual(near.Approach_Identifier, ['I10']);
  assert.deepEqual(near.FAF_MSL, [1700]);
  assert.deepEqual(near.FAF_AGL, [1500]);
  assert.deepEqual(near.Approach_Name, ['']);
  assert.deepEqual(near.PDF_Name, ['']);
  assert.equal(near.CIG, 1000);
  assert.equal(near.Airport_Name, 'Near Field');
  assert.equal(near.Airport_Elevation, 200);
  assert.ok(Math.abs(near.Distance_NM - 12.0) < 0.1, `distance ${near.Distance_NM}`);
  assert.equal(rows[0].Airport_Identifier, 'KTGT');
  assert.equal(rows[0].Distance_NM, 0);
});

test('rows are plain JSON-safe values', async () => {
  const rows = await queryApproaches(base);
  assert.equal(JSON.stringify(rows), JSON.stringify(JSON.parse(JSON.stringify(rows))));
  const row = rows.find((r) => r.Airport_Identifier === 'KNEAR');
  assert.equal(typeof row.Time, 'string');
  assert.match(row.Time, /^2026-11-25T\d\d:00:00(\.000)?Z$/);
  for (const k of ['CIG', 'LCB', 'WDR', 'VIS', 'TMP', 'DPT', 'WSP', 'IFC', 'Latitude', 'Longitude', 'Distance_NM']) {
    assert.equal(typeof row[k], 'number', k);
  }
  assert.equal(row.TMP, 25); // (77 - 32) * 5/9
  assert.equal(row.DPT, 15);
  assert.equal(row.WDR, 180);
  assert.equal(row.VIS, 16);
  assert.equal(row.IFC, 0.25);
  assert.ok(Array.isArray(row.Approach_Identifier));
});

test('CIG of -88 (unknown) is excluded', async () => {
  const rows = await queryApproaches(base);
  assert.ok(!hoursOf(rows, 'KNEAR').includes(12));
  assert.equal(hoursOf(rows, 'KNEAR').length, 23);
});

test('ceiling lower than the FAF AGL is the only way an approach is listed', async () => {
  const rows = await queryApproaches(base);
  // KTGT: FAF AGL 500, ceiling 400 ft only at 05Z
  assert.deepEqual(hoursOf(rows, 'KTGT'), [5]);
});

test('radius filters airports', async () => {
  const small = await queryApproaches({ ...base, radius: 5 });
  assert.deepEqual([...new Set(small.map((r) => r.Airport_Identifier))], ['KTGT']);
  const large = await queryApproaches({ ...base, radius: 200 });
  assert.deepEqual([...new Set(large.map((r) => r.Airport_Identifier))], ['KTGT', 'KNEAR', 'KFAR']);
  const none = await queryApproaches({ ...base, radius: 0.01 });
  assert.deepEqual([...new Set(none.map((r) => r.Airport_Identifier))], ['KTGT'], 'distance 0 is under the radius');
});

test('minCeiling is in hundreds of feet', async () => {
  const rows = await queryApproaches({ ...base, minCeiling: 5 });
  assert.deepEqual(hoursOf(rows, 'KTGT'), []);
  assert.equal(hoursOf(rows, 'KNEAR').length, 23);
  const high = await queryApproaches({ ...base, minCeiling: 11 });
  assert.equal(hoursOf(high, 'KNEAR').length, 0);
});

test('hour window, plain and wrapping around midnight', async () => {
  const plain = await queryApproaches({ ...base, startHour: 3, endHour: 5 });
  assert.deepEqual(hoursOf(plain, 'KNEAR'), [3, 4, 5]);
  const wrap = await queryApproaches({ ...base, startHour: 22, endHour: 2 });
  assert.deepEqual(hoursOf(wrap, 'KNEAR').sort((a, b) => a - b), [0, 1, 2, 22, 23]);
  const single = await queryApproaches({ ...base, startHour: 7, endHour: 7 });
  assert.deepEqual(hoursOf(single, 'KNEAR'), [7]);
});

test('unknown airport returns no rows', async () => {
  assert.deepEqual(await queryApproaches({ ...base, airport: 'KNOPE' }), []);
});

test('quotes in the airport parameter are not interpreted as SQL', async () => {
  assert.deepEqual(await queryApproaches({ ...base, airport: "K' OR '1'='1" }), []);
});

test('metar, nbs and taf sources', async () => {
  for (const forecast of ['metar', 'nbs', 'taf']) {
    const rows = await queryApproaches({ ...base, forecast });
    assert.equal(hoursOf(rows, 'KNEAR').length, 23, forecast);
    assert.deepEqual(rows.find((r) => r.Airport_Identifier === 'KNEAR').Approach_Identifier, ['I10']);
  }
  const taf = (await queryApproaches({ ...base, forecast: 'taf' }))[0];
  assert.equal(taf.TMP, null);
  assert.equal(taf.DPT, null);
  assert.equal(taf.IFC, null);
});

test('invalid forecast type is rejected before reaching SQL', async () => {
  await assert.rejects(queryApproaches({ ...base, forecast: 'nbh; DROP VIEW nbh' }), /Invalid forecast/);
});

test('API handler maps rows to the response shape', async () => {
  const { status, body } = await call({ airport: 'KTGT', radius: '50', forecast: 'nbh' });
  assert.equal(status, 200);
  const near = body.find((r) => r.airport.icao === 'KNEAR');
  assert.equal(near.time instanceof Date, true);
  assert.equal(near.airport.name, 'Near Field');
  assert.equal(near.weather.ceiling, 1000);
  assert.deepEqual(near.approaches, [{ id: 'I10', name: 'ILS RWY 10', chart: null, faf: { msl: 1700, agl: 1500 } }]);
  const tgt = body.find((r) => r.airport.icao === 'KTGT');
  assert.equal(tgt.approaches[0].name, 'RNAV (GPS) RWY 10');
  assert.equal(tgt.approaches[0].chart, 'tgt.pdf');
});

test('API handler validates parameters', async () => {
  assert.equal((await call({ radius: '50' })).status, 400);
  assert.equal((await call({ airport: 'KTGT' })).status, 400);
  assert.equal((await call({ airport: 'KTGT', radius: '900' })).status, 400);
  assert.equal((await call({ airport: 'KTGT', radius: '50', forecast: 'bogus' })).status, 400);
  const unknown = await call({ airport: 'KNOPE', radius: '50' });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, []);
});

test('replacing a Parquet file is picked up by the next query', async () => {
  const before = await queryApproaches({ ...base, forecast: 'metar' });
  assert.ok(before.length > 0);
  const { DuckDBInstance } = require('@duckdb/node-api');
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  const file = `${dir}/weather.metar.parquet`;
  // Same schema, but only KNEAR at 03Z.
  await c.run(`COPY (SELECT * FROM '${file}' WHERE Location = 'KNEAR' AND EXTRACT(hour FROM Time) = 3)
    TO '${dir}/new.parquet' (FORMAT parquet)`);
  fs.renameSync(`${dir}/new.parquet`, file);
  const after = await queryApproaches({ ...base, forecast: 'metar' });
  assert.deepEqual(after.map((r) => [r.Airport_Identifier, new Date(r.Time).getUTCHours()]), [['KNEAR', 3]]);
});
