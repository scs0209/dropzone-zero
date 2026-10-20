import { CLASSIFICATION_SCHEMA, type ModelClient } from "./classify.js";

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
// Gemma 4 E4B: Apache 2.0, multimodal, and small enough for a laptop. Tagged explicitly
// so a future change to "latest" cannot silently swap the model under the plan.
export const DEFAULT_MODEL = "gemma4:e4b";

export interface OllamaOptions {
  host?: string;
  model?: string;
  timeoutMs?: number;
}

export class OllamaUnavailableError extends Error {}

/** Minimal client for Ollama's local HTTP API. Requests never leave this machine by default. */
export class OllamaClient implements ModelClient {
  readonly host: string;
  readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaOptions = {}) {
    this.host = (options.host ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST).replace(/\/+$/, "");
    this.model = options.model ?? process.env.DZ_MODEL ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** Fails with setup instructions when the server is down or the model is not pulled. */
  async ensureReady(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    } catch {
      throw new OllamaUnavailableError(
        `Cannot reach Ollama at ${this.host}. Start it with \`ollama serve\` (or open the Ollama app).`,
      );
    }
    const { models = [] } = (await response.json()) as { models?: { name: string }[] };
    const wanted = this.model.includes(":") ? this.model : `${this.model}:latest`;
    if (!models.some((m) => m.name === wanted)) {
      throw new OllamaUnavailableError(`Model ${this.model} is not pulled. Run \`ollama pull ${this.model}\`.`);
    }
  }

  async generate(prompt: string): Promise<string> {
    const response = await fetch(`${this.host}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        format: CLASSIFICATION_SCHEMA,
        // Gemma 4 thinks by default; for a one-file classification that costs ~15x the time for no gain.
        think: false,
        options: { temperature: 0 },
      }),
    });
    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}: ${await response.text()}`);
    }
    const { response: text } = (await response.json()) as { response?: string };
    return text ?? "";
  }
}
