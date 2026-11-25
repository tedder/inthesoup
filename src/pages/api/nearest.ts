import { NextApiRequest, NextApiResponse } from 'next';
import { nearestAirport, DataUnavailableError } from '../../lib/db';

// GET /api/nearest?lat=45.59&lon=-122.60 -> { icao, name, distance_nm }
// The nearest airport that has an instrument approach. Coordinates come from
// the browser and are used only for this lookup; nothing is stored.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const latText = typeof req.query.lat === 'string' ? req.query.lat.trim() : '';
  const lonText = typeof req.query.lon === 'string' ? req.query.lon.trim() : '';
  // Number('') is 0, so blank values must be rejected before converting.
  const lat = Number(latText);
  const lon = Number(lonText);

  if (latText === '' || lonText === '' ||
      !Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    res.status(400).json({ error: 'lat and lon must be valid coordinates' });
    return;
  }

  try {
    const airport = await nearestAirport(lat, lon);
    if (!airport) {
      res.status(404).json({ error: 'No airport with an instrument approach found' });
      return;
    }
    res.status(200).json(airport);
  } catch (err) {
    if (err instanceof DataUnavailableError) {
      res.status(503).json({ error: 'Airport data is still loading, try again shortly' });
      return;
    }
    throw err;
  }
}
