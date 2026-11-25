import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { DataUnavailableError } from './errors';
import type { ApproachParams, ApproachRow } from './types';

// Parquet files the loaders produce, as view name -> file name in DATA_DIR.
export const DATA_FILES: Record<string, string> = {
  airport: 'aeronautical.airport.parquet',
  faf: 'aeronautical.faf.parquet',
  metar: 'weather.metar.parquet',
  taf: 'weather.taf.parquet',
  nbh: 'weather.nbh.parquet',
  nbs: 'weather.nbs.parquet',
};

export function getDataDir(): string {
  return process.env.DATA_DIR || '/data';
}

// Spherical great-circle distance in nautical miles, using the sphere radius
// BigQuery uses for GEOGRAPHY (6371008.8 m) so results match ST_DISTANCE.
export const distanceMacro =`CREATE OR REPLACE MACRO gc_distance_nm(lat1, lon1, lat2, lon2) AS
  2 * 6371008.8 * asin(least(1.0, sqrt(
    pow(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * pow(sin(radians(lon2 - lon1) / 2), 2)
  ))) * 0.000539957`;

const baseQuery = `WITH
  NearAirport AS (
    SELECT
      Latitude AS lat,
      Longitude AS lon
    FROM
      airport
    WHERE
      Airport_ICAO_Identifier = $airport
    LIMIT 1
  ),
  FAF_Airport AS (
    SELECT
      faf.*,
      apt.Latitude,
      apt.Longitude,
      apt.Airport_Elevation,
      gc_distance_nm(apt.Latitude, apt.Longitude, near.lat, near.lon) AS Distance_NM
    FROM
      faf
    INNER JOIN
      airport AS apt
    ON
      faf.Airport_Identifier = apt.Airport_ICAO_Identifier
    CROSS JOIN
      NearAirport AS near
  ),
  Filtered_FAF_Airport AS (
    SELECT
      *
    FROM
      FAF_Airport
    WHERE
      Distance_NM < $radius
  )
SELECT
  wx.Time AS Time,
  apt.Airport_ICAO_Identifier AS Airport_Identifier,
  ANY_VALUE(apt.Airport_Name) AS Airport_Name,
  ANY_VALUE(apt.Airport_Elevation) AS Airport_Elevation,
  CAST(ROUND(ANY_VALUE(wx.CIG) * 100) AS INTEGER) AS CIG,
  CAST(ROUND(ANY_VALUE(wx.LCB) * 100) AS INTEGER) AS LCB,
  CAST(ROUND(ANY_VALUE(wx.WDR) * 10) AS INTEGER) AS WDR,
  ROUND(ANY_VALUE(wx.VIS) / 10) AS VIS,
  ROUND((ANY_VALUE(wx.TMP) - 32) * 5/9) AS TMP,
  ROUND((ANY_VALUE(wx.DPT) - 32) * 5/9) AS DPT,
  ANY_VALUE(wx.WSP) AS WSP,
  TRY_CAST(ANY_VALUE(wx.IFC) AS DOUBLE) / 100 AS IFC,
  ARRAY_AGG(Filtered_FAF_Airport.SIDSTARApproach_Identifier ORDER BY Filtered_FAF_Airport.SIDSTARApproach_Identifier ASC) AS Approach_Identifier,
  ARRAY_AGG(IFNULL(Filtered_FAF_Airport.Approach_Name, '') ORDER BY Filtered_FAF_Airport.SIDSTARApproach_Identifier ASC) AS Approach_Name,
  ARRAY_AGG(IFNULL(Filtered_FAF_Airport.PDF_Name, '') ORDER BY Filtered_FAF_Airport.SIDSTARApproach_Identifier ASC) AS PDF_Name,
  ARRAY_AGG(Filtered_FAF_Airport.Altitude ORDER BY Filtered_FAF_Airport.SIDSTARApproach_Identifier ASC) AS FAF_MSL,
  ARRAY_AGG(Filtered_FAF_Airport.Altitude - apt.Airport_Elevation ORDER BY Filtered_FAF_Airport.SIDSTARApproach_Identifier ASC) AS FAF_AGL,
  ANY_VALUE(Filtered_FAF_Airport.Latitude) AS Latitude,
  ANY_VALUE(Filtered_FAF_Airport.Longitude) AS Longitude,
  ANY_VALUE(Filtered_FAF_Airport.Distance_NM) AS Distance_NM
FROM
  Filtered_FAF_Airport
INNER JOIN
  airport AS apt
ON
  Filtered_FAF_Airport.Airport_Identifier = apt.Airport_ICAO_Identifier
INNER JOIN
  (
    SELECT
      *[EXTRA_COLUMNS]
    FROM
      [FORECAST_TYPE]
  ) AS wx
ON
  Filtered_FAF_Airport.Airport_Identifier = wx.Location
WHERE
  wx.CIG != -88
  AND (wx.CIG * 100) <= (Filtered_FAF_Airport.Altitude - apt.Airport_Elevation)
  AND wx.CIG >= $minCeiling
  AND (
    (
      $startHour <= $endHour AND
      EXTRACT(HOUR FROM wx.Time) >= $startHour AND
      EXTRACT(HOUR FROM wx.Time) <= $endHour
    )
    OR
    (
      $startHour > $endHour AND
      (
        EXTRACT(HOUR FROM wx.Time) >= $startHour OR
        EXTRACT(HOUR FROM wx.Time) <= $endHour
      )
    )
  )
GROUP BY wx.Time, apt.Airport_ICAO_Identifier
ORDER BY
  ANY_VALUE(Filtered_FAF_Airport.Distance_NM) ASC,
  wx.Time ASC;`

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

