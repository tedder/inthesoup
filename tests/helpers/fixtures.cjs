// Builds tiny Parquet fixtures (the loader data contract) with DuckDB itself.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DuckDBInstance } = require('@duckdb/node-api');

// KTGT is the target airport. KNEAR is about 12 NM north, KLOW about 6 NM
// north, KFAR about 120 NM north.
const airports = [
  ['KTGT', 'Target Field', 45.0, -122.0, 100],
  ['KNEAR', 'Near Field', 45.2, -122.0, 200],
  ['KLOW', 'Low Field', 45.1, -122.0, 0],
  ['KFAR', 'Far Field', 47.0, -122.0, 50],
  // No approaches (not in the FAF table): never the nearest-airport answer.
  ['KNOAP', 'No Approach Field', 46.5, -122.0, 300],
];

// [airport, approach id, approach name, pdf, FAF altitude MSL]
const fafs = [
  ['KTGT', 'R10', 'RNAV (GPS) RWY 10', 'tgt.pdf', 600], // AGL 500
  ['KNEAR', 'I10', '', '', 1700], // AGL 1500, name derived from id
  ['KNEAR', 'R28', 'RNAV (GPS) RWY 28', 'near.pdf', 400], // AGL 200
  ['KLOW', 'R05', 'RNAV (GPS) RWY 5', 'low.pdf', 900], // AGL 900
  ['KFAR', 'R01', 'RNAV (GPS) RWY 1', 'far.pdf', 1500],
];

const q = (s) => `'${s.replace(/'/g, "''")}'`;

// Hourly rows for 2026-11-25. cig is in hundreds of feet.
function hourly(location, cigFor) {
  const rows = [];
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, '0');
    rows.push({ location, time: `2026-11-25 ${hh}:00:00+00`, cig: cigFor(h) });
  }
  return rows;
}

const nearCig = (h) => (h === 12 ? -88 : 10); // 1000 ft, none at hour 12
const tgtCig = (h) => (h === 5 ? 4 : 30); // 400 ft at 05Z, else 3000 ft
const farCig = () => 10;
const lowCig = () => 10; // 1000 ft, above its 900 ft AGL FAF: never listed

function weatherRows() {
  return [
    ...hourly('KNEAR', nearCig),
    ...hourly('KTGT', tgtCig),
    ...hourly('KFAR', farCig),
    ...hourly('KLOW', lowCig),
  ];
}

async function buildFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const instance = await DuckDBInstance.create(':memory:');
  const c = await instance.connect();
  await c.run("SET TimeZone = 'UTC'");

  const aptValues = airports
    .map(([id, name, lat, lon, elev]) => `(${q(id)}, ${q(name)}, ${lat}::DOUBLE, ${lon}::DOUBLE, ${elev}::DOUBLE)`)
    .join(',');
  await c.run(`COPY (SELECT * FROM (VALUES ${aptValues}) t(Airport_ICAO_Identifier, Airport_Name, Latitude, Longitude, Airport_Elevation))
    TO ${q(path.join(dir, 'aeronautical.airport.parquet'))} (FORMAT parquet)`);

  const fafValues = fafs
    .map(([id, appr, name, pdf, alt]) => `(${q(id)}, ${q(appr)}, ${name ? q(name) : 'NULL'}, ${pdf ? q(pdf) : 'NULL'}, ${alt}::DOUBLE)`)
    .join(',');
  await c.run(`COPY (SELECT * FROM (VALUES ${fafValues}) t(Airport_Identifier, SIDSTARApproach_Identifier, Approach_Name, PDF_Name, Altitude))
    TO ${q(path.join(dir, 'aeronautical.faf.parquet'))} (FORMAT parquet)`);

  const wx = weatherRows();
  const values = wx
    .map((r) => `(${q(r.location)}, ${q(r.time)}::TIMESTAMPTZ, ${q(r.time)}::TIMESTAMPTZ, ${r.cig}::DOUBLE, ${r.cig}::DOUBLE, 77.0::DOUBLE, 59.0::DOUBLE, 18.0::DOUBLE, 8.0::DOUBLE, 160.934::DOUBLE, 25::DOUBLE)`)
    .join(',');
  const cols = 'Location, Time, Forecast_Time, CIG, LCB, TMP, DPT, WDR, WSP, VIS, IFC';
  for (const table of ['metar', 'nbh', 'nbs']) {
    await c.run(`COPY (SELECT * FROM (VALUES ${values}) t(${cols}))
      TO ${q(path.join(dir, `weather.${table}.parquet`))} (FORMAT parquet)`);
  }
  // TAF has no TMP/DPT columns.
  const tafValues = wx
    .map((r) => `(${q(r.location)}, ${q(r.time)}::TIMESTAMPTZ, ${q(r.time)}::TIMESTAMPTZ, ${r.cig}::DOUBLE, ${r.cig}::DOUBLE, 18.0::DOUBLE, 8.0::DOUBLE, 160.934::DOUBLE, NULL::DOUBLE)`)
    .join(',');
  await c.run(`COPY (SELECT * FROM (VALUES ${tafValues}) t(Location, Time, Forecast_Time, CIG, LCB, WDR, WSP, VIS, IFC))
    TO ${q(path.join(dir, 'weather.taf.parquet'))} (FORMAT parquet)`);

  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'weather.status.json'), JSON.stringify({
    finished_at: now, format: 'parquet',
    tables: { 'weather.metar': { rows: wx.length, latest_source_time: now } },
  }));
  fs.writeFileSync(path.join(dir, 'aeronautical.status.json'), JSON.stringify({
    finished_at: now, format: 'parquet', cycle: '2610',
    tables: { 'aeronautical.airport': { rows: airports.length }, 'aeronautical.faf': { rows: fafs.length } },
  }));
  c.closeSync();
  return dir;
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), prefix));
}

module.exports = { buildFixtures, tempDir };
