// goal.ts - flattened V2-only build of opencode-goal-plugin.
// Generated from src/index.ts (V2 setup section). Do not edit by hand; edit src and re-flatten.
// Import-free on purpose: bare imports do not resolve reliably from a global plugins/ directory.
const Plugin = { define: (p) => p };


/**
 * opencode-goal-plugin
 *
 * V2-first OpenCode plugin (with V1 compat via `server()` below).
 *
 * - `/goal <objective>` sets an auto-continued goal for the session.
 * - `goal_complete` / `goal_status` tools let the *current* LLM mark it done.
 * - On `session.idle`, the plugin verifies with the current LLM
 *   (`ctx.session.generate`, same model + session context) and auto-continues
 *   unless the goal was completed via tool or verifier says COMPLETE.
 *
 * Opencode-way choices:
 * - Command via `ctx.command.transform` (V2) / `config.command` + `command.execute.before` (V1).
 * - Completion via `ctx.tool.transform` namespace `goal` (V2) / `tool()` helper shape (V1).
 * - Reminder via `ctx.session.hook("context")` system injection (V2).
 * - Turn-end detection via `session.idle` events (both).
 * - Durable per-session state via `ctx.storage` (V2), in-memory + optional file (V1).
 */

type GoalStatus = "active" | "paused"

type GoalState = {
  text: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  attempts: number
}

type PluginOptions = {
  maxAttempts?: number
  verify?: boolean
  continuePrefix?: string
}

const DEFAULT_MAX_ATTEMPTS = 15
const keyFor = (sessionID: string) => `goal:${sessionID}`

// Guard against re-entrant verification loops (module-level so it survives
// across setup reloads within the same process).
const verifying = new Set<string>()

function parseGoalArgs(raw: string): { kind: string; rest: string } {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) return { kind: "show", rest: "" }
  const [first, ...restParts] = trimmed.split(/\s+/)
  const rest = restParts.join(" ").trim()
  const cmd = (first ?? "").toLowerCase()
  if (["show", "status", "list", "get"].includes(cmd)) return { kind: "show", rest }
  if (["clear", "done", "stop", "reset", "cancel"].includes(cmd)) return { kind: "clear", rest }
  if (["pause", "hold"].includes(cmd)) return { kind: "pause", rest }
  if (["resume", "unpause", "continue"].includes(cmd)) return { kind: "resume", rest }
  if (["append", "add"].includes(cmd)) return { kind: "append", rest }
  if (["complete", "finish", "achieved"].includes(cmd)) return { kind: "complete", rest }
  // Default: whole raw string is the objective (allows `/goal fix login bug`).
  return { kind: "set", rest: trimmed }
}

function formatGoal(goal: GoalState): string {
  return `Goal [${goal.status}] (attempts: ${goal.attempts}): ${goal.text}`
}

function verifierPrompt(goalText: string): string {
  return [
    `Active goal: "${goalText}"`,
    ``,
    `Based on the full conversation so far (including tool results), is this goal fully complete?`,
    `Reply with exactly one word on the first line: COMPLETE if every requirement is satisfied, otherwise INCOMPLETE.`,
    `Then give a one-line reason on the second line.`,
  ].join("\n")
}

function continuePrompt(goalText: string, prefix: string): string {
  return `${prefix}\n\nGoal: "${goalText}"\n\nIf the goal is now fully satisfied, call goal_complete (or goal_status with status "complete"). Otherwise continue working toward it with tools. Do not ask the user for confirmation; keep going until done.`
}

function isCompleteVerdict(text: string): boolean {
  const first = (text ?? "").trim().split("\n")[0]?.trim().toUpperCase() ?? ""
  return first === "COMPLETE" || first.startsWith("COMPLETE ") || first.startsWith("COMPLETE:")
}

// ---------------------------------------------------------------------------
// V2 implementation
// ---------------------------------------------------------------------------

