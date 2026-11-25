"""
Shared local-file output for the loaders (--output-dir / --format).

Every file is written to a hidden temp file in the same directory and then moved
into place with os.replace(), so readers never see a partial file. A status JSON
is written last, only after every table file has been replaced.
"""

import json
import os
from datetime import datetime, timezone

import pandas as pd

TIME_COLUMNS = ['Time', 'Forecast_Time']


def utc_columns(frame):
  """Copy of frame with Time/Forecast_Time as tz-aware UTC (naive means UTC)."""
  frame = frame.copy()
  for column in TIME_COLUMNS:
    if column in frame.columns:
      frame[column] = pd.to_datetime(frame[column], utc=True).astype('datetime64[ns, UTC]')
  return frame


def iso_utc(value):
  if value is None or pd.isna(value):
    return None
  return pd.Timestamp(value).tz_convert('UTC').strftime('%Y-%m-%dT%H:%M:%SZ')


def replace_json(path, data):
  tmp = os.path.join(os.path.dirname(path), '.' + os.path.basename(path) + '.tmp')
  try:
    with open(tmp, 'w') as handle:
      json.dump(data, handle, indent=2)
      handle.write('\n')
    os.replace(tmp, path)
  finally:
    if os.path.exists(tmp):
      os.remove(tmp)


def write_tables(output_dir, tables, fmt, status_name, extra=None, source_time=False):
  """Write {table: DataFrame} as <table>.<fmt> files, then <status_name>."""
  if fmt not in ('csv', 'parquet'):
    raise ValueError(f'Unsupported output format: {fmt}')
  os.makedirs(output_dir, exist_ok=True)
  temps = {}
  try:
    # Write every temp file first so a failure leaves all final files untouched.
    for table, frame in tables.items():
      final = os.path.join(output_dir, f'{table}.{fmt}')
      tmp = os.path.join(output_dir, f'.{table}.{fmt}.tmp')
      temps[tmp] = final
      if fmt == 'parquet':
        # Microsecond timestamps: DuckDB cannot EXTRACT from the nanosecond type pandas writes.
        utc_columns(frame).to_parquet(tmp, index=False, coerce_timestamps='us')
      else:
        frame.to_csv(tmp, index=False)
    for tmp, final in list(temps.items()):
      os.replace(tmp, final)
      del temps[tmp]
      print(f'Wrote {final}', flush=True)
  finally:
    for tmp in temps:
      if os.path.exists(tmp):
        os.remove(tmp)

  status_tables = {}
  for table, frame in tables.items():
    entry = {'rows': len(frame)}
    if source_time:
      latest = pd.to_datetime(frame.Forecast_Time, utc=True).max() if len(frame) else None
      entry['latest_source_time'] = iso_utc(latest)
    status_tables[table] = entry
  status = {'finished_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'format': fmt}
  status.update(extra or {})
  status['tables'] = status_tables
  replace_json(os.path.join(output_dir, status_name), status)
