// Remote approval through Auth0 (Client-Initiated Backchannel Authentication).
// When Zee has a question, the daemon can also send it to the approver's phone as
// an Auth0 Guardian push, so a move can be approved while nobody is at the Mac.
//
// Only a short description leaves the machine ("Dropzone Zero: move 1 installer"),
// never a file name, path, or content. The Mac only makes outgoing requests to
// Auth0; nothing can connect to it. Off unless AUTH0_DOMAIN and friends are set.

export interface RemoteApprovalConfig {
  domain: string;
  clientId: string;
  clientSecret: string;
  /** The Auth0 user whose Guardian app gets the push, e.g. auth0|123abc. */
  approverUserId: string;
}

export type RemoteAnswer = "approved" | "denied" | "expired";

// Auth0 accepts up to 64 characters: letters, digits, spaces, and +-_.,:#
const MAX_MESSAGE = 64;

/** Makes text safe for Auth0's binding_message. */
export function bindingMessage(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9 +\-_.,:#]/g, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, MAX_MESSAGE).trim();
}

export function remoteApprovalFromEnv(env: NodeJS.ProcessEnv = process.env): RemoteApprovalConfig | null {
  const domain = env.AUTH0_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const clientId = env.AUTH0_CLIENT_ID?.trim();
  const clientSecret = env.AUTH0_CLIENT_SECRET?.trim();
  const approverUserId = env.AUTH0_APPROVER_USER_ID?.trim();
  if (!domain || !clientId || !clientSecret || !approverUserId) return null;
  return { domain, clientId, clientSecret, approverUserId };
}

export class RemoteApprovalError extends Error {
  override name = "RemoteApprovalError";
}

export class RemoteApprover {
  constructor(
    private readonly config: RemoteApprovalConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async post(path: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await this.fetchImpl(`https://${this.config.domain}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, body };
  }

  /**
   * Sends the push and waits for the answer. Resolves "expired" if nobody answers
   * in time or `signal` aborts (for example, the question was answered in Zee).
   */
  async ask(message: string, signal?: AbortSignal): Promise<RemoteAnswer> {
    const { domain, clientId, clientSecret, approverUserId } = this.config;
    const started = await this.post("/bc-authorize", {
      client_id: clientId,
      client_secret: clientSecret,
      login_hint: JSON.stringify({ format: "iss_sub", iss: `https://${domain}/`, sub: approverUserId }),
      scope: "openid",
      binding_message: bindingMessage(message),
      // 300 seconds or less makes Auth0 use the mobile push channel.
      requested_expiry: "300",
    });
    if (started.status !== 200 || typeof started.body.auth_req_id !== "string") {
      throw new RemoteApprovalError(`Auth0 refused the approval request: ${String(started.body.error_description ?? started.body.error ?? started.status)}`);
    }
    const requestId = started.body.auth_req_id;
    let interval = Number(started.body.interval ?? 5) * 1000;
    const until = Date.now() + Number(started.body.expires_in ?? 300) * 1000;

    while (Date.now() < until) {
      await this.sleep(interval);
      if (signal?.aborted) return "expired";
      const polled = await this.post("/oauth/token", {
        grant_type: "urn:openid:params:grant-type:ciba",
        auth_req_id: requestId,
        client_id: clientId,
        client_secret: clientSecret,
      });
      // The token itself is not needed: an approval is the answer.
      if (polled.status === 200) return "approved";
      const error = polled.body.error;
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        interval = Number(polled.body.interval ?? interval / 1000 + 5) * 1000;
        continue;
      }
      // Auth0 says access_denied both when the person declines and when the request
      // runs out; near the deadline it is taken as unanswered, so Zee keeps asking.
      if (error === "access_denied") return Date.now() >= until - 2 * interval ? "expired" : "denied";
      if (error === "expired_token") return "expired";
      throw new RemoteApprovalError(`Auth0 answered ${String(error ?? polled.status)}`);
    }
    return "expired";
  }
}