const v2Plugin = Plugin.define({
  id: "goal",
  async setup(ctx) {
    const opts = (ctx.options ?? {}) as PluginOptions
    const maxAttempts =
      typeof opts.maxAttempts === "number" && Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : DEFAULT_MAX_ATTEMPTS
    const verify = opts.verify !== false
    const prefix =
      typeof opts.continuePrefix === "string" && opts.continuePrefix.trim()
        ? opts.continuePrefix.trim()
        : "Continue working toward the active goal."

    const getGoal = async (sessionID: string): Promise<GoalState | undefined> => {
      const raw = await ctx.storage.get(keyFor(sessionID))
      if (!raw || typeof raw !== "object") return undefined
      const g = raw as Record<string, unknown>
      if (typeof g.text !== "string" || !g.text.trim()) return undefined
      return {
        text: g.text,
        status: g.status === "paused" ? "paused" : "active",
        createdAt: typeof g.createdAt === "number" ? g.createdAt : Date.now(),
        updatedAt: typeof g.updatedAt === "number" ? g.updatedAt : Date.now(),
        attempts: typeof g.attempts === "number" ? g.attempts : 0,
      }
    }

    const setGoal = (sessionID: string, goal: GoalState | null) =>
      goal ? ctx.storage.set(keyFor(sessionID), goal as any) : ctx.storage.remove(keyFor(sessionID))

    // --- tools: goal_complete + goal_status (covers `goal.complete` / `goal.status(complete)`) ---
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "goal",
        description: "Mark or inspect the active /goal. Call goal_complete when the goal is done.",
      })

      editor.add({
        name: "complete",
        description:
          'Mark the active /goal as complete. Call this when every requirement of the goal is satisfied. Optional summary of what was done.',
        input: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Short summary of how the goal was completed." },
          },
          additionalProperties: false,
        },
        options: { namespace: "goal" },
        execute: async (input, toolCtx) => {
          const sessionID = (toolCtx as unknown as { sessionID: string }).sessionID
          const goal = await getGoal(sessionID)
          await setGoal(sessionID, null)
          verifying.delete(sessionID)
          const summary = (input as { summary?: unknown })?.summary
          const suffix = typeof summary === "string" && summary.trim() ? `\n${summary.trim()}` : ""
          if (!goal) return { content: `No active goal was set. Nothing to complete.${suffix}` }
          return { content: `Goal marked complete: "${goal.text}"${suffix}` }
        },
      })

      editor.add({
        name: "status",
        description:
          'Get the active /goal, or set its status. Call with {"status":"complete"} to finish, {"status":"paused"} to pause, or {"status":"active"} to resume.',
        input: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["complete", "active", "paused"], description: 'New goal status. Omit to just read the current goal.' },
            summary: { type: "string", description: "Optional summary when completing." },
          },
          additionalProperties: false,
        },
        options: { namespace: "goal" },
        execute: async (input, toolCtx) => {
          const sessionID = (toolCtx as unknown as { sessionID: string }).sessionID
          const args = input as { status?: string; summary?: string }
          const goal = await getGoal(sessionID)
          if (args?.status === "complete") {
            await setGoal(sessionID, null)
            verifying.delete(sessionID)
            const suffix = typeof args.summary === "string" && args.summary.trim() ? `\n${args.summary.trim()}` : ""
            if (!goal) return { content: `No active goal was set. Nothing to complete.${suffix}` }
            return { content: `Goal marked complete via goal_status: "${goal.text}"${suffix}` }
          }
          if (args?.status === "paused") {
            if (!goal) return { content: "No active goal to pause. Use /goal <objective> to set one." }
            if (goal.status === "paused") return { content: `Goal is already paused: "${goal.text}"` }
            await setGoal(sessionID, { ...goal, status: "paused", updatedAt: Date.now() })
            return { content: `Goal paused via goal_status: "${goal.text}"` }
          }
          if (args?.status === "active") {
            if (!goal) return { content: "No goal to resume. Use /goal <objective> to set one." }
            const resumed: GoalState = { ...goal, status: "active", updatedAt: Date.now() }
            await setGoal(sessionID, resumed)
            verifying.delete(sessionID)
            await ctx.session
              .prompt({ sessionID, text: continuePrompt(resumed.text, prefix) })
              .catch(() => undefined)
            return { content: `Goal resumed via goal_status: "${resumed.text}"` }
          }
          if (!goal) return { content: "No active goal. Use /goal <objective> to set one." }
          return { content: formatGoal(goal) }
        },
      })

      editor.add({
        name: "get_goal",
        description: "Get the active /goal for this session, including its status and auto-continue attempts.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async (_input, toolCtx) => {
          const sessionID = (toolCtx as unknown as { sessionID: string }).sessionID
          const goal = await getGoal(sessionID)
          if (!goal) return { content: "No active goal. Use /goal <objective> to set one." }
          return { content: formatGoal(goal) }
        },
      })

      editor.add({
        name: "pause",
        description: "Pause the active /goal. Auto-continuation stops until goal_resume is called or /goal resume runs.",
        input: {
          type: "object",
          properties: {
            reason: { type: "string", description: "Optional reason for pausing." },
          },
          additionalProperties: false,
        },
        options: { namespace: "goal" },
        execute: async (input, toolCtx) => {
          const sessionID = (toolCtx as unknown as { sessionID: string }).sessionID
          const goal = await getGoal(sessionID)
          if (!goal) return { content: "No active goal to pause. Use /goal <objective> to set one." }
          if (goal.status === "paused") return { content: `Goal is already paused: "${goal.text}"` }
          await setGoal(sessionID, { ...goal, status: "paused", updatedAt: Date.now() })
          const reason = (input as { reason?: unknown })?.reason
          const suffix = typeof reason === "string" && reason.trim() ? `\nReason: ${reason.trim()}` : ""
          return { content: `Goal paused: "${goal.text}"${suffix}` }
        },
      })

      editor.add({
        name: "resume",
        description: "Resume a paused /goal and immediately continue working toward it.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        options: { namespace: "goal" },
        execute: async (_input, toolCtx) => {
          const sessionID = (toolCtx as unknown as { sessionID: string }).sessionID
          const goal = await getGoal(sessionID)
          if (!goal) return { content: "No goal to resume. Use /goal <objective> to set one." }
          const resumed: GoalState = { ...goal, status: "active", updatedAt: Date.now() }
          await setGoal(sessionID, resumed)
          verifying.delete(sessionID)
          await ctx.session
            .prompt({ sessionID, text: continuePrompt(resumed.text, prefix) })
            .catch(() => undefined)
          return { content: `Goal resumed: "${resumed.text}"` }
        },
      })
    })

    // --- command: /goal ---
    await ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "Set an auto-verified goal: /goal <objective> | /goal status | /goal append <text> | /goal pause|resume|clear|complete",
        execute: async ({ sessionID, prompt, delivery }) => {
          const { kind, rest } = parseGoalArgs(prompt.text ?? "")
          const existing = await getGoal(sessionID)
          const now = Date.now()

          if (kind === "show") {
            await ctx.session.synthetic({
              sessionID,
              text: existing ? formatGoal(existing) : "No active goal. Usage: /goal <objective>",
            })
            return
          }

          if (kind === "clear") {
            await setGoal(sessionID, null)
            verifying.delete(sessionID)
            await ctx.session.synthetic({ sessionID, text: "Goal cleared." })
            return
          }

          if (kind === "pause") {
            if (!existing) {
              await ctx.session.synthetic({ sessionID, text: "No goal to pause." })
              return
            }
            await setGoal(sessionID, { ...existing, status: "paused", updatedAt: now })
            await ctx.session.synthetic({ sessionID, text: `Goal paused: "${existing.text}"` })
            return
          }

          if (kind === "resume") {
            if (!existing) {
              await ctx.session.synthetic({ sessionID, text: "No goal to resume." })
              return
            }
            const resumed: GoalState = { ...existing, status: "active", updatedAt: now }
            await setGoal(sessionID, resumed)
            await ctx.session.prompt({
              sessionID,
              text: continuePrompt(resumed.text, prefix),
              ...(delivery ? { delivery } : {}),
            })
            return
          }

          if (kind === "append") {
            if (!rest) {
              await ctx.session.synthetic({ sessionID, text: "Usage: /goal append <text>" })
              return
            }
            if (!existing) {
              await ctx.session.synthetic({ sessionID, text: "No goal to append to. Usage: /goal <objective>" })
              return
            }
            const next: GoalState = { ...existing, text: `${existing.text}\n${rest}`, status: "active", updatedAt: now }
            await setGoal(sessionID, next)
            await ctx.session.prompt({
              sessionID,
              text: continuePrompt(next.text, prefix),
              ...(delivery ? { delivery } : {}),
            })
            return
          }

          if (kind === "complete") {
            await setGoal(sessionID, null)
            verifying.delete(sessionID)
            await ctx.session.synthetic({
              sessionID,
              text: existing ? `Goal marked complete: "${existing.text}"${rest ? `\n${rest}` : ""}` : "No active goal.",
            })
            return
          }

          // kind === "set"
          if (!rest) {
            await ctx.session.synthetic({
              sessionID,
              text: existing ? formatGoal(existing) : "Usage: /goal <objective>",
            })
            return
          }
          const next: GoalState = {
            text: rest,
            status: "active",
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            attempts: 0,
          }
          await setGoal(sessionID, next)
          verifying.delete(sessionID)
          await ctx.session.prompt({
            sessionID,
            text: `Work toward this goal: "${next.text}"\n\nWhen fully done, call goal_complete (or goal_status with status "complete"). Keep working across turns until then; do not stop early to ask for confirmation.`,
            ...(delivery ? { delivery } : {}),
          })
        },
      })
    })

    // --- remind the model every turn while a goal is active ---
    await ctx.session.hook("context", async (event) => {
      try {
        const goal = await getGoal(event.sessionID)
        if (!goal || goal.status !== "active") return
        event.system.push({
          type: "text",
          text: `Active /goal: "${goal.text}" (attempt ${goal.attempts}). Keep working until done. When complete, call goal_complete with a summary, or goal_status with {"status":"complete"}. Do not end the turn with questions while the goal is incomplete; use tools and continue.`,
        } as any)
      } catch {
        // Reminder is best-effort; never break the model call.
      }
    })

    const handleIdle = async (sessionID: string) => {
      if (!sessionID || verifying.has(sessionID)) return
      let goal: GoalState | undefined
      try {
        goal = await getGoal(sessionID)
      } catch {
        return
      }
      if (!goal || goal.status !== "active") return
      if (maxAttempts > 0 && goal.attempts >= maxAttempts) {
        await setGoal(sessionID, null).catch(() => undefined)
        await ctx.session
          .synthetic({ sessionID, text: `Goal stopped after ${goal.attempts} auto-continue attempts (max ${maxAttempts}): "${goal.text}"` })
          .catch(() => undefined)
        return
      }

      verifying.add(sessionID)
      try {
        // 1) Verify with the *current* LLM (same model + session context).
        if (verify) {
          try {
            const verdict = await ctx.session.generate({ sessionID, prompt: verifierPrompt(goal.text) })
            // Re-read: the model may have called goal_complete during generation-adjacent turns.
            const fresh = await getGoal(sessionID).catch(() => undefined)
            if (!fresh) return // completed via tool
            if (verdict && isCompleteVerdict((verdict as { text: string }).text ?? "")) {
              await setGoal(sessionID, null).catch(() => undefined)
              await ctx.session
                .synthetic({ sessionID, text: `Goal verified complete: "${fresh.text}"\n${(verdict as { text: string }).text}` })
                .catch(() => undefined)
              return
            }
          } catch {
            // Verifier failure is non-fatal: fall through to auto-continue.
          }
        }

        // 2) Auto-continue. Re-check goal (tool may have completed it).
        const current = await getGoal(sessionID).catch(() => undefined)
        if (!current || current.status !== "active") return
        const next: GoalState = { ...current, attempts: current.attempts + 1, updatedAt: Date.now() }
        await setGoal(sessionID, next).catch(() => undefined)
        await ctx.session
          .prompt({ sessionID, text: continuePrompt(next.text, prefix) })
          .catch(() => undefined)
      } finally {
        verifying.delete(sessionID)
      }
    }

    const carryGoalOverCompaction = async (sessionID: string) => {
      let goal: GoalState | undefined
      try {
        goal = await getGoal(sessionID)
      } catch {
        return
      }
      if (!goal || goal.status !== "active") return
      await ctx.session
        .synthetic({
          sessionID,
          text: `Goal carried over compaction (attempts so far: ${goal.attempts}): "${goal.text}". Keep working toward it; call goal_complete (or goal_status with status "complete") when fully done.`,
        })
        .catch(() => undefined)
    }

    // --- turn-end detection: session.idle means the model ended its message ---
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            const type = (event as { type?: string }).type
            if (type === "session.idle") {
              const sid = (event as unknown as { data?: { sessionID?: string } }).data?.sessionID
              if (sid) void handleIdle(sid)
              continue
            }
            // After compaction the transcript is summarized: re-anchor the
            // goal as a synthetic message so it stays in context.
            if (type === "session.compaction.ended") {
              const sid = (event as unknown as { data?: { sessionID?: string } }).data?.sessionID
              if (sid) void carryGoalOverCompaction(sid)
              continue
            }
            // Hygiene: drop stored goals for deleted sessions (best-effort).
            if (type === "session.deleted") {
              const sid = (event as unknown as { data?: { sessionID?: string; info?: { id?: string } } }).data?.sessionID
              const alt = (event as unknown as { data?: { info?: { id?: string } } }).data?.info?.id
              const target = sid ?? alt
              if (target) {
                verifying.delete(target)
                void ctx.storage.remove(keyFor(target)).catch(() => undefined)
              }
            }
          } catch {
            // Never let one bad event kill the loop.
          }
        }
      } catch {
        // Subscribe ends on abort / reload; cleanup runs below.
      }
    })()

    return () => controller.abort()
  },
})

export default v2Plugin
