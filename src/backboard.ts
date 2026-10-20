import type { ModelClient } from "./classify.js";

// A ModelClient for Backboard (backboard.io): one API key, many models. Used by
// `dz eval --provider backboard` to compare open-weight models on the synthetic
// eval set. Only synthetic cases are ever sent; real files stay on the machine.
//
// Backboard keeps conversations as assistants and threads. A run creates one
// assistant, uses a fresh thread per case (so cases never see each other), deletes
// each thread after use, and deletes the assistant at the end.

const BASE_URL = "https://app.backboard.io/api";

export class BackboardRunError extends Error {
  override name = "BackboardRunError";
}

export interface BackboardOptions {
  apiKey: string;
  /** e.g. "openrouter" */
  provider: string;
  /** e.g. "google/gemma-4-31b-it" */
  model: string;
  timeoutMs?: number;
}

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated from Backboard's published per-token prices for the model. */
  costUsd: number | null;
}

export class BackboardClient implements ModelClient {
  private assistantId: string | null = null;
  private prices: { input: number; output: number } | null = null;
  readonly usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null };

  constructor(private readonly options: BackboardOptions) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: { "X-API-Key": this.options.apiKey, "content-type": "application/json", ...init.headers },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 90_000),
      });
      // Rate limits and hiccups get two more tries with a short backoff.
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 2_000 * (attempt + 1)));
        continue;
      }
      return response;
    }
  }

  async init(): Promise<void> {
    const models = await this.request(`/models?provider=${encodeURIComponent(this.options.provider)}&limit=2000`);
    if (!models.ok) throw new Error(`Backboard returned HTTP ${models.status} listing models. Is BACKBOARD_API_KEY right?`);
    const { models: list = [] } = (await models.json()) as {
      models?: { name: string; input_cost_per_1m_tokens?: number | null; output_cost_per_1m_tokens?: number | null }[];
    };
    const model = list.find((m) => m.name === this.options.model);
    if (!model) throw new Error(`Backboard has no model ${this.options.provider}:${this.options.model}.`);
    if (model.input_cost_per_1m_tokens != null && model.output_cost_per_1m_tokens != null) {
      this.prices = { input: model.input_cost_per_1m_tokens, output: model.output_cost_per_1m_tokens };
      this.usage.costUsd = 0;
    }

    const created = await this.request("/assistants", {
      method: "POST",
      body: JSON.stringify({ name: "dropzone-zero eval (synthetic data only)" }),
    });
    if (!created.ok) throw new Error(`Backboard returned HTTP ${created.status} creating an assistant.`);
    this.assistantId = ((await created.json()) as { assistant_id: string }).assistant_id;
  }

  async generate(prompt: string, images?: string[]): Promise<string> {
    if (images?.length) throw new Error("The Backboard eval sends text only.");
    if (!this.assistantId) await this.init();
    const response = await this.request("/threads/messages", {
      method: "POST",
      body: JSON.stringify({
        content: prompt,
        assistant_id: this.assistantId,
        llm_provider: this.options.provider,
        model_name: this.options.model,
        system_prompt: "You sort files. Reply with exactly one JSON object and nothing else.",
        json_output: true,
        memory: "off",
        stream: false,
      }),
    });
    if (!response.ok) throw new Error(`Backboard returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = (await response.json()) as {
      content?: string;
      status?: string;
      thread_id?: string;
      input_tokens?: number;
      output_tokens?: number;
    };
    // Backboard answers HTTP 200 even when the run fails (no credit, provider error);
    // the reason is in `content`. That is not model output, so stop instead of scoring it.
    if (body.status && body.status !== "COMPLETED") {
      if (body.thread_id) await this.request(`/threads/${body.thread_id}`, { method: "DELETE" }).catch(() => {});
      throw new BackboardRunError(`Backboard run ${body.status}: ${(body.content ?? "").slice(0, 300)}`);
    }
    this.usage.calls++;
    this.usage.inputTokens += body.input_tokens ?? 0;
    this.usage.outputTokens += body.output_tokens ?? 0;
    if (this.prices) {
      this.usage.costUsd =
        (this.usage.inputTokens * this.prices.input + this.usage.outputTokens * this.prices.output) / 1_000_000;
    }
    if (body.thread_id) await this.request(`/threads/${body.thread_id}`, { method: "DELETE" }).catch(() => {});
    return body.content ?? "";
  }

  /** Deletes the run's assistant. */
  async close(): Promise<void> {
    if (this.assistantId) await this.request(`/assistants/${this.assistantId}`, { method: "DELETE" }).catch(() => {});
    this.assistantId = null;
  }
}
