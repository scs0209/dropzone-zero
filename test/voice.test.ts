import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spokenQuestion, spokenSummary, Voice, voiceFromEnv } from "../src/voice.js";

describe("Zee's voice", () => {
  it("says what was filed by kind and count, never by name", () => {
    assert.equal(spokenSummary([{ to: "Finance/Receipts/2026-10/2026-10-14-bluebird-coffee-receipt.pdf" }]), "Filed a receipt.");
    const text = spokenSummary([
      { to: "Finance/Receipts/2026-10/a.pdf" },
      { to: "Finance/Receipts/2026-10/b.pdf" },
      { to: "Photos/2026-10/img-2034.png" },
      { to: ".dropzone/quarantine/~$draft.tmp" },
    ]);
    assert.equal(text, "Filed four downloads: two receipts, a photo and a duplicate or temp file.");
    assert.doesNotMatch(text, /bluebird|img-2034|draft/);
    assert.equal(spokenSummary([{ to: "Installers/notely.dmg" }]), "Filed an installer.");
    assert.equal(spokenSummary([]), "");
  });

  it("asks without naming the file", () => {
    assert.equal(spokenQuestion(["installer"]), "I need your OK on an installer.");
    assert.equal(spokenQuestion([null, null, null]), "I need your OK on three files.");
  });

  it("is off unless asked for and given a key", () => {
    assert.equal(voiceFromEnv({ ELEVENLABS_API_KEY: "k" }), null);
    assert.equal(voiceFromEnv({ DZ_VOICE: "on" }), null);
    assert.equal(voiceFromEnv({ DZ_VOICE: "on", ELEVENLABS_API_KEY: "k" })?.apiKey, "k");
  });

  it("asks ElevenLabs once per sentence and plays the cached audio after that", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "dz-voice-"));
    const requests: { url: string; body: { text: string; model_id: string }; key: string | null }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("xi-api-key") });
      return new Response(new Uint8Array([0xff, 0xfb, 0x90]), { status: 200 });
    }) as typeof fetch;
    const played: string[] = [];
    const voice = new Voice({ apiKey: "key", cacheDir }, fetchImpl, async (file) => void played.push(file));
    await voice.say("Filed a receipt.");
    await voice.say("Filed a receipt.");
    assert.equal(requests.length, 1);
    assert.match(requests[0]!.url, /\/v1\/text-to-speech\/\w+\?output_format=mp3_44100_128$/);
    assert.deepEqual(requests[0]!.body, { text: "Filed a receipt.", model_id: "eleven_flash_v2_5" });
    assert.equal(requests[0]!.key, "key");
    assert.equal(played.length, 2);
    assert.equal(played[0], played[1]);
  });

  it("never throws when ElevenLabs is unreachable", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "dz-voice-"));
    const failing = (async () => new Response("quota exceeded", { status: 401 })) as unknown as typeof fetch;
    const played: string[] = [];
    await new Voice({ apiKey: "key", cacheDir }, failing, async (file) => void played.push(file)).say("Filed a photo.");
    assert.equal(played.length, 0);
  });
});
