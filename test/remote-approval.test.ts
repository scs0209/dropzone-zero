import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bindingMessage, RemoteApprovalError, RemoteApprover, remoteApprovalFromEnv } from "../src/remote-approval.js";

const config = { domain: "tenant.example.auth0.com", clientId: "client", clientSecret: "secret", approverUserId: "auth0|me" };

/** A fake Auth0: answers /bc-authorize, then each /oauth/token poll from the script. */
function fakeAuth0(polls: { status: number; body: object }[], start: { status: number; body: object } = { status: 200, body: { auth_req_id: "req", expires_in: 300, interval: 5 } }) {
  const calls: { path: string; form: URLSearchParams }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, form: new URLSearchParams(String(init?.body)) });
    const answer = path === "/bc-authorize" ? start : (polls.shift() ?? { status: 400, body: { error: "authorization_pending" } });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const noWait = async () => {};

describe("remote approval (Auth0 CIBA)", () => {
  it("is off unless every setting is there", () => {
    assert.equal(remoteApprovalFromEnv({ AUTH0_DOMAIN: "x.auth0.com" }), null);
    const on = remoteApprovalFromEnv({ AUTH0_DOMAIN: "https://x.auth0.com/", AUTH0_CLIENT_ID: "c", AUTH0_CLIENT_SECRET: "s", AUTH0_APPROVER_USER_ID: "auth0|u" });
    assert.equal(on?.domain, "x.auth0.com");
  });

  it("keeps the push text within Auth0's rules", () => {
    assert.equal(bindingMessage("Dropzone Zero: move 1 installer"), "Dropzone Zero: move 1 installer");
    assert.equal(bindingMessage("café → résumé!"), "caf rsum");
    assert.ok(bindingMessage("x".repeat(100)).length <= 64);
  });

  it("asks the approver by user ID and waits for an approval", async () => {
    const auth0 = fakeAuth0([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { access_token: "token" } },
    ]);
    const answer = await new RemoteApprover(config, auth0.fetchImpl, noWait).ask("Dropzone Zero: move 1 installer");
    assert.equal(answer, "approved");
    const start = auth0.calls[0]!;
    assert.equal(start.path, "/bc-authorize");
    assert.deepEqual(JSON.parse(start.form.get("login_hint")!), { format: "iss_sub", iss: "https://tenant.example.auth0.com/", sub: "auth0|me" });
    assert.equal(start.form.get("binding_message"), "Dropzone Zero: move 1 installer");
    assert.equal(start.form.get("requested_expiry"), "300");
    assert.equal(auth0.calls[2]!.form.get("grant_type"), "urn:openid:params:grant-type:ciba");
  });

  it("reports a decline, and backs off when told to slow down", async () => {
    const waits: number[] = [];
    const auth0 = fakeAuth0([
      { status: 400, body: { error: "slow_down", interval: 10 } },
      { status: 403, body: { error: "access_denied" } },
    ]);
    const answer = await new RemoteApprover(config, auth0.fetchImpl, async (ms) => void waits.push(ms)).ask("x");
    assert.equal(answer, "denied");
    assert.deepEqual(waits, [5_000, 10_000]);
  });

  it("stops quietly once the question is answered elsewhere", async () => {
    const asking = new AbortController();
    asking.abort();
    const answer = await new RemoteApprover(config, fakeAuth0([]).fetchImpl, noWait).ask("x", asking.signal);
    assert.equal(answer, "expired");
  });

  it("says why Auth0 refused to send the push", async () => {
    const auth0 = fakeAuth0([], { status: 400, body: { error: "invalid_request", error_description: "Push notifications not enabled on tenant" } });
    await assert.rejects(new RemoteApprover(config, auth0.fetchImpl, noWait).ask("x"), (error: Error) => error instanceof RemoteApprovalError && /not enabled/.test(error.message));
  });
});
