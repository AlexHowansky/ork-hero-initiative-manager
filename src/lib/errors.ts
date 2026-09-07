/**
 * Application errors.
 *
 * Route handlers throw `AppError` with a message that is already safe and
 * meaningful to show a user. Anything else that escapes a handler is logged in
 * full server-side and reported to the client as a single generic message, so an
 * internal failure can never leak implementation detail.
 */

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "rate_limited"
  | "internal";

const statusByCode: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Extra context for the log line only — never sent to the client. */
  readonly context?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = statusByCode[code];
    this.context = context;
  }
}

export const errors = {
  badRequest: (message: string, context?: Record<string, unknown>) =>
    new AppError("bad_request", message, context),
  unauthorized: (message = "Please sign in to continue.") =>
    new AppError("unauthorized", message),
  forbidden: (message = "You don't have permission to do that.") =>
    new AppError("forbidden", message),
  notFound: (message = "We couldn't find what you were looking for.") =>
    new AppError("not_found", message),
  conflict: (message: string) => new AppError("conflict", message),
  tooLarge: (message: string) => new AppError("payload_too_large", message),
  rateLimited: (message = "Too many attempts. Please wait a moment and try again.") =>
    new AppError("rate_limited", message),
  /**
   * A failure on our side that a person can still do something about.
   *
   * Anything else that escapes a handler becomes `GENERIC_ERROR_MESSAGE`, which
   * is right for a failure the reader cannot act on. This is for the ones they
   * can — a character whose sheet will not build is fixed by re-exporting it,
   * and saying so beats "something went wrong on our end".
   */
  internal: (message: string, context?: Record<string, unknown>) =>
    new AppError("internal", message, context),
};

export const GENERIC_ERROR_MESSAGE =
  "Something went wrong on our end. Please try again.";
