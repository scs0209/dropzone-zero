import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { DefaultLogger, NativeConnection, Runtime, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";

export const TASK_QUEUE = "dropzone-zero";
export const DEFAULT_TEMPORAL_ADDRESS = "127.0.0.1:7233";

export function temporalAddress(): string {
  return process.env.TEMPORAL_ADDRESS ?? DEFAULT_TEMPORAL_ADDRESS;
}

export class TemporalUnavailableError extends Error {
  override name = "TemporalUnavailableError";
}

function unavailable(): TemporalUnavailableError {
  return new TemporalUnavailableError(
    `Cannot reach Temporal at ${temporalAddress()}. Start a local server with \`temporal server start-dev\`.`,
  );
}

export async function connectClient(): Promise<Client> {
  try {
    const connection = await Connection.connect({ address: temporalAddress(), connectTimeout: "3 seconds" });
    return new Client({ connection });
  } catch {
    throw unavailable();
  }
}

let runtimeInstalled = false;

/** A worker that runs Dropzone Zero's workflows and file steps in this process. */
export async function createWorker(): Promise<Worker> {
  if (!runtimeInstalled) {
    // The SDK logs every bundling and state change at INFO; keep the CLI output to what the user needs.
    Runtime.install({ logger: new DefaultLogger("WARN") });
    runtimeInstalled = true;
  }
  let connection: NativeConnection;
  try {
    connection = await NativeConnection.connect({ address: temporalAddress() });
  } catch {
    throw unavailable();
  }
  // Works both from source (tsx, .ts) and from the build (.js).
  const ext = extname(fileURLToPath(import.meta.url));
  return Worker.create({
    connection,
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL(`./workflows${ext}`, import.meta.url)),
    activities,
  });
}

export function workflowUrl(workflowId: string): string {
  const host = temporalAddress().split(":")[0];
  return `http://${host === "127.0.0.1" ? "localhost" : host}:8233/namespaces/default/workflows/${workflowId}`;
}
