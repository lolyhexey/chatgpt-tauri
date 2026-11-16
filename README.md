# ChatGPT — Rust + Tauri Desktop Client

A native desktop client for ChatGPT that mirrors **chatgpt.com** in look and
behaviour. It is built with a **Rust backend (Tauri 2)** and a **vanilla-JS
frontend** (no Node build step, no bundler). It speaks the same private web API
the browser uses — the `prepare`/`finalize` requirements handshake, a
proof-of-work challenge, and the `/backend-api/f/conversation` SSE stream — and
reuses the access token the ChatGPT CLI stores at `~/.chatgpt-cli/token`.

- **Stack:** Rust 2024 edition · Tauri 2 · reqwest + tokio · WebView2 (Windows) · plain HTML/CSS/JS
- **Platform:** developed and verified on Windows 11 (the release build hides the console via `windows_subsystem = "windows"`). Tauri is cross-platform, but only Windows has been exercised.
- **Not an Android project.** This is a desktop app; there is no Gradle, no APK, no emulator.
- **Reference:** the Node.js reference client at `E:\Project\Nodejs\Chatgpt`.

---

## 1. What it does (feature status)

| Area | Status | Notes |
|---|---|---|
| Token auth (load/save/validate/clear) | ✅ | JWT shape + expiry check; stored at `~/.chatgpt-cli/token` |
| Sentinel handshake + proof-of-work | ✅ | `prepare`/`finalize` + `solve_pow` |
| Streaming chat (SSE) | ✅ | multi-message replies, live steps, activity |
| Conversation list / resume / delete / delete-all | ✅ | also picks up chats continued on chatgpt.com |
| Markdown + syntax highlight + math + mermaid | ✅ | marked.js, highlight.js, KaTeX, mermaid — all vendored offline |
| File uploads (path + bytes) & image viewer | ✅ | upload starts on add; fullscreen viewer |
| Model / thinking-effort picker, `@` mentions, system hints | ✅ | measured against chatgpt.com (GPT-6) |
| Voice mode (WebRTC) | ✅ | offer → `voice_connect` → answer, data-channel transcripts |
| Generative UI ("GenUI") widgets | ✅ | safe expression interpreter, never `eval`s model output |
| **Goal mode** (autonomous multi-round) | ✅ | separate judge decides "done"; stall-stop after 3 toolless rounds |
| **Parallel agents runner** | ❌ **not implemented** | listed in the spec; no backend command exists for it yet |

> When you change this table, verify against the code — do not assume a planned
> feature shipped.

---

## 2. Quick start

### Prerequisites
- Rust (stable, edition 2024) with `cargo`.
- Tauri CLI: `cargo-tauri` (already installed on the dev machine — `cargo tauri --version`). Install with `cargo install tauri-cli` if missing.
- WebView2 runtime (ships with Windows 11).
- A valid ChatGPT access token at `~/.chatgpt-cli/token` (same file the Node CLI uses). The app can also save one you paste into its login overlay.

### Run in development (hot reload of the webview)
```bash
cd src-tauri
cargo tauri dev
```

### Build a release binary
```bash
# 1. Close the running app first — the .exe is locked while running.
# 2. Force the frontend assets to re-embed (see the gotcha in §7):
cd src-tauri
cargo clean -p chatgpt-ui --release
# 3. Build:
cargo tauri build
```
Output: `src-tauri/target/release/chatgpt-ui.exe` (standalone; frontend is embedded).

### Run the tests
```bash
cd src-tauri
cargo test --release
```
The suite is almost entirely in-file (`#[cfg(test)]` modules in `api.rs`,
`lib.rs`, `auth.rs`, `pow.rs`) and covers parsing, reply merging, activity
steps, goal verdicts, token validation, PoW, and URL-trust rules.

---

## 3. Architecture at a glance

```
┌──────────────────────────── Tauri window (WebView2) ────────────────────────────┐
│  FRONTEND  src/*.js  (vanilla, no build step, served from the embedded ../src)   │
│                                                                                   │
│   app.js ── composer, login, state, event wiring, goal-mode UI                    │
│     │  invoke('…')                         ▲  app.emit(...) live events           │
│     ▼  window.__TAURI__.core.invoke        │  (chat-delta, goal-round, …)         │
├───────────────────────────────── Tauri IPC boundary ─────────────────────────────┤
│  BACKEND  src-tauri/src/*.rs  (Rust, async/tokio)                                 │
│                                                                                   │
│   lib.rs ── AppState + #[tauri::command]s + goal loop  ──▶  api.rs ChatGptClient  │
│                                            │                      │               │
│   auth.rs  pow.rs  api_helpers.rs  types.rs                       ▼               │
│                                                        https://chatgpt.com        │
│                                                        /backend-api/… (HTTPS/SSE) │
└───────────────────────────────────────────────────────────────────────────────────┘
```

