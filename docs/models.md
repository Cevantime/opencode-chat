# Model compatibility with opencode

The extension is only a relay: **opencode is the authority on models**. The extension cannot run a model opencode does not know. This page explains how the model is recognized and what happens when it is not.

## How the model picker is populated

On activation, the extension registers a **LanguageModelChatProvider** (vendor `opencode`). It lists the models from:

```bash
opencode models
```

Every `provider/model` line of that output is published to VS Code's chat model picker, under the opencode vendor. So **any model opencode knows how to run** automatically appears in the picker — no additional setup.

## How a model is resolved at run time

When you submit a request to `@opencode`, the extension decides which model to use, in this order:

1. **Model picked from the opencode picker** (vendor `opencode`). The picker is built from `opencode models`, so the `provider/model` id is forwarded to opencode verbatim. This always works.
2. **Model picked from another vendor** (e.g. a Copilot/Claude model). The extension tries an exact `provider/model` match against `opencode models` and, if found, runs that opencode model.
3. **Fallback** when neither applies:
   - the model set in `opencodeDiff.model` (if any), or
   - opencode's **default model** if the setting is empty.

In every case the effective model is announced at the top of the chat response, e.g.:

> **Model:** anthropic/claude-sonnet-4-5 (picked “Claude Sonnet 4.5”)

When a non-opencode model cannot be mapped to an opencode one, the extension falls back and tells you so. If `opencodeDiff.model` is empty:

> **Model:** "Claude Sonnet 4.5" (copilot) is not available in opencode — running with **default**. Pick an opencode model in the picker (top of the chat).

If a fallback is set in `opencodeDiff.model`, it announces that one instead:

> **Model:** anthropic/claude-sonnet-4-5 (from opencodeDiff.model)

## Making sure your model is recognized

1. Check that opencode itself lists it:
   ```bash
   opencode models | grep <provider>
   ```
   If it is not listed, configure it in opencode first (see the opencode docs — model providers, API keys, etc.).
2. In the VS Code chat, open the **model picker** (top of the chat) and select the model under the **OpenCode** vendor. That guarantees the exact id reaches opencode.
3. If you usually chat from a non-opencode model, set a reliable default fallback in your settings so a fallback never surprises you:
   ```json
   "opencodeDiff.model": "anthropic/claude-sonnet-4-5"
   ```

## Notes

- The model list is cached for 60 seconds. After adding a provider/model in opencode, run **OpenCode Diff: Refresh Models** (or wait for the cache to expire) so it appears in the picker.
- Matching is exact (`provider/model`). A model id such as `claude-sonnet-4-5` without a provider will not map.
