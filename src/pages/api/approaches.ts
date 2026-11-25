import { NextApiRequest, NextApiResponse } from 'next';
import { queryApproaches, DataUnavailableError, FORECAST_TYPES } from '../../lib/db';

type Airport = {
  icao: string;
  name: string;
  elevation: number;
  location: {
    lat: number;
    lng: number;
  };
  distance: number;
}

type Approach = {
  id: string;
  name: string;
  faf: {
    msl: number;
    agl: number;
  };
}

type Weather = {
  ceiling: number | null;
  lowest_cloud_base: number | null;
  wind_direction: number | null;
  wind_speed: number | null;
  visibility: number | null;
  temperature: number | null;
  dewpoint: number | null;
  prob_ifr: number | null;
}

type Data = {
  time: Date;
  airport: Airport;
  weather: Weather;
  approaches: Approach[];
}[];

type Error = {
  error: string;
}

const approachIdToName = (id: string) => {
  const secondChar = id[1];

  // If second char is a number, it's a runway
  if (secondChar >= '0' && secondChar <= '9') {
    const type = id[0];
    const runway = id.slice(1, 4).replace('-', '');
    const suffix = id[4];

    switch (type) {
      case 'I':
        return `ILS${suffix ? ' ' + suffix : ''} RWY ${runway}`;
      case 'L':
        return `LOC${suffix ? ' ' + suffix : ''} RWY ${runway}`;
      case 'B':
        return `LOC BC${suffix ? ' ' + suffix : ''} RWY ${runway}`;
      case 'R':
        return `RNAV (GPS)${suffix ? ' ' + suffix : ''} RWY ${runway}`;
      case 'H':
        return `RNAV (RNP)${suffix ? ' ' + suffix : ''} RWY ${runway}`;
      case 'P':
        return `GPS${suffix ? ' ' + suffix : ''} RWY ${runway}`;
      case 'S':
        return `VOR${suffix ? ' ' + suffix : ''} RWY ${runway}`;
      case 'D':
        return `VOR/DME${suffix ? ' ' + suffix : ''} RWY ${runway}`;
      case 'V':
        return `VOR${suffix ? ' ' + suffix : ''} RWY ${runway}`;
      case 'X':
        return `LDA${suffix ? ' ' + suffix : ''} RWY ${runway}`;
      case 'Q':
      case 'N':
        return `NDB${suffix ? ' ' + suffix : ''} RWY ${runway}`;
      default:
        return id;
    }
  } else {
    const type = id.slice(0, 3);
    const suffix = id.slice(3);

    switch (type) {
      case 'RNV':
        return `RNAV (GPS)${suffix}`;
      case 'VDM':
        return `VOR/DME${suffix}`;
      case 'LBC':
        return `LOC BC${suffix}`;
    }

    return id;
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data | Error>
) {
  const airport = req.query.airport as string;
  const radius = Number(req.query.radius);
  const minCeiling = Number(req.query.minCeiling) || 0;
  const startHour = Number(req.query.startHour) || 0;
  const endHour = Number(req.query.endHour) || 23;
  const forecast = (Array.isArray(req.query.forecast) ? req.query.forecast[0] : req.query.forecast) ?? 'nbh';

  if (!airport || !radius) {
    res.status(400).json({ error: 'Missing required query parameters' });
    return;
  }

  if (radius < 0 || radius > 500) {
    res.status(400).json({ error: 'Radius must be between 0 and 500' });
    return;
  }

  if (!FORECAST_TYPES.includes(forecast)) {
    res.status(400).json({ error: 'Forecast must be METAR, TAF, NBH or NBS' });
    return;
  }

  let rows;
  try {
    rows = await queryApproaches({ airport, radius, minCeiling, startHour, endHour, forecast });
  } catch (err) {
    if (err instanceof DataUnavailableError) {
      res.status(503).json({ error: err.message });
      return;
    }
    throw err;
  }

  const response = rows.map(row => ({
    time: new Date(row.Time),
    airport: {
      icao: row.Airport_Identifier,
      name: row.Airport_Name,
      elevation: row.Airport_Elevation,
      location: {
        lat: row.Latitude,
        lng: row.Longitude,
      },
      distance: row.Distance_NM,
    },
    weather: {
      ceiling: row.CIG != null && row.CIG >= 0 ? row.CIG : null,
      lowest_cloud_base: row.LCB != null && row.LCB >= 0 ? row.LCB : null,
      wind_direction: row.WDR,
      wind_speed: row.WSP,
      visibility: row.VIS,
      temperature: row.TMP,
      dewpoint: row.DPT,
      prob_ifr: row.IFC,
    },
    approaches: row.Approach_Identifier.map((id: string, i: number) => ({
      id,
      name: row.Approach_Name[i] || approachIdToName(id),
      chart: row.PDF_Name[i] || null,
      faf: {
        msl: row.FAF_MSL[i],
        agl: row.FAF_AGL[i],
      }
    } as Approach)),
  }));

  // Remove duplicate approaches (based on the name field)
  response.forEach(row => {
    const uniqueApproaches = new Map<string, Approach>();
    row.approaches.forEach((approach: any) => {
      uniqueApproaches.set(approach.name, approach);
    });
    row.approaches = Array.from(uniqueApproaches.values());
  });

  res.status(200).json(response);
}