type State = { connection: DuckDBConnection; viewsFor: string | null };

let statePromise: Promise<State> | null = null;
// Queries share one connection; run them one at a time.
let queue: Promise<unknown> = Promise.resolve();

async function init(): Promise<State> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  await connection.run("SET TimeZone = 'UTC'");
  await connection.run(`SET memory_limit = '${process.env.DUCKDB_MEMORY_LIMIT || '512MB'}'`);
  await connection.run(`SET threads = ${Number(process.env.DUCKDB_THREADS) || 2}`);
  await connection.run(distanceMacro);
  return { connection, viewsFor: null };
}

function getState(): Promise<State> {
  if (!statePromise) {
    statePromise = init().catch((err) => {
      statePromise = null;
      throw err;
    });
  }
  return statePromise;
}

// Views are plain wrappers around read_parquet(), so each query re-reads the
// files; the loaders replace them atomically at any time. The view definitions
// are created once files exist (CREATE VIEW binds against the file schema).
async function ensureViews(state: State, dataDir: string) {
  const missing = Object.values(DATA_FILES).filter(
    (file) => !fs.existsSync(path.join(dataDir, file))
  );
  if (missing.length > 0) {
    throw new DataUnavailableError(
      `Data not available yet: missing ${missing.join(', ')} in ${dataDir}`
    );
  }
  if (state.viewsFor === dataDir) return;
  for (const [view, file] of Object.entries(DATA_FILES)) {
    const filePath = sqlString(path.join(dataDir, file));
    await state.connection.run(
      `CREATE OR REPLACE VIEW ${view} AS SELECT * FROM read_parquet(${filePath})`
    );
  }
  state.viewsFor = dataDir;
}

// Convert a DuckDB JS value to plain JSON-safe JS.
function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

async function run(params: ApproachParams): Promise<ApproachRow[]> {
  const dataDir = getDataDir();
  const state = await getState();
  await ensureViews(state, dataDir);

  const { forecast, ...queryParams } = params;
  // Forecast table is interpolated, so it must come from the whitelist.
  if (!['metar', 'taf', 'nbh', 'nbs'].includes(forecast)) {
    throw new Error(`Invalid forecast type: ${forecast}`);
  }
  // TAFs have no temperature/dewpoint; add null columns so every source
  // shares the weather column set the SELECT list expects.
  const extraColumns = forecast === 'taf'
    ? ', CAST(NULL AS DOUBLE) AS TMP, CAST(NULL AS DOUBLE) AS DPT'
    : '';

  const query = baseQuery
    .replace('[FORECAST_TYPE]', forecast)
    .replace('[EXTRA_COLUMNS]', extraColumns);

  try {
    const reader = await state.connection.runAndReadAll(query, queryParams);
    return reader.getRowObjectsJS().map((row) => normalize(row) as ApproachRow);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/IO Error|No files found|Failed to read|Invalid Input Error: No magic/i.test(message)) {
      throw new DataUnavailableError(`Data files are not readable: ${message.split('\n')[0]}`);
    }
    throw err;
  }
}

export function queryApproaches(params: ApproachParams): Promise<ApproachRow[]> {
  const result = queue.then(() => run(params));
  queue = result.catch(() => undefined);
  return result;
}