- **Frontend → backend:** `invoke('command_name', {args})` (Tauri IPC). All 26 commands are listed in §5.
- **Backend → frontend:** `app.emit('event', payload)` streams live tokens and progress into the UI (see `emit_live` in `lib.rs`).
- **Backend → ChatGPT:** one `ChatGptClient` (in `api.rs`) owns the token, device id, conversation pointer, model choice, and an optional stop switch.

---

## 4. Backend (Rust) — `src-tauri/src/`

| File | Lines | Responsibility |
|---|---:|---|
| `lib.rs` | ~800 | `AppState`, every `#[tauri::command]`, the goal-mode loop, uploads, downloads, clipboard, the `run()` entry that wires the handler. |
| `api.rs` | ~2400 | `ChatGptClient`: the whole HTTP/SSE surface, the SSE parser, `StreamEvent` production, activity/step extraction, models/hints/voices parsing. The big one. |
| `types.rs` | ~180 | Serde structs shared across the IPC boundary + the `StreamEvent` enum. |
| `pow.rs` | ~140 | Proof-of-work: `fnv1a`, `solve_pow(seed, difficulty)`, `make_app_attest()`, a fake browser config. |
| `auth.rs` | ~130 | Token load/save/validate/clear at `~/.chatgpt-cli/token`; JWT-shape + expiry validation. |
| `api_helpers.rs` | ~50 | `BASE_URL = "https://chatgpt.com"`, device id, base request headers (incl. `User-Agent`). |
| `main.rs` | 5 | Thin entry — calls `chatgpt_ui::run()`; hides console in release. |
| `build.rs` | 3 | `tauri_build::build()`. |

### 4.1 The request flow (`ChatGptClient::send_message_streaming`)
1. **Requirements handshake** — `get_requirements()`:
   - `POST /backend-api/sentinel/chat-requirements/prepare` with `{ "p": make_app_attest() }` → returns a `proofofwork` seed + difficulty.
   - `POST /backend-api/sentinel/chat-requirements/finalize` → returns the requirements **token**.
2. **Proof of work** — `solve_pow(seed, difficulty)` brute-forces a prefix whose `fnv1a` hash clears the difficulty.
3. **Send** — `POST /backend-api/f/conversation` (SSE) with headers:
   - `openai-sentinel-chat-requirements-token: <token>`
   - `openai-sentinel-proof-token: <pow solution>`
4. **Read the stream** — `read_reply()` parses SSE lines (`parse_sse_line`), feeds them through `StreamState::feed`, and emits `StreamEvent`s via the caller's closure. The redacted raw stream is also written to a debug log (`last_stream_path`, resume tokens redacted).

### 4.2 `StreamEvent` (the backbone — `types.rs`)
Everything the UI shows during a reply is one of these:
- `Text { delta, id }` — reply text. **`id` matters:** a reply can stream in more than one message at once; pieces with different ids must **not** be concatenated into one string.
- `Step { id, kind, title, detail, tool, sources, icon }` — an intermediate step (tool call, tool result, thinking summary, "Thought for Ns" recap), re-emitted with the same `id` as it updates. `kind ∈ {tool_call, tool_result, tool_query, thought, recap, text}`.
- `Images` / `Generated` — images resolved for `<AsyncImage/>` and images created by the image tool.
- `Conversation { conversation_id }` — emitted as soon as the server names the chat (new chats get their id here, long before the reply ends).
- `Done { conversation_id, message_id, model }`.

### 4.3 Key endpoints (all under `BASE_URL = https://chatgpt.com`)
| Purpose | Method + path |
|---|---|
| Requirements | `POST /backend-api/sentinel/chat-requirements/{prepare,finalize}` |
| Send (stream) | `POST /backend-api/f/conversation` |
| Stop | `POST /backend-api/stop_conversation` |
| Stream status | `GET /backend-api/conversation/{id}/stream_status` |
| List conversations | `GET /backend-api/conversations?offset&limit&order=updated` |
| Get / delete one | `GET` / `PATCH /backend-api/conversation/{id}` |
| Upload | `POST /backend-api/files` then `/backend-api/files/process_upload_stream` |
| Download file | `GET /backend-api/files/download/{file_id}?inline=false` |
| Models / hints / voices | `GET /backend-api/{models,system_hints,settings/voices}` |
| Voice realtime | `POST /realtime/wm?dcid=0` |

