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
    // DZ_SENTRY_DEBUG=1 prints what the SDK sends, to check the setup.
    debug: process.env.DZ_SENTRY_DEBUG === "1",
    beforeBreadcrumb: () => null,
    beforeSend: scrubEvent,
  });
}

/** Times a block as a Sentry span. Callers pass only aggregate, name-free attributes. */
export async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return sentry ? sentry.startSpan({ name, op: "dz" }, fn) : fn();
}

export interface ModelCall {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Traces one model call as a Sentry AI span: model, token counts, whether an image
 * went in, and how long it took. Never the prompt or the reply, which hold file
 * contents. Cost is recorded as 0 because the model runs on this machine.
 */
export async function withModelSpan(
  model: string,
  hasImage: boolean,
  fn: () => Promise<ModelCall>,
): Promise<string> {
  if (!sentry) return (await fn()).text;
  return sentry.startSpan(
    {
      name: `chat ${model}`,
      op: "gen_ai.chat",
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.system": "ollama",
        "gen_ai.request.model": model,
        "dz.image_input": hasImage,
      },
    },
    async (span) => {
      const call = await fn();
      span.setAttributes({
        "gen_ai.usage.input_tokens": call.inputTokens ?? 0,
        "gen_ai.usage.output_tokens": call.outputTokens ?? 0,
        "gen_ai.usage.total_tokens": (call.inputTokens ?? 0) + (call.outputTokens ?? 0),
        "gen_ai.usage.cost_usd": 0,
      });
      return call.text;
    },
  );
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
