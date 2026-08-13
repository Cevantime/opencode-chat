# OpenCode Diff

> **⚠️ Beta** — this extension has been largely **vibe coded** using opencode itself: it works, but it is still experimental and may contain bugs. Test it on scratch projects before using it on critical work, and report any issues you run into.

## Why this extension exists

To bring [opencode](https://opencode.ai) into the **Copilot workflow of VS Code**: ask for a change in the chat, watch the assistant work, then **review every change as a diff** and decide to accept or reject it before it touches your code.

The core of the extension is the **diff**: instead of blindly applying what the assistant proposes, every modified file is presented in a review view where you control precisely what lands in your codebase — segment by segment, file by file.

## Documentation

- [**Configuration**](docs/configuration.md) — every setting and command.
- [**Model compatibility**](docs/models.md) — how a model is recognized by opencode and how the fallback works.

More detailed documentation will progressively be added to the [`docs/`](docs/) directory.

## Overview

OpenCode Diff connects the [opencode](https://opencode.ai) assistant to VS Code:

- **Native chat** — use the `@opencode` participant in the VS Code Chat view. The response, reasoning and tool calls (edit, bash, webfetch…) are streamed live into the conversation.
- **Immediate diff** — modified files are detected while the run is in progress and shown in the diff editor, with inline markers (additions/deletions) on the file.
- **Controlled review** — the **Change Review** view lists every modified file. Accept or reject each **segment** individually, each **file**, or all of them at once. Code is only actually applied when accepted.
- **Built-in rollback** — a snapshot of each file is kept before the run: reject a change (or cancel a run) to restore the original state of the file.
- **Plan mode** — ask for a plan (read-only *plan* mode): opencode proposes changes without applying them. An **Implement with opencode** button then re-runs the same opencode session in build mode, keeping the conversation context.
- **Questions and permissions in the chat** — opencode's questions and permission requests appear in the conversation and are answered with buttons, without ever leaving VS Code.
- **opencode models** — pick the model among the ones configured in opencode directly from the picker at the top of the chat.

## Usage

### Prerequisites

- VS Code **1.127** or newer.
- The **opencode** binary installed and reachable (found via `PATH`, `~/.opencode/bin/opencode`, or the usual Homebrew paths):
  ```bash
  npm i -g opencode-ai        # or
  brew install sst/tap/opencode
  ```
- A model configured in opencode (see the opencode documentation).

### Installation

1. Open the *Extensions* view (`Ctrl/Cmd + Shift + X`).
2. Install **OpenCode Diff** from the Marketplace (or from a `.vsix` file: `…` menu → *Install from VSIX*).
3. Reload the window (`Developer: Reload Window`).

### Run a request

1. Open a folder in VS Code (`File` → *Open Folder*).
2. Open the *Chat* view (`Ctrl/Cmd + Shift + I`).
3. Type a request prefixed with `@opencode`, for example:
   > `@opencode add a login form`
4. opencode runs the request. The response and tool calls are streamed into the chat.

### Plan mode

1. In the chat mode bar, select **Plan** (or use the mode configured in `opencodeDiff.mode`).
2. Ask `@opencode` your request: opencode proposes a plan **without modifying your files**.
3. To implement it, click **Implement with opencode** in the response: the same opencode session restarts in build mode with the plan context preserved.

### Reviewing and applying changes

When a run produces changes:

1. The **Change Review** view (**OpenCode Diff** activity) lists the modified files.
2. Open a file to see the diff editor; the changed **segments** are marked inline.
3. Accept or reject:
   - **Segment**: buttons in the diff editor title bar, or the `OpenCode Diff: Accept/Reject Segment` command.
   - **File**: buttons on the item in the view, or the `OpenCode Diff: Accept/Reject File` command.
   - **All**: *Accept All* / *Reject All* / *Discard Review* buttons in the view title bar.
4. An **accepted** change is applied to the file; a **rejected** change restores the original snippet from the snapshot.
