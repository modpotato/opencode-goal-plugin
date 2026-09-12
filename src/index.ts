import { Plugin } from "@opencode/plugin"
import { z } from "zod"

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
 * - Turn-end detection via `session.execution.succeeded` (plus `session.idle`
 *   as a fallback — this server build never emits idle) triggers verify +
 *   auto-continue.
 * - Durable per-session state via `ctx.storage` (V2), in-memory + optional file (V1).
 */

type GoalStatus = "active" | "paused" | "blocked"

type GoalState = {
  text: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  attempts: number
  blockedReason?: string
}

type PluginOptions = {
  maxAttempts?: number
  verify?: boolean
  continuePrefix?: string
}

const DEFAULT_MAX_ATTEMPTS = 0
const keyFor = (sessionID: string) => `goal:${sessionID}`

// Guard against re-entrant verification loops (module-level so it survives
// across setup reloads within the same process). Entries expire so a reload
// mid-verification can never wedge a session forever (stale entry => ignored).
const verifying = new Map<string, number>()
// Stale threshold must exceed GENERATE_TIMEOUT_MS below: a run that is still
// verifying (slow model, huge context) must not be treated as stale while a
// second trigger arrives, but a reload mid-verification must never wedge a
// session forever.
const VERIFY_TTL_MS = 180_000
const GENERATE_TIMEOUT_MS = 120_000

function isVerifying(sessionID: string): boolean {
  const at = verifying.get(sessionID)
  if (at === undefined) return false
  if (Date.now() - at > VERIFY_TTL_MS) {
    verifying.delete(sessionID)
    return false
  }
  return true
}

function markVerifying(sessionID: string) {
  verifying.set(sessionID, Date.now())
}

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
  if (["block", "blocked", "stuck"].includes(cmd)) return { kind: "block", rest }
  if (["complete", "finish", "achieved"].includes(cmd)) return { kind: "complete", rest }
  // Default: whole raw string is the objective (allows `/goal fix login bug`).
  return { kind: "set", rest: trimmed }
}

