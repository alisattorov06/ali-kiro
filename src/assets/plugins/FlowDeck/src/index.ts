import { tool, type Plugin, type ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, readFileSync, readdirSync } from "fs"
import { basename, dirname, join } from "path"
import { fileURLToPath } from "url"

import {
  buildSelectionDiagnostics,
  detectProjectLanguages,
  getStartupRulePaths,
  selectRulePaths,
} from "./services/lazy-rule-loader"
import { LoopDetector } from "./services/loop-detector"

import { getAgentConfigs, getAgentRoutes } from "./agents/index"
import { loadFlowDeckConfig, resolveAgentModels, type FlowDeckConfig } from "./config/index"
import { sessionStartHook } from "./hooks/session-start"
import { sessionEventsHook } from "./hooks/session-events"
import { toolGuardHook } from "./hooks/tool-guard"
import { buildFlowDeckMcpsWithMeta } from "./mcp/index"
import { captureLessonTool, reviewLessonsTool } from "./tools/capture-lesson"
import { codebaseStateTool } from "./tools/codebase-state"
import { fdxValidateTool } from "./tools/fdx-validate"
import { fdxWorktreeTool } from "./tools/fdx-worktree"
import {
  fdxBatchTool,
  fdxContextTool,
  fdxDecisionsTool,
  fdxDiffTool,
  fdxGitTool,
  fdxGraphTool,
  fdxGrepTool,
  fdxImpactTool,
  fdxLintTool,
  fdxLsTool,
  fdxOutlineTool,
  fdxReadTool,
  fdxSearchTool,
  fdxTestTool,
  fdxTreeTool,
} from "./tools/fdx"
import { hashEditTool } from "./tools/hash-edit"
import { loadRulesTool, listRulesTool } from "./tools/load-rules"
import { planningStateTool } from "./tools/planning-state"
import { repoMemoryTool } from "./tools/repo-memory"

const __dir = dirname(fileURLToPath(import.meta.url))

/** Select FlowDeck rule paths for cfg.instructions injection (Step 4 will swap for a leaner loader). */
function lazyLoadRulePaths(projectRoot: string): { paths: string[]; diagnostics: string } {
  const rulesDir = join(__dir, "..", "src", "rules")
  if (!existsSync(rulesDir)) return { paths: [], diagnostics: "[LazyRuleLoader] rules directory not found" }
  const detected = detectProjectLanguages(projectRoot)
  const paths = getStartupRulePaths(rulesDir, detected)
  const selection = selectRulePaths(rulesDir, { languages: detected, projectRoot })
  return { paths, diagnostics: buildSelectionDiagnostics(selection, { languages: detected, projectRoot }) }
}

/** Load FlowDeck slash commands from src/commands/*.md (parses frontmatter description). */
function loadCommands(): Record<string, { description?: string; template: string }> {
  const dir = join(__dir, "..", "src", "commands")
  if (!existsSync(dir)) return {}
  const out: Record<string, { description?: string; template: string }> = {}
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue
      const raw = readFileSync(join(dir, file), "utf-8")
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
      const template = fm ? fm[2].trim() : raw
      const desc = fm?.[1].match(/^description:\s*(.+)$/m)?.[1].trim()
      out[basename(file, ".md")] = desc ? { description: desc, template } : { template }
    }
  } catch { /* ignore */ }
  return out
}

