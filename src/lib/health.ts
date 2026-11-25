import fs from 'node:fs';
import path from 'node:path';

export type HealthResult = {
  httpStatus: number;
  body: Record<string, unknown>;
};

type StatusFile = {
  finished_at?: string;
  tables?: Record<string, { rows?: number; latest_source_time?: string }>;
  cycle?: string;
};

type Read =
  | { state: 'ok'; data: StatusFile; finishedAt: string; ageMs: number }
  | { state: 'missing' }
  | { state: 'invalid'; error: string };

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function readStatus(file: string, now: number): Read {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', error: String(err && err.message) };
  }
  try {
    const data = JSON.parse(text) as StatusFile;
    const finished = Date.parse(String(data.finished_at));
    if (Number.isNaN(finished)) return { state: 'invalid', error: 'finished_at missing or not a date' };
    return { state: 'ok', data, finishedAt: String(data.finished_at), ageMs: now - finished };
  } catch (err: any) {
    return { state: 'invalid', error: String(err && err.message) };
  }
}

const rowCounts = (data: StatusFile) =>
  Object.fromEntries(Object.entries(data.tables || {}).map(([k, v]) => [k, v.rows ?? null]));

const round = (n: number) => Math.round(n * 100) / 100;

// Health of the DuckDB data directory: weather must be recent, CIFP (the
// aeronautical data) may be up to a cycle old.
export function getDuckDbHealth(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now()
): HealthResult {
  const maxWeatherHours = Number(env.MAX_WEATHER_AGE_HOURS) || 3;
  const maxCifpDays = Number(env.MAX_CIFP_AGE_DAYS) || 35;

  const weather = readStatus(path.join(dataDir, 'weather.status.json'), now);
  const cifp = readStatus(path.join(dataDir, 'aeronautical.status.json'), now);

  const body: Record<string, unknown> = { backend: 'duckdb', data_dir: dataDir };
  const reasons: string[] = [];
  let loading = false;

  if (weather.state === 'ok') {
    const ageHours = weather.ageMs / HOUR;
    body.weather = {
      finished_at: weather.finishedAt,
      age_hours: round(ageHours),
      max_age_hours: maxWeatherHours,
      rows: rowCounts(weather.data),
    };
    if (ageHours > maxWeatherHours) {
      reasons.push(`weather data is ${round(ageHours)} hours old (max ${maxWeatherHours})`);
    }
  } else if (weather.state === 'missing') {
    loading = true;
    reasons.push('weather.status.json not found');
  } else {
    reasons.push(`weather.status.json invalid: ${weather.error}`);
  }

  if (cifp.state === 'ok') {
    const ageDays = cifp.ageMs / DAY;
    body.aeronautical = {
      finished_at: cifp.finishedAt,
      age_days: round(ageDays),
      max_age_days: maxCifpDays,
      cycle: cifp.data.cycle ?? null,
      rows: rowCounts(cifp.data),
    };
    if (ageDays > maxCifpDays) {
      reasons.push(`aeronautical data is ${round(ageDays)} days old (max ${maxCifpDays})`);
    }
  } else if (cifp.state === 'missing') {
    loading = true;
    reasons.push('aeronautical.status.json not found');
  } else {
    reasons.push(`aeronautical.status.json invalid: ${cifp.error}`);
  }

  if (reasons.length === 0) {
    return { httpStatus: 200, body: { status: 'ok', ...body } };
  }
  const status = loading ? 'loading' : 'stale';
  return { httpStatus: 503, body: { status, reasons, ...body } };
}
