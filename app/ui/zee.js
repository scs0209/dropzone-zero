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
let drawnComing = "";

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
  window.zeeRobot?.setMood(mood);
  $("badge").textContent = mood === "paused" ? "II" : mood === "dizzy" ? "?" : "";
}

// The menu bar icon shows how many questions are open, so a hidden Zee can still ask.
let attention = -1;
function setAttention(count) {
  if (count === attention) return;
  attention = count;
  window.__TAURI__?.core.invoke("set_attention", { count }).catch(() => {});
}

function render(state) {
  setAttention(state.pending.length);
  $("start").hidden = true;
  lastError = "";
  setMood(state.mood);
  $("badge").textContent = state.mood === "asking" ? String(state.pending.length) : $("badge").textContent;
  $("message").textContent = state.message;
  $("pause").textContent = state.mood === "paused" ? "Resume" : "Pause";

  const pendingKey = JSON.stringify(state.pending);
  if (pendingKey !== drawnPending) {
    drawnPending = pendingKey;
    drawPending(state.pending);
  }
  // Only files that are still where Zee put them: not undone, not deleted or moved away since.
  const recent = state.recent.filter((m) => m.current && m.present).slice(0, 8);
  $("empty").hidden = recent.length > 0 || state.pending.length > 0 || (state.followUps ?? []).length > 0;
  const recentKey = JSON.stringify(recent);
  if (recentKey !== drawnRecent) {
    drawnRecent = recentKey;
    drawRecent(recent);
  }

  const coming = state.followUps ?? [];
  const comingKey = JSON.stringify(coming);
  if (comingKey !== drawnComing) {
    drawnComing = comingKey;
    drawComing(coming);
  }

  // Open the bubble once by itself when a new question comes in; after that the person decides.
  const question = state.pending.map((p) => p.id).join(",");
  if (state.mood === "asking" && question !== autoOpenedFor) {
    autoOpenedFor = question;
    setBubbleOpen(true);
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

// Follow-ups for what was filed (a due date, a booking, a warranty's end). Nothing
// reaches the calendar until the person clicks, and the Calendar app asks again.
function drawComing(followUps) {
  $("coming-title").hidden = followUps.length === 0;
  $("coming").replaceChildren(
    ...followUps.map((followUp) => {
      const li = document.createElement("li");
      const text = Object.assign(document.createElement("div"), { className: "what" });
      text.append(
        Object.assign(document.createElement("div"), { textContent: followUp.title }),
        Object.assign(document.createElement("div"), { className: "when", textContent: followUp.date }),
      );
      const add = Object.assign(document.createElement("button"), { type: "button", textContent: "Add to calendar" });
      add.onclick = async () => {
        add.disabled = true;
        try {
          render(await call("POST", "/calendar", { file: followUp.file }));
        } catch (error) {
          add.disabled = false;
          showError(error);
        }
      };
      // Takes it off this list only; the .ics file stays in Calendar/Follow-ups.
      const dismiss = Object.assign(document.createElement("button"), { type: "button", className: "dismiss", textContent: "×", title: "Dismiss" });
      dismiss.setAttribute("aria-label", `Dismiss ${followUp.title}`);
      dismiss.onclick = async () => {
        dismiss.disabled = true;
        try {
          render(await call("POST", "/dismiss", { file: followUp.file }));
        } catch (error) {
          dismiss.disabled = false;
          showError(error);
        }
      };
      li.append(text, add, dismiss);
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

let lastError = "";
function showError(error) {
  const text = error instanceof Error ? error.message : String(error);
  // While Zee is bringing up Ollama and the daemon, look busy rather than broken.
  const starting = text.startsWith("Starting");
  setMood(starting ? "thinking" : "dizzy");
  $("message").textContent = text;
  $("start").hidden = starting || !window.__TAURI__ || !/not running/i.test(text);
  // Open the bubble once per new problem; if the person closes it, leave it closed.
  if (!starting && text !== lastError) setBubbleOpen(true);
  lastError = text;
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

// Click opens the bubble; press and move drags Zee anywhere on screen. The two are
// told apart by distance, so a slightly shaky click still counts as a click.
const tauriWindow = window.__TAURI__?.window.getCurrentWindow();
let press = null;

zee.addEventListener("mousedown", (event) => {
  if (event.button === 0) press = { x: event.screenX, y: event.screenY, dragged: false };
});

window.addEventListener("mousemove", (event) => {
  if (!press || press.dragged || !tauriWindow) return;
  if (Math.hypot(event.screenX - press.x, event.screenY - press.y) > 4) {
    press.dragged = true;
    tauriWindow.startDragging();
  }
});

zee.addEventListener("click", () => {
  const dragged = press?.dragged;
  press = null;
  if (!dragged) setBubbleOpen(bubble.hidden);
});

// The window is sized to what it shows: just Zee when the bubble is closed (so it
// does not cover other windows), Zee plus the bubble when it is open. Zee's
// bottom-right corner is the anchor, so Zee never jumps when the bubble opens,
// closes, or is resized.
// Read Zee's size from style.css, so the window math and the layout cannot disagree.
const ZEE_SIZE = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--zee-size")) || 100;
const ZEE_BOX = ZEE_SIZE + 24; // Zee plus margins
const BUBBLE_ABOVE_ZEE = ZEE_SIZE + 18; // the bubble's bottom offset in style.css
// Small enough to stay out of the way, big enough that a question's buttons stay in view.
const BUBBLE_MIN = { w: 240, h: 200 };
const BUBBLE_MAX = { w: 640, h: 720 };
const BUBBLE_KEY = "zee-bubble-size";
const ANCHOR_KEY = "zee-anchor";

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembered; defaults next time.
  }
}

let bubbleSize = load(BUBBLE_KEY) ?? { w: 276, h: 222 };
// Set while the bubble is being dragged to a new size (see the resize handle below).
let resizing = null;
function applyBubbleSize() {
  document.documentElement.style.setProperty("--bubble-w", `${bubbleSize.w}px`);
  document.documentElement.style.setProperty("--bubble-h", `${bubbleSize.h}px`);
}
applyBubbleSize();

function windowSize() {
  if (bubble.hidden) return { w: ZEE_BOX, h: ZEE_BOX };
  // While the bubble is being resized the window stays at the largest size the bubble
  // can reach, and only the bubble changes inside it: resizing the window on every
  // pointer move made the webview redraw at the new size a frame late, so Zee shook.
  const size = resizing ? BUBBLE_MAX : bubbleSize;
  return { w: Math.max(size.w + 24, ZEE_BOX), h: size.h + BUBBLE_ABOVE_ZEE + 12 };
}

/** Where Zee's bottom-right corner is, in logical screen pixels. */
async function anchor() {
  const scale = await tauriWindow.scaleFactor();
  const position = (await tauriWindow.outerPosition()).toLogical(scale);
  const size = (await tauriWindow.outerSize()).toLogical(scale);
  return { right: position.x + size.width, bottom: position.y + size.height };
}

async function placeWindow(corner) {
  const { LogicalPosition, LogicalSize } = window.__TAURI__.dpi;
  const { w, h } = windowSize();
  await tauriWindow.setSize(new LogicalSize(w, h));
  await tauriWindow.setPosition(new LogicalPosition(corner.right - w, corner.bottom - h));
}

// One fit at a time; a request that arrives meanwhile is folded into one more pass.
let fitting = false;
let fitAgain = false;
async function fitWindow() {
  if (!tauriWindow) return;
  if (fitting) {
    fitAgain = true;
    return;
  }
  fitting = true;
  try {
    do {
      fitAgain = false;
      // One native step that keeps Zee's corner fixed (see fit_window in main.rs).
      const { w, h } = windowSize();
      await window.__TAURI__.core.invoke("fit_window", { width: w, height: h });
    } while (fitAgain);
  } catch {
    // Window APIs unavailable; the layout still works inside the current window.
  } finally {
    fitting = false;
  }
}

function setBubbleOpen(open) {
  if (bubble.hidden === !open) return;
  bubble.hidden = !open;
  fitWindow();
}

// Resize the bubble from its top-left corner. Pointer capture keeps the drag going
// even when the pointer runs ahead of the window edge.
const handle = $("bubble-resize");
handle.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  resizing = { x: event.screenX, y: event.screenY, w: bubbleSize.w, h: bubbleSize.h };
  fitWindow(); // grow once, to the largest bubble
});
handle.addEventListener("pointermove", (event) => {
  if (!resizing) return;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
  bubbleSize = {
    w: clamp(resizing.w + resizing.x - event.screenX, BUBBLE_MIN.w, BUBBLE_MAX.w),
    h: clamp(resizing.h + resizing.y - event.screenY, BUBBLE_MIN.h, BUBBLE_MAX.h),
  };
  applyBubbleSize();
});
const endResize = () => {
  if (!resizing) return;
  resizing = null;
  save(BUBBLE_KEY, bubbleSize);
  fitWindow(); // shrink once, to the bubble as left
};
handle.addEventListener("pointerup", endResize);
handle.addEventListener("pointercancel", endResize);

// Remember where Zee was put (its bottom-right corner), and come back there if that spot is still on a screen.
let anchorTimer;
tauriWindow?.onMoved(() => {
  press = null;
  clearTimeout(anchorTimer);
  anchorTimer = setTimeout(async () => {
    try {
      save(ANCHOR_KEY, await anchor());
    } catch {
      // Not remembered.
    }
  }, 300);
});

async function restoreWindow() {
  if (!tauriWindow) return;
  try {
    const saved = load(ANCHOR_KEY);
    const monitor = await tauriWindow.currentMonitor();
    let corner = await anchor();
    if (saved && monitor) {
      const scale = monitor.scaleFactor;
      const left = monitor.position.x / scale;
      const top = monitor.position.y / scale;
      const right = left + monitor.size.width / scale;
      const bottom = top + monitor.size.height / scale;
      const onScreen = saved.right > left + ZEE_BOX && saved.right <= right && saved.bottom > top + ZEE_BOX && saved.bottom <= bottom;
      if (onScreen) corner = saved;
    }
    await placeWindow(corner);
  } catch {
    // Stay where the app placed Zee.
  }
}

restoreWindow();

$("start").addEventListener("click", async () => {
  $("start").hidden = true;
  showError("Starting Dropzone Zero...");
  try {
    await window.__TAURI__.core.invoke("start_services");
  } catch (error) {
    showError(error);
  }
});

// Going away: the bubble closes, Zee dives into a hole in the ground, then the
// window hides (or the app quits). Coming back, Zee pops out of the hole.
async function diveAway() {
  setBubbleOpen(false);
  await window.zeeRobot?.dive();
}

async function hideZee() {
  await diveAway();
  window.__TAURI__?.core.invoke("set_zee_visible", { visible: false }).catch(showError);
}

$("hide").addEventListener("click", hideZee);

// The menu bar icon and its menu ask the page first, so Zee can dive before the window goes.
const tauriEvents = window.__TAURI__?.event;
tauriEvents?.listen("zee:hide-requested", hideZee);
tauriEvents?.listen("zee:shown", () => window.zeeRobot?.emerge());
tauriEvents?.listen("zee:quit-requested", async () => {
  await diveAway();
  window.__TAURI__.core.invoke("quit_zee");
});

// Undo asks first, inside the bubble: the first click turns the button into
// "Put back?", and a second click within a few seconds does it. (window.confirm()
// cannot be used: Zee's webview on macOS shows no JavaScript dialogs, so it
// returned false at once and Undo silently did nothing.)
const undoButton = $("undo");
let undoArmed = null;
function disarmUndo() {
  clearTimeout(undoArmed);
  undoArmed = null;
  undoButton.textContent = "Undo last";
  undoButton.classList.remove("armed");
}
undoButton.addEventListener("click", async () => {
  if (!undoArmed) {
    undoButton.textContent = "Put back?";
    undoButton.classList.add("armed");
    undoArmed = setTimeout(disarmUndo, 4_000);
    return;
  }
  disarmUndo();
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
