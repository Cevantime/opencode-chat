# Configuration

All settings are available under the `opencodeDiff.*` namespace (gear icon → *Settings* → search for "OpenCode Diff").

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `opencodeDiff.opencodePath` | `string` | `"opencode"` | Path to the opencode binary. Defaults to `opencode` (resolved via `PATH`, then `~/.opencode/bin/opencode`, then the usual Homebrew paths). |
| `opencodeDiff.model` | `string` | `""` | Default model in `provider/model` format (e.g. `anthropic/claude-sonnet-4-5`). Empty = opencode's default model. Used as the fallback when the model picked in the chat is not recognized by opencode. |
| `opencodeDiff.agent` | `string` | `""` | opencode agent to use. Empty = default agent. |
| `opencodeDiff.mode` | `"auto"` \| `"build"` \| `"plan"` | `"auto"` | Mode opencode runs in. `auto` follows the VS Code chat mode (plan when the Plan mode is active), `plan` forces the read-only plan agent, `build` forces the default build agent. |
| `opencodeDiff.autoOpenReview` | `boolean` | `true` | Automatically open the review view when a run produces changes. |
| `opencodeDiff.newSession` | `boolean` | `true` | Start a new opencode session for each new VS Code chat session (conversation context is preserved across prompts within the same chat). Set to `false` to reuse a single opencode session across all chats. |
| `opencodeDiff.openDiffOnClick` | `boolean` | `true` | Open the diff editor instead of the plain file when clicking a file under review in the Explorer, and convert already-open plain-file tabs to diffs when a review is created. Disable to open files normally (inline diff decorations still apply). |
| `opencodeDiff.allowBash` | `boolean` | `false` | Allow opencode to run bash commands. Disabled by default: side effects (installations, servers) are not reversible by the review. |
| `opencodeDiff.webfetchPermission` | `"allow"` \| `"deny"` | `"allow"` | Allow opencode to fetch web pages. |
| `opencodeDiff.snapshotSizeLimitMb` | `number` | `10` | Maximum size (MB) of files kept for restoration. Larger files modified by opencode cannot be restored automatically. |

## Commands

| Command | Description |
| --- | --- |
| `OpenCode Diff: Accept All` | Accept every change of the current review. |
| `OpenCode Diff: Reject All` | Reject every change of the current review. |
| `OpenCode Diff: Discard Review` | Reject all changes and clear the review. |
| `OpenCode Diff: Open Change Review` | Focus the Change Review view. |
| `OpenCode Diff: Open Diff` | Open the diff editor for a file. |
| `OpenCode Diff: Accept File` | Accept a whole file's changes. |
| `OpenCode Diff: Reject File` | Reject a whole file's changes. |
| `OpenCode Diff: Accept Segment` | Accept only the active segment in the diff editor. |
| `OpenCode Diff: Reject Segment` | Reject only the active segment in the diff editor. |
| `OpenCode Diff: Accept Active Diff` | Accept the file shown in the active diff editor. |
| `OpenCode Diff: Reject Active Diff` | Reject the file shown in the active diff editor. |
| `OpenCode Diff: Start Implementation` | Start the implementation of the most recent plan (build mode, reusing the plan's opencode session). |
| `OpenCode Diff: Refresh Models` | Reload the model list from `opencode models`. |

## Notes

- **Session data** — each workspace root gets an isolated opencode data directory (`<globalStorage>/data/<sha1>`), so sessions survive server restarts and never clash with a concurrent opencode instance (e.g. the TUI).
- **Output** — all runs are logged to the *OpenCode Diff* output channel (`View` → *Output* → *OpenCode Diff*).
- **Rollback** — files up to `snapshotSizeLimitMb` are snapshotted before a run. Files exceeding the limit (or ignored ones) cannot be restored automatically; they are reported as *unrestorable* in the chat when that happens.
