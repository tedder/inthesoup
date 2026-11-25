const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/register-ts.cjs');
const { DuckDBInstance } = require('@duckdb/node-api');
const { distanceMacro } = require('../src/lib/db/duckdb.ts');

// Expected values: CockroachDB ST_Distance(a::geography, b::geography, false)
// (spherical) * 0.000539957, using the airport reference points from CIFP.
const pairs = [
  { name: 'KCVO-KPDX', a: [44.496875, -123.28945833333333], b: [45.58870833333334, -122.59686944444444], nm: 71.8369939309602 },
  { name: 'KSEA-KBOI', a: [47.449888888888886, -122.31177777777778], b: [43.56436111111111, -116.22286111111111], nm: 346.3109622856088 },
  { name: 'KJFK-KLAX', a: [40.63992777777778, -73.77869166666666], b: [33.94249722222222, -118.40805], nm: 2145.9097537947555 },
];

test('haversine macro matches CockroachDB spherical distance', async () => {
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  await c.run(distanceMacro);
  for (const p of pairs) {
    const r = await c.runAndReadAll(`SELECT gc_distance_nm(${p.a[0]}, ${p.a[1]}, ${p.b[0]}, ${p.b[1]}) AS nm`);
    const nm = r.getRowObjectsJS()[0].nm;
    assert.ok(Math.abs(nm - p.nm) / p.nm < 1e-7, `${p.name}: ${nm} vs ${p.nm}`);
  }
  const same = await c.runAndReadAll('SELECT gc_distance_nm(45.0, -122.0, 45.0, -122.0) AS nm');
  assert.equal(same.getRowObjectsJS()[0].nm, 0);
});

test('DuckDB CAST to INTEGER rounds half to even, so the query rounds explicitly', async () => {
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  const r = await c.runAndReadAll(
    'SELECT CAST(2.5::DOUBLE AS INTEGER) AS plain, CAST(ROUND(2.5::DOUBLE) AS INTEGER) AS rounded, CAST(ROUND(-2.5::DOUBLE) AS INTEGER) AS neg'
  );
  // BigQuery CAST(2.5 AS INT64) = 3 (half away from zero)
  assert.deepEqual(r.getRowObjectsJS()[0], { plain: 2, rounded: 3, neg: -3 });
});