const plugin: Plugin = async ({ directory, client }) => {
  const appLog = (msg: string): Promise<void> =>
    client.app.log({ body: { service: "flowdeck", level: "info", message: msg } })
      .then(() => undefined).catch(() => {})

  let flowdeckConfig: FlowDeckConfig = loadFlowDeckConfig(directory)
  const loopDetector = new LoopDetector(flowdeckConfig.governance?.loopDetection, appLog)

  const { mcps } = buildFlowDeckMcpsWithMeta()

  return {
    name: "@dv.nghiem/flowdeck",
    agent: {},
    mcp: mcps,

    config: async (cfg: Record<string, unknown>) => {
      if (!(cfg as { default_agent?: string }).default_agent) {
        (cfg as { default_agent?: string }).default_agent = "orchestrator"
      }

      flowdeckConfig = loadFlowDeckConfig(directory)
      const resolvedAgents = getAgentConfigs(resolveAgentModels(flowdeckConfig))

      // Per-agent shallow merge: plugin defaults first, user overrides win.
      if (!cfg.agent) {
        cfg.agent = { ...resolvedAgents }
      } else {
        const existing = cfg.agent as Record<string, unknown>
        for (const [name, def] of Object.entries(resolvedAgents)) {
          existing[name] = existing[name] ? { ...def, ...existing[name] } : { ...def }
        }
      }

      const cfgMcp = cfg.mcp as Record<string, unknown> | undefined
      if (cfgMcp) Object.assign(cfgMcp, mcps)
      else cfg.mcp = { ...mcps }

      const commands = loadCommands()
      if (Object.keys(commands).length > 0) {
        if (!cfg.command || typeof cfg.command !== "object") cfg.command = {}
        const cfgCmd = cfg.command as Record<string, unknown>
        for (const [name, cmd] of Object.entries(commands)) {
          if (!cfgCmd[name]) cfgCmd[name] = cmd
        }
      }

      const skillsDir = join(__dir, "..", "src", "skills")
      if (existsSync(skillsDir)) {
        const cfgAny = cfg as Record<string, unknown>
        const skills = (cfgAny.skills && typeof cfgAny.skills === "object" ? cfgAny.skills : { paths: [] }) as { paths?: string[] }
        if (!skills.paths) skills.paths = []
        if (!skills.paths.includes(skillsDir)) skills.paths.push(skillsDir)
        cfgAny.skills = skills
      }

      const { paths: rulePaths, diagnostics } = lazyLoadRulePaths(directory)
      appLog(diagnostics)
      if (rulePaths.length > 0) {
        if (!Array.isArray(cfg.instructions)) cfg.instructions = []
        const seen = new Set(cfg.instructions as string[])
        for (const p of rulePaths) if (!seen.has(p)) (cfg.instructions as string[]).push(p)
      }
    },

    tool: {
      "planning-state": planningStateTool,
      "codebase-state": codebaseStateTool,
      "repo-memory": repoMemoryTool,
      "hash-edit": hashEditTool,
      "load-rules": loadRulesTool,
      "list-rules": listRulesTool,
      "capture-lesson": captureLessonTool,
      "review-lessons": reviewLessonsTool,
      "fdx-context": fdxContextTool,
      "fdx-decisions": fdxDecisionsTool,
      "fdx-validate": fdxValidateTool,
      "fdx-worktree": fdxWorktreeTool,
      "fdx-read": fdxReadTool,
      "fdx-search": fdxSearchTool,
      "fdx-grep": fdxGrepTool,
      "fdx-batch": fdxBatchTool,
      "fdx-graph": fdxGraphTool,
      "fdx-impact": fdxImpactTool,
      "fdx-outline": fdxOutlineTool,
      "fdx-diff": fdxDiffTool,
      "fdx-git": fdxGitTool,
      "fdx-ls": fdxLsTool,
      "fdx-tree": fdxTreeTool,
      "fdx-test": fdxTestTool,
      "fdx-lint": fdxLintTool,
    },

    "tool.execute.before": async (toolInput: any, toolOutput: any) => {
      // Tool guard (FLOWDECK_TOOL_GUARD_ENABLED=on) — blocks dangerous ops, enforces
      // architectural constraints and per-agent write limits.
      await toolGuardHook({ directory }, toolInput, toolOutput)
      const loop = loopDetector.checkBefore(
        toolInput.tool ?? toolInput.name ?? "unknown",
        toolOutput?.args ?? toolInput?.args ?? {},
        toolInput.sessionID ?? "",
      )
      if (loop.action === "block") throw new Error(loop.escalationMessage)
      if (loop.action === "warn") appLog(loop.message)
    },

    "tool.execute.after": async (toolInput: any) => {
      appLog(`[tool] done tool=${toolInput.tool ?? toolInput.name ?? "unknown"} session=${toolInput.sessionID ?? ""}`)
      // SDK's tool.execute.after only exposes toolInput (toolOutput is unavailable here).
      // Pass a sentinel for output so call-count tracking still works; if the SDK
      // includes output on toolInput, prefer it for hash-based loop detection.
      loopDetector.recordAfter(
        toolInput.tool ?? toolInput.name ?? "unknown",
        toolInput.args ?? {},
        toolInput.output ?? "[unavailable]",
        toolInput.sessionID ?? "",
      )
    },

    event: async ({ event }: { event: any }) => {
      const type: string = event?.type ?? ""
      if (type === "session.created" || type === "session.started") {
        await sessionStartHook({ directory }, appLog)
      } else if (type === "session.idle" || type === "session.error") {
        const sessionID = event?.properties?.sessionID ?? ""
        await sessionEventsHook({ directory }, type === "session.idle" ? "idle" : "error", sessionID)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// OpenCode V2 export
// ---------------------------------------------------------------------------
// OpenCode 2.x loads the default export and requires a { id, setup }
// definition (V1 function plugins are rejected). All V1 logic is reused:
// tools/hooks/events are adapted to the V2 single-event API below.

/**
 * V2 tool input schemas accept zod objects directly (ValueSchema includes
 * StandardSchemaV1), so the runtime validates + applies zod defaults exactly
 * like the V1 SDK did. This is the pattern used by the installed
 * opencode-dynamic-context-pruning V2 plugin on the same host runtime.
 */
function argsToValueSchema(def: ToolDefinition): unknown {
  return tool.schema.object(def.args)
}

type Disposable = { dispose?: () => unknown }

const pluginV2 = {
  id: "flowdeck",
  async setup(ctx: any) {
    const location = ctx?.location ?? {}
    const directory: string =
      location.project?.directory ?? location.project?.canonical ?? location.directory ?? process.cwd()

    const appLog = async (msg: string): Promise<void> => {
      try {
        console.log("[flowdeck]", msg)
      } catch {
        /* noop */
      }
    }

    const flowdeckConfig: FlowDeckConfig = loadFlowDeckConfig(directory)
    const loopDetector = new LoopDetector(flowdeckConfig.governance?.loopDetection, appLog)
    const { mcps } = buildFlowDeckMcpsWithMeta()

    const disposables: Disposable[] = []
    const keep = async (promise: unknown): Promise<void> => {
      const reg = (await (promise as Promise<Disposable | null>)) ?? null
      if (reg !== null && typeof reg === "object" && typeof reg.dispose === "function") {
        disposables.push(reg)
      }
    }

    // ---- Tools (~25) ------------------------------------------------------
    const TOOLS: Record<string, ToolDefinition> = {
      "planning-state": planningStateTool,
      "codebase-state": codebaseStateTool,
      "repo-memory": repoMemoryTool,
      "hash-edit": hashEditTool,
      "load-rules": loadRulesTool,
      "list-rules": listRulesTool,
      "capture-lesson": captureLessonTool,
      "review-lessons": reviewLessonsTool,
      "fdx-context": fdxContextTool,
      "fdx-decisions": fdxDecisionsTool,
      "fdx-validate": fdxValidateTool,
      "fdx-worktree": fdxWorktreeTool,
      "fdx-read": fdxReadTool,
      "fdx-search": fdxSearchTool,
      "fdx-grep": fdxGrepTool,
      "fdx-batch": fdxBatchTool,
      "fdx-graph": fdxGraphTool,
      "fdx-impact": fdxImpactTool,
      "fdx-outline": fdxOutlineTool,
      "fdx-diff": fdxDiffTool,
      "fdx-git": fdxGitTool,
      "fdx-ls": fdxLsTool,
      "fdx-tree": fdxTreeTool,
      "fdx-test": fdxTestTool,
      "fdx-lint": fdxLintTool,
    }

    if (ctx.tool?.transform) {
      await keep(
        ctx.tool.transform((editor: any) => {
          for (const [name, def] of Object.entries(TOOLS)) {
            const input = argsToValueSchema(def)
            editor.add({
              name,
              description: def.description,
              input,
              async execute(input: any, toolCtx: any) {
                const result = await def.execute(input, {
                  ...toolCtx,
                  directory: toolCtx?.directory ?? directory,
                  worktree: toolCtx?.worktree ?? directory,
                })
                // V1 executors return either a plain string (coerce to V2
                // { content }) or a result object ({output,metadata}).
                if (typeof result === "string") return { content: result }
                if (result && typeof result === "object") {
                  const obj = result as Record<string, any>
                  const out: Record<string, any> = {}
                  if (obj.output !== undefined) out.output = obj.output
                  if (obj.content !== undefined) out.content = obj.content
                  if (obj.metadata !== undefined) out.metadata = obj.metadata
                  if (out.output === undefined && out.content === undefined) {
                    out.content = JSON.stringify(result)
                  }
                  return out
                }
                return { content: String(result ?? "") }
              },
            })
          }
        }),
      )
    }

    // ---- tool.execute.before / tool.execute.after -------------------------
    if (ctx.tool?.hook) {
      await keep(
        ctx.tool.hook("execute.before", async (event: any) => {
          await toolGuardHook(
            { directory },
            {
              tool: event.tool,
              name: event.tool,
              sessionID: event.sessionID,
              agent: event.agent,
              args: event.input,
            },
            { args: event.input },
          )
          const loop = loopDetector.checkBefore(event.tool, event.input ?? {}, event.sessionID ?? "")
          if (loop.action === "block") throw new Error(loop.escalationMessage)
          if (loop.action === "warn") await appLog(loop.message)
        }),
      )

      await keep(
        ctx.tool.hook("execute.after", async (event: any) => {
          await appLog(`[tool] done tool=${event.tool} session=${event.sessionID ?? ""}`)
          let captured: unknown = "[unavailable]"
          if (event.status === "completed") {
            const r: any = event.result ?? {}
            if (typeof r.output === "string") captured = r.output
            else if (r.output !== undefined) captured = JSON.stringify(r.output)
            else if (typeof r.content === "string") captured = r.content
            else if (r.content !== undefined) captured = JSON.stringify(r.content)
          }
          loopDetector.recordAfter(event.tool, event.input ?? {}, captured, event.sessionID ?? "")
        }),
      )
    }

    // ---- Events (session.created/started/idle/error) ----------------------
    const ac = new AbortController()
    if (ctx.event?.subscribe) {
      void (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: ac.signal })) {
            const type: string = ev?.type ?? ""
            const sessionID: string = ev?.data?.sessionID ?? ev?.properties?.sessionID ?? ""
            if (type === "session.created" || type === "session.started") {
              await sessionStartHook({ directory }, appLog)
            } else if (
              type === "session.idle" ||
              type === "session.error" ||
              // V2 has no "session.error" — session.execution.failed is the closest match
              type === "session.execution.failed"
            ) {
              await sessionEventsHook(
                { directory },
                type === "session.idle" ? "idle" : "error",
                sessionID,
              )
            }
          }
        } catch {
          /* aborted during cleanup */
        }
      })()
    }

    // ---- MCPs --------------------------------------------------------------
    if (ctx.mcp?.transform) {
      await keep(
        ctx.mcp.transform((editor: any) => {
          for (const [name, cfg] of Object.entries(mcps)) {
            const c = cfg as any
            const adapted: any = { ...c }
            delete adapted.enabled
            if (typeof c.enabled === "boolean") adapted.disabled = !c.enabled
            editor.set(name, adapted)
          }
        }),
      )
    }

    // ---- Commands ----------------------------------------------------------
    const commands = loadCommands()
    if (ctx.command?.transform && Object.keys(commands).length > 0) {
      await keep(
        ctx.command.transform((editor: any) => {
          for (const [name, cmd] of Object.entries(commands)) {
            editor.add({
              name,
              description: cmd.description ?? `FlowDeck command: ${name}`,
              execute: async ({ sessionID, prompt, delivery }: any) => {
                const userText: string = prompt?.text ?? ""
                const text = cmd.template.includes("$ARGUMENTS")
                  ? cmd.template.replace(/\$ARGUMENTS/g, userText)
                  : userText.length > 0
                    ? `${cmd.template}\n\n${userText}`
                    : cmd.template
                if (ctx.session?.prompt) {
                  await ctx.session.prompt({ ...prompt, sessionID, text, delivery })
                } else {
                  await appLog(`command /${name} ran but ctx.session.prompt is unavailable`)
                }
              },
            })
          }
        }),
      )
    }

    // ---- Skills -------------------------------------------------------------
    const skillsDir = join(__dir, "..", "src", "skills")
    if (ctx.skill?.transform && existsSync(skillsDir)) {
      await keep(
        ctx.skill.transform((editor: any) => {
          for (const entryName of readdirSync(skillsDir)) {
            const skillFile = join(skillsDir, entryName, "SKILL.md")
            if (!existsSync(skillFile)) continue
            const raw = readFileSync(skillFile, "utf-8")
            const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
            const front = fm ? fm[1] : ""
            const field = (key: string): string | undefined =>
              front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim()
            const name = field("name") ?? entryName
            const description = field("description") ?? `FlowDeck skill: ${entryName}`
            editor.add({ id: entryName, name, description, path: skillFile, content: raw })
          }
        }),
      )
    }

    // ---- Instructions (lazy rule files → system prompt) --------------------
    const { paths: rulePaths, diagnostics } = lazyLoadRulePaths(directory)
    await appLog(diagnostics)
    if (rulePaths.length > 0 && ctx.session?.hook) {
      const blocks: { type: "text"; text: string }[] = []
      for (const p of rulePaths) {
        try {
          const content = readFileSync(p, "utf-8")
          blocks.push({ type: "text", text: `\n<!-- FlowDeck ${basename(p)} -->\n${content}` })
        } catch {
          /* skip unreadable rule file */
        }
      }
      if (blocks.length > 0) {
        await keep(
          ctx.session.hook("context", (event: any) => {
            if (Array.isArray(event.system)) event.system.push(...blocks)
          }),
        )
      }
    }

    // ---- Agents ------------------------------------------------------------
    // OpenCode V2 has no plugin API to register agents (ctx.agent is
    // read-only: list/get/default/update/remove only). FlowDeck's
    // orchestrator/per-role agents and default_agent are therefore skipped.
    await appLog(
      "OpenCode V2 does not support plugin-injected agents — skipping FlowDeck agents and default_agent=orchestrator",
    )

    return () => {
      try {
        ac.abort()
      } catch {
        /* noop */
      }
      for (const d of disposables) {
        try {
          d.dispose?.()
        } catch {
          /* noop */
        }
      }
    }
  },
}

export const FlowDeckPluginV1 = plugin
export default pluginV2
