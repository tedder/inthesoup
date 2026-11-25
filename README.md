# In the Soup ☁️

Find nearby instrument approaches in IMC.

> **Warning**
> This app should not be used as a replacement for safe preflight planning
> practices. All weather data is not guaranteed to be accurate, and the
> instrument approach data is not guaranteed to be complete. Always check the
> official sources before flying, especially when venturing into IMC.

## What is this?

This is a web app that allows you to search for nearby instrument approaches in
instrument meteorological conditions (IMC). It uses the [NOAA National Blend of Models][nbm]
to get cloud ceiling forecasts, and joins them with instrument approach data
from the FAA's [Coded Instrument Flight Procedures (CIFP)][cifp]. With this
information, pilots can more easily plan flights to improve their proficiency
flying in IMC.

[nbm]: https://blend.mdl.nws.noaa.gov/
[cifp]: https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/

## Infrastructure

This app uses [Google App Engine][gae] to host a Node.js server running
[Next.js][next]. The backend portion of the app is very simple, and just runs
a query against a few [Google BigQuery][bq] tables. Weather forecasts are
regularly fetched from NOAA using GitHub Actions and loaded into BigQuery.
Similarly, the FAA's CIFP data is periodically fetched by a GitHub Action and
loaded into BigQuery.

[gae]: https://cloud.google.com/appengine/
[next]: https://nextjs.org/
[bq]: https://cloud.google.com/bigquery/

## Self-hosting

`docker-compose.yml` runs the app without Google Cloud, using DuckDB over
Parquet files instead of BigQuery. Three services share one named volume
(`data`):

- `web`: the Next.js app (`DATA_BACKEND=duckdb`), reading the volume read-only.
- `weather`: runs `load_weather.py` at startup, then hourly at minute 45.
- `cifp`: runs `load_cifp.py` at startup if its data is missing or older than
  7 days, then weekly on Sunday at 00:00 UTC.

```sh
docker compose up -d --build
```

The first start takes about 2-3 minutes while both loaders download data;
`/api/health` returns 503 `loading` until then and 200 afterward. The app is
at http://localhost:5095 (change with `INTHESOUP_PORT`).

Settings are environment variables, set in the shell or a `.env` file next to
`docker-compose.yml`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `INTHESOUP_PORT` | `5095` | Host port for the web app |
| `WEATHER_SCHEDULE` | `45 * * * *` | Cron schedule (UTC) for the weather loader |
| `CIFP_SCHEDULE` | `0 0 * * 0` | Cron schedule (UTC) for the CIFP loader |
| `KUMA_PUSH_URL_WEATHER`, `KUMA_PUSH_URL_CIFP` | unset | Uptime Kuma push URLs, requested after each successful run |
| `DUCKDB_MEMORY_LIMIT` | `512MB` | DuckDB memory limit in the web app |
| `DUCKDB_THREADS` | `2` | DuckDB threads in the web app |
| `MAX_WEATHER_AGE_HOURS` | `3` | `/api/health` returns 503 when weather data is older |
| `MAX_CIFP_AGE_DAYS` | `35` | `/api/health` returns 503 when CIFP data is older |

A failed load is logged and retried at the next scheduled time; the previous
data stays in place. Logs (rotated at 3 x 10 MB per container):

```sh
docker compose logs -f weather cifp web
```

The web container's Docker healthcheck only checks that the server answers, so
stale data does not make the container unhealthy. Use `/api/health` for data
freshness monitoring.

To update, pull the new code and rebuild; the data volume is kept:

```sh
git pull
docker compose up -d --build
```

`docker compose down -v` also deletes the data volume. Loader details are in
[data/README.md](data/README.md).
