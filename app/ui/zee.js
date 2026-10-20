// Zee's window: polls the local Dropzone Zero daemon and turns clicks into
// requests. It never touches files itself.

const $ = (id) => document.getElementById(id);
const zee = $("zee");
const bubble = $("bubble");

let api = null;
let lastMood = "";
let autoOpenedFor = "";
// Lists are rebuilt only when their content changes, so a click is never lost to a redraw.
let drawnPending = "";
let drawnRecent = "";

/** Port and token come from the daemon's info file (read by the Tauri side), or the URL when previewed in a browser. */
async function connect() {
  const tauri = window.__TAURI__;
  if (tauri) {
    const info = JSON.parse(await tauri.core.invoke("daemon_info"));
    return { base: `http://127.0.0.1:${info.port}`, token: info.token };
  }
  const params = new URLSearchParams(location.search);
  return { base: `http://127.0.0.1:${params.get("port")}`, token: params.get("token") };
}

async function call(method, path, body) {
  const res = await fetch(`${api.base}${path}`, {
    method,
    headers: { "x-dz-token": api.token, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
  return res.json();
}

function setMood(mood) {
  zee.className = mood;
  document.body.className = mood;
  $("badge").textContent = mood === "paused" ? "II" : mood === "dizzy" ? "?" : "";
}

function render(state) {
  setMood(state.mood);
  $("badge").textContent = state.mood === "asking" ? String(state.pending.length) : $("badge").textContent;
  $("message").textContent = state.message;
  $("pause").textContent = state.mood === "paused" ? "Resume" : "Pause";

  const pendingKey = JSON.stringify(state.pending);
  if (pendingKey !== drawnPending) {
    drawnPending = pendingKey;
    drawPending(state.pending);
  }
  const recent = state.recent.filter((m) => m.current).slice(0, 5);
  const recentKey = JSON.stringify(recent);
  if (recentKey !== drawnRecent) {
    drawnRecent = recentKey;
    drawRecent(recent);
  }

  // Open the bubble once by itself when a new question comes in; after that the person decides.
  const question = state.pending.map((p) => p.id).join(",");
  if (state.mood === "asking" && question !== autoOpenedFor) {
    autoOpenedFor = question;
    bubble.hidden = false;
  }
  lastMood = state.mood;
}

function drawPending(decisions) {
  $("pending").replaceChildren(
    ...decisions.map((decision) => {
      const li = document.createElement("li");
      const title = Object.assign(document.createElement("div"), { className: "title", textContent: decision.title });
      const detail = Object.assign(document.createElement("div"), { className: "detail", textContent: decision.detail });
      const actions = Object.assign(document.createElement("div"), { className: "actions" });
      const yes = Object.assign(document.createElement("button"), { className: "yes", type: "button", textContent: "Move it" });
      const no = Object.assign(document.createElement("button"), { type: "button", textContent: "Leave it" });
      yes.onclick = () => decide(decision.id, true, [yes, no]);
      no.onclick = () => decide(decision.id, false, [yes, no]);
      actions.append(yes, no);
      li.append(title, detail, actions);
      return li;
    }),
  );

}

function drawRecent(recent) {
  $("recent-title").hidden = recent.length === 0;
  $("recent").replaceChildren(
    ...recent.map((move) => {
      const li = document.createElement("li");
      const button = Object.assign(document.createElement("button"), { type: "button", title: "Show in Finder" });
      const from = Object.assign(document.createElement("div"), { textContent: move.from });
      const to = Object.assign(document.createElement("div"), { className: "to", textContent: `→ ${move.to}` });
      button.append(from, to);
      button.disabled = !move.present;
      button.onclick = () => call("POST", "/reveal", { to: move.to }).catch(showError);
      li.append(button);
      return li;
    }),
  );
}

function showError(error) {
  setMood("dizzy");
  $("message").textContent = error instanceof Error ? error.message : String(error);
  bubble.hidden = false;
}

async function decide(id, approve, buttons) {
  for (const b of buttons) b.disabled = true;
  try {
    render(await call("POST", "/decide", { id, approve }));
  } catch (error) {
    showError(error);
  }
}

async function poll() {
  try {
    api ??= await connect();
    render(await call("GET", "/state"));
  } catch (error) {
    api = null;
    showError(error);
  }
}

zee.addEventListener("click", () => {
  bubble.hidden = !bubble.hidden;
});

$("undo").addEventListener("click", async () => {
  if (!confirm("Put back everything the last run moved?")) return;
  try {
    render(await call("POST", "/undo"));
  } catch (error) {
    showError(error);
  }
});

$("pause").addEventListener("click", async () => {
  try {
    render(await call("POST", lastMood === "paused" ? "/resume" : "/pause"));
  } catch (error) {
    showError(error);
  }
});

poll();
setInterval(poll, 2000);
