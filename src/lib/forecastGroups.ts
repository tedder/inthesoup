import { daylightIntervals, sunEvents } from './sun';

export type Approach = {
  id: string;
  name: string;
  chart: string | null;
  faf: { msl: number; agl: number };
};

export type Forecast = {
  time: string;
  airport: { icao: string; name: string; distance: number; location?: { lat: number; lng: number } };
  weather: { ceiling: number | null; lowest_cloud_base: number | null };
  approaches: Approach[];
};

export type ForecastPeriod = {
  gapBefore: boolean;
  start: string;
  end: string;
  ceiling: number | null;
  lowestCloudBases: (number | null)[];
  approaches: Approach[];
};

export type AirportGroup = {
  airport: Forecast['airport'];
  periods: ForecastPeriod[];
};

/** Group by visible row values and approach details; summarize cloud bases separately. */
function resultKey(forecast: Forecast) {
  return JSON.stringify([
    forecast.weather.ceiling,
    forecast.approaches.map(({ id, name, chart, faf }) =>
      JSON.stringify([id, name, chart, faf.msl, faf.agl])).sort(),
  ]);
}

export function groupForecasts(forecasts: Forecast[], source: string): AirportGroup[] {
  // NBS samples three hours apart are consecutive. Only missing samples at
  // the source's cadence break a range; never infer cadence from filtered rows.
  const interval = source === 'nbs' ? 3 * 3600000
    : source === 'nbh' || source === 'taf' ? 3600000 : null;
  const airports = new Map<string, Forecast[]>();
  forecasts.forEach(forecast => {
    const rows = airports.get(forecast.airport.icao) ?? [];
    rows.push(forecast);
    airports.set(forecast.airport.icao, rows);
  });

  return Array.from(airports.values()).map(rows => {
    rows.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const periods: ForecastPeriod[] = [];
    let previousKey: string | undefined;
    rows.forEach(row => {
      const key = resultKey(row);
      const previous = periods[periods.length - 1];
      if (previous && interval !== null && key === previousKey &&
          Date.parse(row.time) - Date.parse(previous.end) === interval) {
        previous.end = row.time;
        if (!previous.lowestCloudBases.includes(row.weather.lowest_cloud_base)) {
          previous.lowestCloudBases.push(row.weather.lowest_cloud_base);
        }
      } else {
        periods.push({
          gapBefore: Boolean(previous && interval !== null &&
            Date.parse(row.time) - Date.parse(previous.end) > interval),
          start: row.time,
          end: row.time,
          ceiling: row.weather.ceiling,
          lowestCloudBases: [row.weather.lowest_cloud_base],
          approaches: [...row.approaches].sort((a, b) => a.name.localeCompare(b.name)),
        });
      }
      previousKey = key;
    });
    return { airport: rows[0].airport, periods };
  }).sort((a, b) => a.airport.distance - b.airport.distance || a.airport.icao.localeCompare(b.airport.icao));
}

