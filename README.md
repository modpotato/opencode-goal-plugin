# opencode-goal-plugin

Auto-continuing `/goal` command for OpenCode V2 (with V1 compat in `src/`).

Set a goal with `/goal <objective>`. The plugin reminds the model every turn,
watches for turn-end (`session.idle`), verifies completion with the **current
LLM**, and auto-continues until the model calls `goal_complete` (or
`goal_status` with `{"status": "complete"}`).

Helper tools: `get_goal` (read the active goal), `goal_pause` / `goal_resume`
(pause and resume auto-continuation; `goal_status` also accepts
`"paused"` / `"active"`). Goals survive compaction: V2 posts a synthetic
carry-over message on `session.compaction.ended`, V1 injects the goal into
the compaction prompt.

Tested on `opencode2` `0.0.0-beta-19425`.

## Install

### Option A — from GitHub (recommended)

```sh
opencode2 plugin add github:modpotato/opencode-goal-plugin
opencode2 service restart
```

Verify:

```sh
opencode2 api get /api/plugin   # look for id "goal" with status active
```

### Option B — single-file global install (no package manager)

Some setups only auto-discover flat files. Copy the prebuilt `goal.ts`
(V2-only, zero imports, generated from `src/index.ts`) into the global
plugins directory:

```powershell
Copy-Item goal.ts "$env:USERPROFILE\.config\opencode\plugins\goal.ts"
opencode2 service restart
```

On macOS/Linux the directory is `~/.config/opencode/plugins/goal.ts`.

To regenerate `goal.ts` after editing `src/index.ts`, take lines 1–382
(the V2 setup section), drop the two `import` lines, prepend
`const Plugin = { define: (p) => p };`, and append
`export default v2Plugin`.

## Use

```text
/goal Build login with tests
/goal status
/goal append Also handle password reset
/goal pause
/goal resume
/goal clear
/goal complete Fixed, all tests pass
```

While a goal is `active`:

1. A `context` hook injects `Active /goal: "..."` into the system prompt.
2. `goal_complete` and `goal_status` end it; `get_goal` reads it;
   `goal_pause` / `goal_resume` pause and resume auto-continuation.
3. On `session.idle`, the plugin asks the session's current model
   (`COMPLETE` / `INCOMPLETE` verdict). `COMPLETE` (or a tool call) ends the
   goal; otherwise it re-prompts `Continue working toward the active goal.`
4. Stops after `maxAttempts` auto-continues (default `0` = unlimited).
5. On `session.compaction.ended` (V2) a synthetic carry-over message
   re-anchors the goal in the fresh transcript; V1 feeds it into the
   compaction prompt instead.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "github:modpotato/opencode-goal-plugin",
      "options": {
        "maxAttempts": 0,
        "verify": true,
        "continuePrefix": "Continue working toward the active goal."
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `maxAttempts` | `0` | Max auto-continues per goal before it stops itself (`0` = unlimited). |
| `verify` | `true` | Ask the current model whether the goal is complete before continuing. |
| `continuePrefix` | `"Continue working toward the active goal."` | Prefix of the auto-continue prompt. |

## How it maps to the opencode way

- Command via `ctx.command.transform` (V2) / `config.command.goal` + `command.execute.before` (V1).
- Completion via `ctx.tool.transform` namespace `goal` (effective names `goal_complete`, `goal_status`, `goal_pause`, `goal_resume`) plus top-level `get_goal`.
- Turn-end via `session.idle` events (`ctx.event.subscribe` / `event` hook).
- Durable per-session state via `ctx.storage` (`goal:<sessionID>`), so goals survive compaction and restarts.

## Develop

```sh
npm install
npx tsc --noEmit
```

`src/index.ts` is the source of truth (dual V1 + V2 export).
`goal.ts` is the flattened V2-only build for manual installs.

## License

MIT — see [LICENSE](LICENSE).
