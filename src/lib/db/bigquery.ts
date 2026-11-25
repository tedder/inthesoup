import { BigQuery } from '@google-cloud/bigquery';
import type { ApproachParams, ApproachRow, NearestAirport } from './types';

const bigquery = new BigQuery({ projectId: 'inthesoup' });

const baseQuery = `WITH
  NearAirport AS (
    SELECT
      ST_GEOGPOINT(Longitude, Latitude) AS point
    FROM
      \`inthesoup.aeronautical.airport\`
    WHERE
      Airport_ICAO_Identifier = @airport
  ),
  FAF_Airport AS (
    SELECT
      faf.*,
      apt.Latitude,
      apt.Longitude,
      apt.Airport_Elevation,
      ST_DISTANCE(ST_GEOGPOINT(apt.Longitude, apt.Latitude), (SELECT point FROM NearAirport)) * 0.000539957 AS Distance_NM
    FROM
      \`inthesoup.aeronautical.faf\` AS faf
    INNER JOIN
      \`inthesoup.aeronautical.airport\` AS apt
    ON
      faf.Airport_Identifier = apt.Airport_ICAO_Identifier
  ),
  Filtered_FAF_Airport AS (
    SELECT
      *
    FROM
      FAF_Airport
    WHERE
      Distance_NM < @radius
  )
SELECT
  wx.Time AS Time,
  apt.Airport_ICAO_Identifier AS Airport_Identifier,
  ANY_VALUE(apt.Airport_Name) AS Airport_Name,
  ANY_VALUE(apt.Airport_Elevation) AS Airport_Elevation,
  CAST(ANY_VALUE(wx.CIG) * 100 as INT) AS CIG,
  CAST(ANY_VALUE(wx.LCB) * 100 as INT) AS LCB,
  CAST(ANY_VALUE(wx.WDR) * 10 as INT) AS WDR,
  ROUND(ANY_VALUE(wx.VIS) / 10) AS VIS,
  ROUND((ANY_VALUE(wx.TMP) - 32) * 5/9) AS TMP,
  ROUND((ANY_VALUE(wx.DPT) - 32) * 5/9) AS DPT,
  ANY_VALUE(wx.WSP) AS WSP,
  SAFE_CAST(ANY_VALUE(wx.IFC) AS FLOAT64) / 100 AS IFC,
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
  \`inthesoup.aeronautical.airport\` AS apt
ON
  Filtered_FAF_Airport.Airport_Identifier = apt.Airport_ICAO_Identifier
INNER JOIN
  (
    SELECT
      *[EXTRA_COLUMNS]
    FROM
      \`inthesoup.weather.[FORECAST_TYPE]\`
  ) AS wx
ON
  Filtered_FAF_Airport.Airport_Identifier = wx.Location
WHERE
  wx.CIG != -88
  AND (wx.CIG * 100) <= (Filtered_FAF_Airport.Altitude - apt.Airport_Elevation)
  AND wx.CIG >= @minCeiling
  AND (
    (
      @startHour <= @endHour AND
      EXTRACT(HOUR FROM wx.Time) >= @startHour AND
      EXTRACT(HOUR FROM wx.Time) <= @endHour
    )
    OR
    (
      @startHour > @endHour AND
      (
        EXTRACT(HOUR FROM wx.Time) >= @startHour OR
        EXTRACT(HOUR FROM wx.Time) <= @endHour
      )
    )
  )
GROUP BY wx.Time, apt.Airport_ICAO_Identifier
ORDER BY
  ANY_VALUE(Filtered_FAF_Airport.Distance_NM) ASC,
  wx.Time ASC;`

export async function queryApproaches(params: ApproachParams): Promise<ApproachRow[]> {
  const { forecast, ...queryParams } = params;

  // TAFs have no temperature/dewpoint; add null columns so every source
  // shares the weather column set the SELECT list expects.
  const extraColumns = forecast === 'taf'
    ? ', NULL AS TMP, NULL AS DPT'
    : '';

  const query = baseQuery
    .replace('[FORECAST_TYPE]', forecast)
    .replace('[EXTRA_COLUMNS]', extraColumns)

  const [rows] = await bigquery.query({ query, params: queryParams });

  // BigQuery returns TIMESTAMP as { value: string }; normalize to a string.
  return rows.map((row: any) => ({ ...row, Time: row.Time.value }));
}

const nearestQuery = `SELECT
  Airport_ICAO_Identifier AS icao,
  Airport_Name AS name,
  ST_DISTANCE(ST_GEOGPOINT(Longitude, Latitude), ST_GEOGPOINT(@lon, @lat)) * 0.000539957 AS distance_nm
FROM
  \`inthesoup.aeronautical.airport\`
WHERE
  Airport_ICAO_Identifier IN (SELECT DISTINCT Airport_Identifier FROM \`inthesoup.aeronautical.faf\`)
ORDER BY
  distance_nm ASC, icao ASC
LIMIT 1`;

export async function nearestAirport(lat: number, lon: number): Promise<NearestAirport | null> {
  const [rows] = await bigquery.query({ query: nearestQuery, params: { lat, lon } });
  return rows.length ? (rows[0] as NearestAirport) : null;
}