### 4.4 Goal mode (`lib.rs`: `start_goal` → `goal_rounds` → `judge_goal`)
Autonomous mode, like a `/goal` command. Loop up to `GOAL_MAX_ROUNDS = 20`:
1. Prompt the worker to keep working toward the goal (round 0 kicks it off; later rounds feed back *why the check said it isn't done*).
2. Stream the reply; classify it with `round_acted()` — a round that used a tool (`tool_call|tool_result|tool_query`, or produced images) counts as progress; a text-only round is a **stall**.
3. A **separate judge** (`judge_goal`) — a temp chat, no tools — returns `met` / `not_met` / `impossible` (`parse_verdict`). The worker never declares itself done.
4. Stop when the verdict is not `not_met`, or after **`GOAL_MAX_STALLS = 3`** toolless rounds in a row (verdict becomes `stalled`), or when the stop switch flips.

Progress is emitted to the UI as `goal-round` and `goal-check` events.

### 4.5 `AppState` (shared, behind mutexes)
`token`, `device_id`, `model`, `conversation_id`, `parent_message_id`, and
`stops` (a map of in-flight stream id → stop-switch sender). A send registers a
`tokio::sync::watch` stop switch; the `stop_generation` command flips it and the
reply loop ends.

---

## 5. IPC command surface (`invoke('name', …)`)

Registered in `lib.rs` via `tauri::generate_handler![…]`. 26 commands:

- **Auth:** `get_token`, `save_token`, `clear_token`
- **Chat:** `send_message`, `stop_generation`, `new_conversation`, `set_conversation`
- **Goal:** `start_goal`
- **Conversations:** `list_conversations_cmd`, `get_conversation_cmd`, `stream_status_cmd`, `delete_conversation_cmd`, `delete_all_cmd`
- **Menus/metadata:** `models_cmd`, `system_hints_cmd`, `voices_cmd`
- **Files:** `upload_path`, `upload_bytes`, `open_file_path`
- **Images/export:** `generated_image`, `save_generated_image`, `download_image`, `save_svg`
- **Voice:** `voice_connect`
- **Shell/clipboard:** `copy_text`, `open_url`

---

## 6. Frontend (JS) — `src/`

No framework, no bundler. `index.html` loads the vendored libraries and then
every `src/*.js` file as plain `<script>`s; Tauri is reached through the global
`window.__TAURI__` (`withGlobalTauri: true`). The UI is a **single dark theme**,
measured from chatgpt.com (see the comment in `styles.css :root`).

| File | Lines | Responsibility |
|---|---:|---|
| `app.js` | 825 | App bootstrap: login overlay, composer, send flow, Tauri event wiring, goal-mode UI, global state. The main entry. |
| `chat.js` | 739 | `Chat` class — renders turns, merges multi-message replies, streams text into the DOM (`patchHtml` diffs by stored `_src`), voice turns, generated-image cache. |
| `markdown.js` | 606 | `renderMarkdown(text, ctx)` — marked.js + highlight.js + KaTeX math + **mermaid** diagrams; streaming shows code, settles to a diagram when done. |
| `genui.js` | 605 | ChatGPT "GenUI" widgets ({#each}/{#if}, inputs, buttons). **Security-critical:** a tiny interpreter (`gxEval`) evaluates expressions — **model output is never run as JavaScript**, because this webview can call backend commands. |
| `voice.js` | 273 | Voice mode (WebRTC). Offer → `voice_connect` → answer; data channel carries JSON-patch transcript deltas and state updates. |
| `mentions.js` | 210 | The `@` menu — tools + connected apps from `/backend-api/system_hints`; a pick becomes a composer chip, then the exact text + `system_hints` chatgpt.com sends. |
| `attachments.js` | 145 | Composer files; upload starts on add, send waits until all are ready; `MAX_ATTACHMENTS = 10`. |
| `viewer.js` | 136 | `ImageViewer` — fullscreen image viewer for `<AsyncImage/>` clicks (zoom, download, source link). |
| `sidebar.js` | 104 | `Sidebar` — conversation list with select/delete. |
| `picker.js` | 102 | Model / thinking-effort picker: Instant→`gpt-6`, Medium→`gpt-6-thinking`+`standard`, High→`gpt-6-thinking`+`extended` (verified on chatgpt.com). |
| `icons.js` | 77 | SVG icon set; `icon(name, size, cls)` and `hydrateIcons(root)`. |

### Vendored libraries (`src/vendor/`, offline — no CDN)
- `marked.min.js` — markdown.
- `highlight.min.js` — code highlighting.
- `katex/` — math (JS, CSS, woff2 fonts).
- `mermaid/mermaid.min.js` — **mermaid v9.4.3** (UMD, self-contained). v10/v11 lazy-load diagram types over the network and break offline inside Tauri, so v9 is pinned on purpose. Diagram colours are forced via a CSS `!important` override because v9 ignores passed `themeVariables`.

### HTML sanitisation
`sanitizeHtml` (in `markdown.js`) is **blocklist-based**: it strips `on*`
handlers, inline `style`, and `javascript:` URLs, and keeps `class`/`data-*`.
SVG for mermaid is injected *after* sanitisation during hydration.

---

## 7. Conventions & gotchas (read before you change things)

1. **The frontend is embedded in the binary.** Cargo does **not** track `../src`
   as an input to the crate, so editing a `.js`/`.css`/`.html` file will **not**
   trigger a rebuild on its own. Before a release build, run
   `cargo clean -p chatgpt-ui --release` (or touch a `.rs` file) so the assets
   re-embed. `cargo tauri dev` serves them live, so dev is fine.
2. **The `.exe` is locked while running.** Close the app before rebuilding, or
   the link step fails.
3. **Single dark theme.** Colours are measured from chatgpt.com's dark theme and
   live as tokens in `styles.css :root`. There is no light mode; don't add
   one-off literal colours.
4. **Measure chatgpt.com before changing UI/behaviour.** This project copies the
   web app deliberately (endpoints, model ids, request shapes, visuals were all
   checked live). Match it rather than invent.
5. **In goal mode the worker never self-declares done** — a separate judge does.
   Keep that split.
6. **Replies can arrive as several interleaved messages.** Key reply text by its
   message `id`; never blindly concatenate (`merge_reply_text` / `reply_overlap`
   exist to handle overlap).
7. **The token is shared with the Node CLI** at `~/.chatgpt-cli/token`. Clearing
   it here deletes that file.
8. **Never execute model output as JS.** GenUI expressions go through `gxEval`,
   not `eval`/`Function`. This webview can invoke backend commands.

### Verifying a change in the real app
Tests cover logic; for UI/streaming, verify in the built `.exe`. The established
approach: launch the exe with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`, then
drive it over the Chrome DevTools Protocol (evaluate expressions against the
live page) to confirm rendering/colours/behaviour. Relaunch normally afterwards
so the debug port is closed.

---

## 8. Repository layout

```
Chatgpt/
├─ README.md               ← this file
├─ .gitignore              ← /target, node_modules/, local-only notes
├─ src/                    ← frontend (vanilla JS + CSS + vendored libs)
│  ├─ index.html  app.js  chat.js  markdown.js  genui.js  voice.js
│  ├─ mentions.js  attachments.js  viewer.js  sidebar.js  picker.js  icons.js
│  ├─ styles.css
│  └─ vendor/ (marked, highlight, katex/, mermaid/)
└─ src-tauri/              ← Rust backend + Tauri config
   ├─ Cargo.toml  Cargo.lock  build.rs  tauri.conf.json
   ├─ capabilities/default.json   icons/
   └─ src/ (lib.rs  api.rs  types.rs  pow.rs  auth.rs  api_helpers.rs  main.rs)
```

Git branch for this work: **`feat/tauri-app`**.

---

## 9. Where to look first

- **"How does a message get sent?"** → `api.rs::send_message_streaming` (handshake → PoW → SSE) and `lib.rs::send_message` (the command).
- **"How does the reply render?"** → `chat.js` (`Chat` class, `patchHtml`) + `markdown.js` (`renderMarkdown`).
- **"How does goal mode decide it's done?"** → `lib.rs::goal_rounds` + `judge_goal`.
- **"What can the frontend ask the backend to do?"** → the `generate_handler!` list in `lib.rs` (and §5 above).
- **"What does the server actually return?"** → `StreamEvent` in `types.rs` and the parsers in `api.rs` (`parse_sse_line`, `collect_activity`, `activity_step`).