export function formatGapDuration(previousEnd: string, nextStart: string) {
  const totalMinutes = Math.round((Date.parse(nextStart) - Date.parse(previousEnd)) / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`]
    .filter(Boolean).join(' ') + ' gap';
}

export function formatPeriod(start: string, end: string, local: boolean) {
  const first = new Date(start);
  const last = new Date(end);
  const timeZone = local ? undefined : 'UTC';
  const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone });
  const timeFormat = new Intl.DateTimeFormat(undefined, local
    ? { hour: 'numeric', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
  const time = (date: Date) => timeFormat.format(date) + (local ? '' : 'Z');
  const sameDay = dateFormat.format(first) === dateFormat.format(last);
  // Include offsets across DST changes so repeated wall-clock hours are clear.
  const offsetChanged = local && first.getTimezoneOffset() !== last.getTimezoneOffset();
  const offsetTime = (date: Date) => new Intl.DateTimeFormat(undefined, {
    hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset',
  }).format(date);
  const firstTime = offsetChanged ? offsetTime(first) : time(first);
  const lastTime = offsetChanged ? offsetTime(last) : time(last);
  return {
    date: sameDay ? dateFormat.format(first) : `${dateFormat.format(first)} – ${dateFormat.format(last)}`,
    time: start === end ? firstTime : `${firstTime} – ${lastTime}`,
  };
}

export function formatCloudBases(values: (number | null)[]) {
  const known = values.filter((value): value is number => value != null);
  if (!known.length) return 'LCB: N/A';
  const min = Math.min(...known);
  const max = Math.max(...known);
  return `LCB: ${min === max ? min.toLocaleString() : `${min.toLocaleString()}–${max.toLocaleString()}`} ft${known.length < values.length ? ' (some times unavailable)' : ''}`;
}

export type TimelineBar = { left: number; width: number; period: ForecastPeriod };
export type TimelineRow = { airport: AirportGroup['airport']; bars: TimelineBar[] };
export type TimelineLayout = {
  start: number;
  end: number;
  ticks: { at: number; left: number }[];
  now: number | null;
  /** Daylight bands and sunrise/sunset edges (percent of the axis), at the nearest airport; null if unknown. */
  sun: { twilight: number; day: { left: number; width: number; fadeIn: boolean; fadeOut: boolean }[]; edges: { left: number; kind: 'sunrise' | 'sunset' }[] } | null;
  rows: TimelineRow[];
};

const HOUR = 3600000;
/** Length of the day/night fade drawn at sunrise and sunset. */
const TWILIGHT = 45 * 60000;

/** How long one sample covers: NBS is 3-hourly, the others hourly (METAR shown as an hour). */
export function sampleDuration(source: string) {
  return source === 'nbs' ? 3 * HOUR : HOUR;
}

/**
 * Place each airport's periods on one shared time axis, as percentages, for the
 * Gantt-style timeline. Rows keep the groups' order (nearest airport first).
 */
export function timelineLayout(groups: AirportGroup[], source: string, nowMs: number = Date.now(),
  utcOffsetMinutes = 0): TimelineLayout | null {
  const duration = sampleDuration(source);
  const spans = groups.flatMap(group => group.periods.map(period =>
    [Date.parse(period.start), Date.parse(period.end) + duration]));
  if (!spans.length) return null;
  const start = Math.min(...spans.map(span => span[0]));
  const end = Math.max(...spans.map(span => span[1]));
  const total = end - start;
  const percent = (ms: number) => ((ms - start) / total) * 100;

  // Aim for at most about eight labeled ticks, on whole-hour multiples of the step
  // in the displayed time zone (utcOffsetMinutes: e.g. -480 for PST, 0 for Zulu).
  const hours = total / HOUR;
  const step = ([1, 3, 6, 12, 24, 48].find(candidate => hours / candidate <= 8) ?? 96) * HOUR;
  const offset = utcOffsetMinutes * 60000;
  const ticks = [];
  for (let at = Math.ceil((start + offset) / step) * step - offset; at <= end; at += step) {
    ticks.push({ at, left: percent(at) });
  }

  const where = groups.find(group => group.airport.location)?.airport.location;
  const sun = where ? {
    twilight: percent(start + TWILIGHT) - percent(start),
    // Fade only at a real sunrise/sunset, not where the band is cut off by the axis edge.
    day: daylightIntervals(start, end, where.lat, where.lng).map(([a, b]) => ({
      left: percent(a), width: percent(b) - percent(a), fadeIn: a > start, fadeOut: b < end,
    })),
    edges: sunEvents(start, end, where.lat, where.lng)
      .filter(event => event.at > start && event.at < end)
      .map(event => ({ left: percent(event.at), kind: event.kind })),
  } : null;

  return {
    start,
    end,
    ticks,
    sun,
    now: nowMs >= start && nowMs <= end ? percent(nowMs) : null,
    rows: groups.map(group => ({
      airport: group.airport,
      bars: group.periods.map(period => {
        const left = percent(Date.parse(period.start));
        return { left, width: percent(Date.parse(period.end) + duration) - left, period };
      }),
    })),
  };
}

/** Tick label; midnight in the displayed zone also names the day, e.g. "Wed 00Z" or "Wed". */
export function formatTick(ms: number, local: boolean) {
  const date = new Date(ms);
  const timeZone = local ? undefined : 'UTC';
  const midnight = local ? date.getHours() === 0 : date.getUTCHours() === 0;
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone }).format(date);
  if (!local) return `${midnight ? day + ' ' : ''}${String(date.getUTCHours()).padStart(2, '0')}Z`;
  return midnight ? day : new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(date);
}
