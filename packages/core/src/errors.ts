/** Thrown when a user's limit is reached; the message is safe to show to that user. */
export class QuotaError extends Error {}

/** Thrown when the server has too much queued work to take more right now. */
export class BusyError extends Error {}