function formatGoal(goal: GoalState): string {
  const base = `Goal [${goal.status}] (attempts: ${goal.attempts}): ${goal.text}`
  return goal.status === "blocked" && goal.blockedReason ? `${base}\nBlocked reason: ${goal.blockedReason}` : base
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
        status: g.status === "paused" ? "paused" : g.status === "blocked" ? "blocked" : "active",
        createdAt: typeof g.createdAt === "number" ? g.createdAt : Date.now(),
        updatedAt: typeof g.updatedAt === "number" ? g.updatedAt : Date.now(),
        attempts: typeof g.attempts === "number" ? g.attempts : 0,
        ...(typeof g.blockedReason === "string" && g.blockedReason.trim() ? { blockedReason: g.blockedReason } : {}),
      }
    }

    const setGoal = (sessionID: string, goal: GoalState | null) => {
      if (!goal) return ctx.storage.remove(keyFor(sessionID))
      // A reason only makes sense while blocked; drop the key entirely on any
      // other write so resume/pause/append can never resurrect a stale one.
      const stored: GoalState = { ...goal }
      if (stored.status !== "blocked") delete stored.blockedReason
      return ctx.storage.set(keyFor(sessionID), stored as any)
    }

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
          'Get the active /goal, or set its status. Call with {"status":"complete"} to finish, {"status":"paused"} to pause, {"status":"blocked","reason":"..."} to block, or {"status":"active"} to resume.',
        input: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["complete", "active", "paused", "blocked"], description: 'New goal status. Omit to just read the current goal.' },
            summary: { type: "string", description: "Optional summary when completing." },
            reason: { type: "string", description: "Required reason when marking blocked." },
          },
          additionalProperties: false,
        },
        options: { namespace: "goal" },
        execute: async (input, toolCtx) => {
          const sessionID = (toolCtx as unknown as { sessionID: string }).sessionID
          const args = input as { status?: string; summary?: string; reason?: string }
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
            verifying.delete(sessionID)
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
          if (args?.status === "blocked") {
            const reason = args?.reason ?? args?.summary
            if (typeof reason !== "string" || !reason.trim()) {
              return { content: "A reason is required to mark a goal blocked. What external problem makes it impossible?" }
            }
            if (!goal) return { content: "No active goal to block. Use /goal <objective> to set one." }
            const blocked: GoalState = { ...goal, status: "blocked", blockedReason: reason.trim(), updatedAt: Date.now() }
            await setGoal(sessionID, blocked)
            verifying.delete(sessionID)
            await ctx.session
              .synthetic({
                sessionID,
                text: `Goal marked BLOCKED via goal_status: "${goal.text}"\nReason: ${reason.trim()}`,
                resume: false,
              } as any)
              .catch(() => undefined)
            return { content: `Goal marked blocked via goal_status: "${goal.text}"\nReason: ${reason.trim()}` }
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
          verifying.delete(sessionID)
          const reason = (input as { reason?: unknown })?.reason
          const suffix = typeof reason === "string" && reason.trim() ? `\nReason: ${reason.trim()}` : ""
          return { content: `Goal paused: "${goal.text}"${suffix}` }
        },
      })

      editor.add({
        name: "resume",
        description: "Resume a paused or blocked /goal and immediately continue working toward it.",
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

      editor.add({
        name: "blocked",
        description:
          'Mark the active /goal as blocked when finishing is impossible due to an external, worldly problem you cannot resolve here (unreachable host, nonexistent machine, missing access). Do NOT use for ordinary difficulty, minor inconveniences, or uncertainty — keep working through those. A reason is required.',
        input: {
          type: "object",
          properties: {
            reason: { type: "string", description: "What external, unresolvable problem blocks the goal." },
          },
          required: ["reason"],
          additionalProperties: false,
        },
        options: { namespace: "goal" },
        execute: async (input, toolCtx) => {
          const sessionID = (toolCtx as unknown as { sessionID: string }).sessionID
          const goal = await getGoal(sessionID)
          const reason = (input as { reason?: unknown })?.reason
          if (typeof reason !== "string" || !reason.trim()) {
            return { content: "A reason is required to mark a goal blocked. What external problem makes it impossible?" }
          }
          if (!goal) return { content: "No active goal to block. Use /goal <objective> to set one." }
          if (goal.status === "blocked") {
            return { content: `Goal is already blocked: "${goal.text}"\nReason: ${goal.blockedReason ?? reason.trim()}` }
          }
          const blocked: GoalState = { ...goal, status: "blocked", blockedReason: reason.trim(), updatedAt: Date.now() }
          await setGoal(sessionID, blocked)
          verifying.delete(sessionID)
          await ctx.session
            .synthetic({
              sessionID,
              text: `Goal marked BLOCKED: "${goal.text}"\nReason: ${reason.trim()}\nThis needs the outside world to change. Resume with /goal resume (or goal_resume) once unblocked.`,
              resume: false,
            } as any)
            .catch(() => undefined)
          return { content: `Goal marked blocked: "${goal.text}"\nReason: ${reason.trim()}` }
        },
      })
    })

    // --- command: /goal ---
    await ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "Set an auto-verified goal: /goal <objective> | /goal status | /goal append <text> | /goal block <reason> | /goal pause|resume|clear|complete",
        execute: async ({ sessionID, prompt, delivery }) => {
          const { kind, rest } = parseGoalArgs(prompt.text ?? "")
          const existing = await getGoal(sessionID)
          const now = Date.now()

          if (kind === "show") {
            // Display-only: must not admit (resume) the model. Without
            // `resume: false` the status check itself starts an LLM run.
            await ctx.session.synthetic({
              sessionID,
              text: existing ? formatGoal(existing) : "No active goal. Usage: /goal <objective>",
              description: "Goal status",
              resume: false,
            } as any)
            return
          }

          if (kind === "clear") {
            await setGoal(sessionID, null)
            verifying.delete(sessionID)
            await ctx.session.synthetic({ sessionID, text: "Goal cleared.", resume: false } as any)
            return
          }

          if (kind === "pause") {
            if (!existing) {
              await ctx.session.synthetic({ sessionID, text: "No goal to pause.", resume: false } as any)
              return
            }
            await setGoal(sessionID, { ...existing, status: "paused", updatedAt: now })
            verifying.delete(sessionID)
            await ctx.session.synthetic({ sessionID, text: `Goal paused: "${existing.text}"`, resume: false } as any)
            return
          }

          if (kind === "resume") {
            if (!existing) {
              await ctx.session.synthetic({ sessionID, text: "No goal to resume.", resume: false } as any)
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
              await ctx.session.synthetic({ sessionID, text: "Usage: /goal append <text>", resume: false } as any)
              return
            }
            if (!existing) {
              await ctx.session.synthetic({ sessionID, text: "No goal to append to. Usage: /goal <objective>", resume: false } as any)
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

          if (kind === "block") {
            if (!rest) {
              await ctx.session.synthetic({
                sessionID,
                text: "Usage: /goal block <reason> — the reason is required so the blocker is recorded.",
                resume: false,
              } as any)
              return
            }
            if (!existing) {
              await ctx.session.synthetic({ sessionID, text: "No goal to block.", resume: false } as any)
              return
            }
            const blocked: GoalState = { ...existing, status: "blocked", blockedReason: rest, updatedAt: now }
            await setGoal(sessionID, blocked)
            verifying.delete(sessionID)
            await ctx.session.synthetic({
              sessionID,
              text: `Goal marked BLOCKED: "${existing.text}"\nReason: ${rest}\nResume with /goal resume once the outside world cooperates.`,
              resume: false,
            } as any)
            return
          }

          if (kind === "complete") {
            await setGoal(sessionID, null)
            verifying.delete(sessionID)
            await ctx.session.synthetic({
              sessionID,
              text: existing ? `Goal marked complete: "${existing.text}"${rest ? `\n${rest}` : ""}` : "No active goal.",
              resume: false,
            } as any)
            return
          }

          // kind === "set"
          if (!rest) {
            await ctx.session.synthetic({
              sessionID,
              text: existing ? formatGoal(existing) : "Usage: /goal <objective>",
              description: "Goal status",
              resume: false,
            } as any)
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
          text: `Active /goal: "${goal.text}" (attempt ${goal.attempts}). Keep working until done. When complete, call goal_complete with a summary, or goal_status with {"status":"complete"}. If finishing is impossible due to an external problem you cannot resolve (not ordinary difficulty), call goal_blocked with the reason instead of looping. Do not end the turn with questions while the goal is incomplete; use tools and continue.`,
        } as any)
      } catch {
        // Reminder is best-effort; never break the model call.
      }
    })

    const handleIdle = async (sessionID: string) => {
      if (!sessionID || isVerifying(sessionID)) return
      // Claim the guard FIRST (before any await) so two triggers racing on
      // the same run (e.g. session.idle + session.execution.succeeded) can't
      // both verify+prompt. Every path below clears it via finally.
      markVerifying(sessionID)
      try {
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
            .synthetic({ sessionID, text: `Goal stopped after ${goal.attempts} auto-continue attempts (max ${maxAttempts}): "${goal.text}"`, resume: false } as any)
            .catch(() => undefined)
          return
        }

        // 1) Verify with the *current* LLM (same model + session context).
        // Bounded: verification is best-effort and must never wedge the
        // drive loop (a hung verifier would stall continuation forever).
        if (verify) {
          try {
            const verdict = (await Promise.race([
              ctx.session.generate({ sessionID, prompt: verifierPrompt(goal.text) }),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("goal verifier timed out")), GENERATE_TIMEOUT_MS),
              ),
            ])) as { text: string }
            // Re-read: the model may have called goal_complete during generation-adjacent turns.
            const fresh = await getGoal(sessionID).catch(() => undefined)
            if (!fresh) return // completed via tool
            if (verdict && isCompleteVerdict(verdict.text ?? "")) {
              await setGoal(sessionID, null).catch(() => undefined)
              await ctx.session
                .synthetic({ sessionID, text: `Goal verified complete: "${fresh.text}"\n${verdict.text}`, resume: false } as any)
                .catch(() => undefined)
              return
            }
          } catch {
            // Verifier failure/timeout is non-fatal: fall through to auto-continue.
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

    // Forks get a new sessionID but plugin storage is keyed per session, so a
    // goal set before forking would silently disappear in the child ("plugin
    // not working in the fork"). Copy an unedited parent goal into the child.
    const inheritGoalForFork = async (newID: string, parentID?: string) => {
      try {
        const existing = await getGoal(newID).catch(() => undefined)
        if (existing) return
        let parent = parentID
        if (!parent) {
          try {
            const info = (await ctx.session.get({ sessionID: newID })) as unknown as {
              parentID?: string
              fork?: { sessionID?: string }
            }
            parent = info?.parentID ?? info?.fork?.sessionID
          } catch {
            return
          }
        }
        if (!parent || parent === newID) return
        const pg = await getGoal(parent).catch(() => undefined)
        if (!pg) return
        await setGoal(newID, { ...pg, updatedAt: Date.now() }).catch(() => undefined)
        await ctx.session
          .synthetic({
            sessionID: newID,
            text: `Goal inherited from forked session: "${pg.text}" [${pg.status}, attempts: ${pg.attempts}].`,
            resume: false,
          } as any)
          .catch(() => undefined)
      } catch {
        // best-effort: never break session creation
      }
    }

    const carryGoalOverCompaction = async (sessionID: string) => {
      let goal: GoalState | undefined
      try {
        goal = await getGoal(sessionID)
      } catch {
        return
      }
      if (!goal || goal.status === "paused") return
      if (goal.status === "blocked") {
        await ctx.session
          .synthetic({
            sessionID,
            text: `Goal still BLOCKED across compaction: "${goal.text}"\nReason: ${goal.blockedReason ?? "(no reason recorded)"}\nWaiting on the outside world; resume with /goal resume (or goal_resume) once unblocked.`,
            resume: false,
          } as any)
          .catch(() => undefined)
        return
      }
      await ctx.session
        .synthetic({
          sessionID,
          text: `Goal carried over compaction (attempts so far: ${goal.attempts}): "${goal.text}". Keep working toward it; call goal_complete (or goal_status with status "complete") when fully done.`,
        })
        .catch(() => undefined)
    }

    // --- turn-end detection ---
    // NOTE: `session.idle` exists in the protocol but this server build never
    // emits it (verified via event-tap: runs end with
    // `session.execution.succeeded` and no idle follows). Drive off the event
    // that actually fires; keep `session.idle` as a forward-compat fallback.
    // Deliberately NOT triggering on execution.failed/interrupted: re-prompting
    // a failing run would spin. The goal stays active; /goal resume restarts it.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            const type = (event as { type?: string }).type
            if (type === "session.idle" || type === "session.execution.succeeded") {
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
            // A forked child starts with no stored goal: inherit the parent's.
            if (type === "session.created") {
              const d = (event as unknown as { data?: { sessionID?: string; parentID?: string } }).data
              if (d?.sessionID) void inheritGoalForFork(d.sessionID, d.parentID)
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

// ---------------------------------------------------------------------------
// V1 compat (opencode 1.x): same behavior via V1 hooks.
// V2 ignores `server()`; V1 (>=1.18.29) calls it and ignores `setup()`.
// ---------------------------------------------------------------------------

async function v1Server(ctxV1: any) {
  const goals = new Map<string, GoalState>()
  const inFlight = new Set<string>()
  const maxAttempts = Number(ctxV1?.options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const prefix =
    typeof ctxV1?.options?.continuePrefix === "string" && String(ctxV1.options.continuePrefix).trim()
      ? String(ctxV1.options.continuePrefix).trim()
      : "Continue working toward the active goal."
  const client = ctxV1?.client

  const toast = (message: string) => {
    try {
      const p = client?.tui?.showToast?.({ body: { message, variant: "info", duration: 5000 } })
      if (p && typeof p.catch === "function") p.catch(() => undefined)
    } catch {
      // best-effort
    }
  }

  const promptAsync = (sessionID: string, text: string) =>
    client.session.promptAsync({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text }] },
    })

  const startContinuation = async (sessionID: string, goal: GoalState) => {
    if (inFlight.has(sessionID)) return
    inFlight.add(sessionID)
    try {
      const next: GoalState = { ...goal, attempts: goal.attempts + 1, updatedAt: Date.now() }
      goals.set(sessionID, next)
      await promptAsync(sessionID, continuePrompt(next.text, prefix)).catch((err: unknown) => {
        goals.set(sessionID, goal)
        toast(`Goal continuation failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    } finally {
      inFlight.delete(sessionID)
    }
  }

  const activate = (goal: GoalState): GoalState => {
    const next: GoalState = { ...goal, status: "active", updatedAt: Date.now() }
    delete next.blockedReason
    return next
  }

  const completeGoal = (sessionID: string, summary?: string) => {
    const goal = goals.get(sessionID)
    goals.delete(sessionID)
    inFlight.delete(sessionID)
    verifying.delete(sessionID)
    return goal ? `Goal marked complete: "${goal.text}"${summary ? `\n${summary}` : ""}` : "No active goal."
  }

  return {
    config: async (cfg: any) => {
      cfg.command ??= {}
      cfg.command.goal = {
        template: "",
        description: "Set an auto-verified goal: /goal <objective> | /goal status | /goal block <reason> | /goal clear",
      }
    },

    tool: {
      goal_complete: {
        description: "Mark the active /goal as complete. Call when every requirement is satisfied.",
        args: {
          summary: z.string().optional().describe("Short summary of how the goal was completed."),
        },
        async execute(args: any, context: any) {
          return completeGoal(context.sessionID, args?.summary)
        },
      },
      goal_status: {
        description: 'Get the active /goal, or pass {"status":"complete"|"paused"|"active"|"blocked"} to finish, pause, resume, or block it.',
        args: {
          status: z.enum(["complete", "active", "paused", "blocked"]).optional().describe("New goal status. Omit to just read."),
          summary: z.string().optional(),
          reason: z.string().optional().describe("Required reason when marking blocked."),
        },
        async execute(args: any, context: any) {
          if (args?.status === "complete") return completeGoal(context.sessionID, args?.summary)
          if (args?.status === "paused") {
            const goal = goals.get(context.sessionID)
            if (!goal) return "No active goal to pause."
            if (goal.status === "paused") return `Goal is already paused: "${goal.text}"`
            goals.set(context.sessionID, { ...goal, status: "paused", updatedAt: Date.now() })
            return `Goal paused: "${goal.text}"`
          }
          if (args?.status === "active") {
            const goal = goals.get(context.sessionID)
            if (!goal) return "No goal to resume."
            const resumed = activate(goal)
            goals.set(context.sessionID, resumed)
            void startContinuation(context.sessionID, resumed)
            return `Goal resumed: "${resumed.text}"`
          }
          if (args?.status === "blocked") {
            const reason = args?.reason ?? args?.summary
            if (typeof reason !== "string" || !reason.trim()) {
              return "A reason is required to mark a goal blocked. What external problem makes it impossible?"
            }
            const goal = goals.get(context.sessionID)
            if (!goal) return "No active goal to block."
            goals.set(context.sessionID, { ...goal, status: "blocked", blockedReason: reason.trim(), updatedAt: Date.now() })
            return `Goal marked blocked: "${goal.text}"\nReason: ${reason.trim()}`
          }
          const goal = goals.get(context.sessionID)
          return goal ? formatGoal(goal) : "No active goal. Use /goal <objective>."
        },
      },
      get_goal: {
        description: "Get the active /goal for this session, including status and attempts.",
        args: {},
        async execute(_args: any, context: any) {
          const goal = goals.get(context.sessionID)
          return goal ? formatGoal(goal) : "No active goal. Use /goal <objective>."
        },
      },
      goal_pause: {
        description: "Pause the active /goal. Auto-continuation stops until resumed.",
        args: {
          reason: z.string().optional().describe("Optional reason for pausing."),
        },
        async execute(args: any, context: any) {
          const goal = goals.get(context.sessionID)
          if (!goal) return "No active goal to pause."
          if (goal.status === "paused") return `Goal is already paused: "${goal.text}"`
          goals.set(context.sessionID, { ...goal, status: "paused", updatedAt: Date.now() })
          return `Goal paused: "${goal.text}"${args?.reason ? `\nReason: ${args.reason}` : ""}`
        },
      },
      goal_resume: {
        description: "Resume a paused or blocked /goal and immediately continue working toward it.",
        args: {},
        async execute(_args: any, context: any) {
          const goal = goals.get(context.sessionID)
          if (!goal) return "No goal to resume."
          const resumed = activate(goal)
          goals.set(context.sessionID, resumed)
          void startContinuation(context.sessionID, resumed)
          return `Goal resumed: "${resumed.text}"`
        },
      },
      goal_blocked: {
        description: "Mark the active /goal as blocked when finishing is impossible due to an external, worldly problem you cannot resolve here. Do NOT use for ordinary difficulty. A reason is required.",
        args: {
          reason: z.string().min(1).describe("What external, unresolvable problem blocks the goal."),
        },
        async execute(args: any, context: any) {
          const goal = goals.get(context.sessionID)
          if (!goal) return "No active goal to block."
          if (goal.status === "blocked") return `Goal is already blocked: "${goal.text}"\nReason: ${goal.blockedReason ?? args?.reason}`
          goals.set(context.sessionID, { ...goal, status: "blocked", blockedReason: args.reason.trim(), updatedAt: Date.now() })
          return `Goal marked blocked: "${goal.text}"\nReason: ${args.reason.trim()}`
        },
      },
    },

    event: async ({ event }: any) => {
      try {
        if (event?.type === "session.idle") {
          const sessionID = event?.properties?.sessionID
          if (!sessionID || isVerifying(sessionID)) return
          const goal = goals.get(sessionID)
          if (!goal || goal.status !== "active") return
          if (maxAttempts > 0 && goal.attempts >= maxAttempts) {
            goals.delete(sessionID)
            toast(`Goal stopped after ${goal.attempts} attempts: "${goal.text}"`)
            return
          }
          // V1 has no transient session.generate, so the verification *is* the
          // continued agent turn: remind it to call goal_complete when done.
          await startContinuation(sessionID, goal)
        }
        if (event?.type === "session.deleted") {
          const sid = event?.properties?.sessionID ?? event?.properties?.info?.id
          if (sid) {
            goals.delete(sid)
            verifying.delete(sid)
            inFlight.delete(sid)
          }
        }
      } catch {
        // never break host
      }
    },

    "experimental.session.compacting": async (input: any, output: any) => {
      try {
        const sessionID = (input as { sessionID?: string })?.sessionID
        const goal = sessionID ? goals.get(sessionID) : undefined
        if (!goal || !Array.isArray(output?.context)) return
        if (goal.status === "active") {
          output.context.push(
            `Active /goal that must survive compaction: "${goal.text}" [status: ${goal.status}, attempts: ${goal.attempts}]. Preserve this goal and the progress toward it in the summary; the session keeps working on it after compaction.`,
          )
        } else if (goal.status === "blocked") {
          output.context.push(
            `Blocked /goal that must survive compaction: "${goal.text}" [attempts: ${goal.attempts}]. Blocker: ${goal.blockedReason ?? "(no reason recorded)"}. Preserve this goal and its blocker in the summary; it stays blocked until resumed.`,
          )
        }
      } catch {
        // best-effort: never break compaction
      }
    },

    "command.execute.before": async (input: any) => {
      if (input?.command !== "goal") return
      const sessionID = input.sessionID as string
      const { kind, rest } = parseGoalArgs(input.arguments ?? "")
      const now = Date.now()
      const existing = goals.get(sessionID)

      // Management commands: toast + manual continuation, then cancel the
      // default (empty-template) LLM call like mirsella/opencode-goal does.
      const mod: any = await import("effect/unstable/http/HttpServerResponse").catch(() => null)
      const EffectHttp: any = mod?.default ?? mod
      const cancel = async (message: string): Promise<never> => {
        toast(message)
        if (EffectHttp?.empty) throw EffectHttp.empty()
        throw new Error("__goal_cancel__")
      }

      if (kind === "show") {
        return cancel(existing ? formatGoal(existing) : "Usage: /goal <objective>")
      }
      if (kind === "clear") {
        goals.delete(sessionID)
        verifying.delete(sessionID)
        inFlight.delete(sessionID)
        return cancel("Goal cleared.")
      }
      if (kind === "pause") {
        if (!existing) return cancel("No goal to pause.")
        goals.set(sessionID, { ...existing, status: "paused", updatedAt: now })
        return cancel(`Goal paused: "${existing.text}"`)
      }
      if (kind === "resume") {
        if (!existing) return cancel("No goal to resume.")
        const resumed = activate(existing)
        goals.set(sessionID, resumed)
        void startContinuation(sessionID, resumed)
        return cancel(`Goal resumed: "${resumed.text}"`)
      }
      if (kind === "append") {
        if (!rest) return cancel("Usage: /goal append <text>")
        if (!existing) return cancel("No goal to append to.")
        const next = activate({ ...existing, text: `${existing.text}\n${rest}` })
        goals.set(sessionID, next)
        void startContinuation(sessionID, next)
        return cancel(`Goal appended. Continuing: "${next.text}"`)
      }
      if (kind === "block") {
        if (!rest) return cancel("Usage: /goal block <reason> — the reason is required.")
        if (!existing) return cancel("No goal to block.")
        goals.set(sessionID, { ...existing, status: "blocked", blockedReason: rest, updatedAt: now })
        return cancel(`Goal marked BLOCKED: "${existing.text}"\nReason: ${rest}`)
      }
      if (kind === "complete") {
        return cancel(completeGoal(sessionID, rest || undefined))
      }
      if (!rest) return cancel(existing ? formatGoal(existing) : "Usage: /goal <objective>")
      const next: GoalState = {
        text: rest,
        status: "active",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        attempts: 0,
      }
      goals.set(sessionID, next)
      verifying.delete(sessionID)
      void startContinuation(sessionID, next)
      return cancel(`Goal active: "${next.text}"`)
    },
  }
}

export default {
  ...v2Plugin,
  server: v1Server,
}
