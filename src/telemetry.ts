// Optional Sentry reporting. Off unless SENTRY_DSN is set, and even then only
// aggregate counts, timings, and scrubbed errors leave the machine: never file
// names, paths, or contents.
import type { ErrorEvent } from "@sentry/node";

type Sentry = typeof import("@sentry/node");
let sentry: Sentry | null = null;

const PATH_PATTERN = /(?:~|[A-Za-z]:)?(?:[\\/][^\s'"`,;:()]+)+/g;

/** Replaces anything that looks like a file path with a placeholder. */
export function scrubText(text: string): string {
  return text.replace(PATH_PATTERN, "<path>");
}

/** Strips everything from an error event except the error type, a scrubbed message, and function names. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.request;
  delete event.breadcrumbs;
  delete event.extra;
  delete event.user;
  delete event.server_name;
  if (event.message) event.message = scrubText(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      // Absolute paths reveal the user's home folder; the module name is enough to debug.
      if (frame.filename) frame.filename = frame.filename.split(/[\\/]/).pop();
      delete frame.abs_path;
      delete frame.vars;
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
    }
  }
  return event;
}

export async function initTelemetry(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  sentry = await import("@sentry/node");
  sentry.init({
    dsn,
    // Collect no user, cookie, header, body, or query data, and no hostname.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    includeServerName: false,
    // Default integrations add console and HTTP breadcrumbs, which would carry file names.
    defaultIntegrations: false,
    tracesSampleRate: 1,
    beforeBreadcrumb: () => null,
    beforeSend: scrubEvent,
  });
}

/** Times a block as a Sentry span. Callers pass only aggregate, name-free attributes. */
export async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return sentry ? sentry.startSpan({ name, op: "dz" }, fn) : fn();
}

export function recordCounts(prefix: string, counts: Record<string, number>): void {
  if (!sentry) return;
  for (const [key, value] of Object.entries(counts)) sentry.metrics.count(`${prefix}.${key}`, value);
}

export function recordDuration(name: string, ms: number): void {
  sentry?.metrics.distribution(name, ms, { unit: "millisecond" });
}

export function captureError(error: unknown): void {
  sentry?.captureException(error);
}

export async function flushTelemetry(): Promise<void> {
  await sentry?.flush(2_000);
}
