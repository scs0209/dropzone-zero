# Zee, the desktop companion

[← Back to the README](../../README.md)

Not everyone wants a terminal open. Zee is a small 3D robot that sits in the corner of the screen, always on top, turns its head toward your pointer, and shows what Dropzone Zero is doing on its screen face and antenna light:

| Zee | Means |
|---|---|
| Flat eyes, z z z | Watching; nothing to do |
| Eyes scanning, blue light blinking | A new download is finishing, or Gemma is reading it ("Reading report.pdf...") |
| Green light, chomping a page | Just filed a download |
| Waving, amber light, badge | Something needs your OK |
| Orange eyes, wobbling | Cannot work (usually the local model is not running yet) |
| Grey, screen off | Paused |

When Zee is hidden (from the bubble or the menu bar icon) or quits, a hole opens under it and Zee dives in head first; showing Zee again, it pops back out. Drag Zee anywhere on the screen; resize the speech bubble from its top-left corner. Zee keeps its size, the window shrinks to just Zee when the bubble is closed so it never covers other windows, and both the spot and the bubble size are remembered. A small robot icon in the menu bar shows and hides Zee (left click), and its menu has Show/Hide and Quit; while Zee is hidden, the number of open questions appears next to that icon, and the daemon keeps working. Click Zee to open a speech bubble: each question gets **Move it** and **Leave it** buttons, recently filed files open in Finder with a click, and **Undo last**, **Pause**, and **Hide** are one click away. **Undo last** asks once in the button itself ("Put back?"; click again within a few seconds) and then puts back everything the last run moved; a file put back this way is never filed again on its own. Zee opens the bubble by itself when a new question arrives.

```bash
pnpm app:build                        # builds Zee.app (about 10 MB) with Tauri
pnpm dz autostart enable ~/Downloads   # Zee starts now and at every login
pnpm app                              # or run Zee in development mode
```

Zee is the only thing that has to be launched. When it starts, it starts Ollama and `dz daemon` if they are not already running (an Ollama you run yourself, say with `brew services`, is used as is), and when you quit Zee from its menu bar icon it stops what it started. If the daemon is not running, Zee's bubble shows a **Start** button.

Zee is a [Tauri](https://tauri.app) app: a Rust shell around the system WebView, so it is about 10 MB instead of shipping a browser. The robot is built from simple shapes in [three.js](https://threejs.org) (pinned, copied into the app at build time, no CDN) and renders at 30 frames per second when active and 12 when resting, so an always-on companion stays cheap. It never touches files. It talks to `dz daemon` over `127.0.0.1` with a random token that only your user can read (`~/.dropzone-zero/daemon.json`, mode 600), and the daemon refuses requests from any other web origin. Every click goes through the same guard and executor as the command line: **Move it** can only release a review item, and **Show in Finder** only opens files Dropzone Zero itself moved.

## Approve from your phone (optional, Auth0)

Away from the Mac, Zee can still ask. With the four `AUTH0_*` settings in `.env`, every question Zee asks (an installer, a low-confidence file, a batch over the bulk limit) also goes to the approver's phone as an Auth0 Guardian push, using Auth0's Client-Initiated Backchannel Authentication (CIBA). Approve or decline on the phone, or in Zee; whichever answer comes first counts, and the other question closes. An unanswered push changes nothing: Zee keeps asking.

- **Only the kind of move leaves the machine:** the push says "Dropzone Zero: move 1 installer" or "move 23 new files", never a file name, path, or content.
- **Nothing can reach the Mac:** the daemon only makes outgoing requests to Auth0 and polls for the answer. Its API still listens on 127.0.0.1 alone.
- **An approval is still exactly one move:** it releases the same fingerprint-bound item as **Move it** in Zee, through the same guard and executor.

Setup: create a Regular Web application in Auth0 (first-party), enable the CIBA grant with the Guardian push channel, turn on "Push Notification using Auth0 Guardian" under Security > Multi-factor Auth, and enroll the approving user in Guardian. Then set `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, and `AUTH0_APPROVER_USER_ID`. Auth0's docs list CIBA under the Enterprise plan or an add-on; check that your tenant allows it.
