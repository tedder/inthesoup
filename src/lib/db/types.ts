// Nearest airport with at least one instrument approach in the FAF table.
export type NearestAirport = {
  icao: string;
  name: string;
  distance_nm: number;
};

export type ApproachParams = {
  airport: string;
  radius: number;
  minCeiling: number;
  startHour: number;
  endHour: number;
  forecast: string;
};

// One row per (forecast time, airport). The array columns are parallel arrays
// with one entry per approach. Time is always an ISO 8601 string.
export type ApproachRow = {
  Time: string;
  Airport_Identifier: string;
  Airport_Name: string;
  Airport_Elevation: number;
  CIG: number | null;
  LCB: number | null;
  WDR: number | null;
  VIS: number | null;
  TMP: number | null;
  DPT: number | null;
  WSP: number | null;
  IFC: number | null;
  Approach_Identifier: string[];
  Approach_Name: string[];
  PDF_Name: string[];
  FAF_MSL: number[];
  FAF_AGL: number[];
  Latitude: number;
  Longitude: number;
  Distance_NM: number;
};
