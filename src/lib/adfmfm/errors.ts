// Common base for every domain error this module throws, so a caller can
// distinguish "your input is bad" (catch AdfmfmError) from a bug elsewhere
// (an error that is not an AdfmfmError). See README for the rationale.
export class AdfmfmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdfmfmError';
  }
}
