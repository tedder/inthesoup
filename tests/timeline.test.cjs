const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/register-ts.cjs');
const { groupForecasts, timelineLayout, sampleDuration, formatTick } = require('../src/lib/forecastGroups.ts');

const row = (icao, distance, hour, ceiling = 800) => ({
  time: `2026-11-25T${String(hour).padStart(2, '0')}:00:00Z`,
  airport: { icao, name: icao, distance },
  weather: { ceiling, lowest_cloud_base: ceiling },
  approaches: [{ id: 'I10R', name: 'ILS RWY 10R', chart: null, faf: { msl: 2000, agl: 1970 } }],
});
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const NOW_OUTSIDE = Date.parse('2026-01-01T00:00:00Z');

test('no groups gives no timeline', () => {
  assert.equal(timelineLayout([], 'nbh'), null);
});

test('rows keep nearest-first order and bars cover each sample', () => {
  // KPDX 00-02Z (one period), KHIO at 01Z only. NBH samples are an hour long.
  const groups = groupForecasts([row('KPDX', 12, 0), row('KPDX', 12, 1), row('KPDX', 12, 2), row('KHIO', 8, 1)], 'nbh');
  const layout = timelineLayout(groups, 'nbh', NOW_OUTSIDE);
  assert.deepEqual(layout.rows.map(r => r.airport.icao), ['KHIO', 'KPDX']);
  assert.equal(layout.start, Date.parse('2026-11-25T00:00:00Z'));
  assert.equal(layout.end, Date.parse('2026-11-25T03:00:00Z'));
  const [khio, kpdx] = layout.rows;
  close(khio.bars[0].left, 100 / 3);
  close(khio.bars[0].width, 100 / 3);
  assert.equal(kpdx.bars.length, 1);
  close(kpdx.bars[0].left, 0);
  close(kpdx.bars[0].width, 100);
  assert.equal(layout.now, null);
});

test('a gap splits an airport into separate bars', () => {
  const groups = groupForecasts([row('KTTD', 11, 0), row('KTTD', 11, 5)], 'nbh');
  const bars = timelineLayout(groups, 'nbh', NOW_OUTSIDE).rows[0].bars;
  assert.equal(bars.length, 2);
  close(bars[0].width, 100 / 6);
  close(bars[1].left, 500 / 6);
});

test('NBS samples cover three hours', () => {
  assert.equal(sampleDuration('nbs'), 3 * 3600000);
  assert.equal(sampleDuration('metar'), 3600000);
  const layout = timelineLayout(groupForecasts([row('KAST', 70, 0), row('KAST', 70, 3)], 'nbs'), 'nbs', NOW_OUTSIDE);
  assert.equal(layout.end - layout.start, 6 * 3600000);
  close(layout.rows[0].bars[0].width, 100);
});

test('ticks fall on whole-hour step multiples and stay within the axis', () => {
  // 69 hours of NBS: step should be 12 h (69 / 12 <= 8), so 00Z and 12Z ticks.
  const rows = Array.from({ length: 23 }, (_, i) => row('KSEA', 30, 0)).map((r, i) => ({
    ...r, time: new Date(Date.parse('2026-11-25T03:00:00Z') + i * 3 * 3600000).toISOString(),
  }));
  const layout = timelineLayout(groupForecasts(rows, 'nbs'), 'nbs', NOW_OUTSIDE);
  assert.ok(layout.ticks.length <= 8 && layout.ticks.length >= 4);
  for (const tick of layout.ticks) {
    assert.equal(tick.at % (12 * 3600000), 0);
    assert.ok(tick.left >= 0 && tick.left <= 100);
  }
  assert.deepEqual(layout.ticks.map(t => formatTick(t.at, false)).slice(0, 2), ['12Z', 'Thu 00Z']);
});

test('local ticks align to local hours', () => {
  // Same 69-hour NBS span, shown in PST (UTC-8): 12-hour ticks at 08Z/20Z (local midnight/noon).
  const rows = Array.from({ length: 23 }, (_, i) => ({
    ...row('KSEA', 30, 0), time: new Date(Date.parse('2026-11-25T03:00:00Z') + i * 3 * 3600000).toISOString(),
  }));
  const layout = timelineLayout(groupForecasts(rows, 'nbs'), 'nbs', NOW_OUTSIDE, -480);
  assert.deepEqual(layout.ticks.slice(0, 2).map(t => new Date(t.at).toISOString()),
    ['2026-11-25T08:00:00.000Z', '2026-11-25T20:00:00.000Z']);
});

test('midnight ticks name the day', () => {
  assert.match(formatTick(Date.parse('2026-11-25T00:00:00Z'), false), /^Wed 00Z$/);
  assert.equal(formatTick(Date.parse('2026-11-25T12:00:00Z'), false), '12Z');
});

test('now marker appears only inside the axis', () => {
  const groups = groupForecasts([row('KPDX', 12, 0), row('KPDX', 12, 1)], 'nbh');
  const layout = timelineLayout(groups, 'nbh', Date.parse('2026-11-25T01:00:00Z'));
  close(layout.now, 50);
});

test('sunrise and sunset at Portland in late November', () => {
  const { sunEvents } = require('../src/lib/sun.ts');
  const events = sunEvents(Date.parse('2026-11-25T00:00:00Z'), Date.parse('2026-11-26T12:00:00Z'), 45.59, -122.6);
  const rise = events.find(e => e.kind === 'sunrise' && e.at > Date.parse('2026-11-25T12:00:00Z'));
  const set = events.find(e => e.kind === 'sunset' && e.at > Date.parse('2026-11-25T12:00:00Z'));
  // About 07:20 PST (15:20Z) and 16:30 PST (00:30Z next day).
  assert.ok(Math.abs(rise.at - Date.parse('2026-11-25T15:20:00Z')) < 10 * 60000, new Date(rise.at).toISOString());
  assert.ok(Math.abs(set.at - Date.parse('2026-11-26T00:30:00Z')) < 10 * 60000, new Date(set.at).toISOString());
});

test('timeline layout has daylight bands when the airport has a location', () => {
  const withLoc = row('KPDX', 12, 0);
  withLoc.airport.location = { lat: 45.59, lng: -122.6 };
  const rows = [0, 6, 12, 18, 23].map(h => ({ ...withLoc, time: `2026-11-25T${String(h).padStart(2, '0')}:00:00Z` }));
  const layout = timelineLayout(groupForecasts(rows, 'nbh'), 'nbh', NOW_OUTSIDE);
  assert.ok(layout.sun.day.length >= 1);
  assert.ok(layout.sun.twilight > 0);
  // The band is cut by the axis edge at one end and by a real sunset/sunrise at the other.
  assert.ok(layout.sun.day.some(d => d.fadeIn !== d.fadeOut || d.fadeIn));
  assert.ok(layout.sun.edges.some(e => e.kind === 'sunrise'));
  assert.equal(timelineLayout(groupForecasts([row('KPDX', 12, 0)], 'nbh'), 'nbh', NOW_OUTSIDE).sun, null);
});
