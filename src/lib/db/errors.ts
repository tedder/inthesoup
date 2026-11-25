// Thrown when the backing data is missing or not readable yet (for example the
// loaders have not produced their first Parquet files). Maps to HTTP 503.
export class DataUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataUnavailableError';
  }
}
