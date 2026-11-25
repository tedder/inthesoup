const DAY = 86400000;
const rad = (deg: number) => (deg * Math.PI) / 180;

export type SunEvent = { at: number; kind: 'sunrise' | 'sunset' };

/**
 * Sunrise and sunset (UTC ms) for solar day number `n` (days since J2000) at a
 * place, from the Wikipedia "sunrise equation" (accurate to about a minute).
 * Returns null when the sun does not rise or set that day (polar regions).
 */
function sunForDay(n: number, lat: number, lon: number): SunEvent[] | null {
  const jStar = n - lon / 360;
  const m = (357.5291 + 0.98560028 * jStar) % 360;
  const c = 1.9148 * Math.sin(rad(m)) + 0.02 * Math.sin(rad(2 * m)) + 0.0003 * Math.sin(rad(3 * m));
  const lambda = (m + c + 180 + 102.9372) % 360;
  const transit = 2451545 + jStar + 0.0053 * Math.sin(rad(m)) - 0.0069 * Math.sin(rad(2 * lambda));
  const sinDec = Math.sin(rad(lambda)) * Math.sin(rad(23.4397));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosHour = (Math.sin(rad(-0.833)) - Math.sin(rad(lat)) * sinDec) / (Math.cos(rad(lat)) * cosDec);
  if (cosHour < -1 || cosHour > 1) return null;
  const hour = (Math.acos(cosHour) * 180) / Math.PI / 360;
  const toMs = (jd: number) => (jd - 2440587.5) * DAY;
  return [
    { at: toMs(transit - hour), kind: 'sunrise' },
    { at: toMs(transit + hour), kind: 'sunset' },
  ];
}

/** Sunrise/sunset events overlapping [startMs, endMs], in time order. */
export function sunEvents(startMs: number, endMs: number, lat: number, lon: number): SunEvent[] {
  const first = Math.floor((startMs - DAY) / DAY + 2440587.5 - 2451545);
  const last = Math.ceil((endMs + DAY) / DAY + 2440587.5 - 2451545);
  const events: SunEvent[] = [];
  for (let n = first; n <= last; n++) events.push(...(sunForDay(n, lat, lon) ?? []));
  return events.sort((a, b) => a.at - b.at);
}

/** Daylight intervals clipped to [startMs, endMs]. */
export function daylightIntervals(startMs: number, endMs: number, lat: number, lon: number) {
  const events = sunEvents(startMs, endMs, lat, lon);
  const intervals: [number, number][] = [];
  let rise: number | null = null;
  events.forEach((event, i) => {
    if (event.kind === 'sunrise') rise = event.at;
    else if (rise != null) { intervals.push([rise, event.at]); rise = null; }
    else if (i === 0) intervals.push([-Infinity, event.at]);
  });
  if (rise != null) intervals.push([rise, Infinity]);
  return intervals
    .map(([a, b]): [number, number] => [Math.max(a, startMs), Math.min(b, endMs)])
    .filter(([a, b]) => b > a);
}
