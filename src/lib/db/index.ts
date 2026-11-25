import type { ApproachParams, ApproachRow, NearestAirport } from './types';

export type { ApproachParams, ApproachRow, NearestAirport } from './types';
export { DataUnavailableError } from './errors';

export const FORECAST_TYPES = ['metar', 'taf', 'nbh', 'nbs'];

export function getBackendName(): 'bigquery' | 'duckdb' {
  const name = (process.env.DATA_BACKEND || 'bigquery').toLowerCase();
  if (name !== 'bigquery' && name !== 'duckdb') {
    throw new Error(`Unknown DATA_BACKEND "${name}" (expected bigquery or duckdb)`);
  }
  return name;
}

// Backends are imported on demand so a BigQuery deployment never loads the
// DuckDB native module (and vice versa).
export async function queryApproaches(params: ApproachParams): Promise<ApproachRow[]> {
  if (getBackendName() === 'duckdb') {
    const backend = await import('./duckdb');
    return backend.queryApproaches(params);
  }
  const backend = await import('./bigquery');
  return backend.queryApproaches(params);
}

export async function nearestAirport(lat: number, lon: number): Promise<NearestAirport | null> {
  if (getBackendName() === 'duckdb') {
    const backend = await import('./duckdb');
    return backend.nearestAirport(lat, lon);
  }
  const backend = await import('./bigquery');
  return backend.nearestAirport(lat, lon);
}
