import { execFile } from "node:child_process"
import type { Hooks, Plugin } from "@opencode-ai/plugin"

// Delegates to `snip hook` (Claude Code PreToolUse format) so the rewrite rules
// stay in snip: only filtered commands are wrapped, pipes/redirects/heredocs and
// command substitutions are left raw. Any failure leaves the command untouched.
export function rewrite(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile("snip", ["hook"], { timeout: 2000 }, (error, stdout) => {
      if (error || !stdout.trim()) return resolve(undefined)
      try {
        const rewritten = JSON.parse(stdout).hookSpecificOutput?.updatedInput?.command
        resolve(typeof rewritten === "string" ? rewritten : undefined)
      } catch {
        resolve(undefined)
      }
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(JSON.stringify({ tool_name: "Bash", tool_input: { command } }))
  })
}

export const toolExecuteBefore: NonNullable<Hooks["tool.execute.before"]> = async (input, output) => {
  if (input.tool !== "bash") return

  const command = output.args.command
  if (!command || typeof command !== "string") return

  const rewritten = await rewrite(command)
  if (rewritten) output.args.command = rewritten
}

export const SnipPlugin: Plugin = async () => {
  // Probes `snip hook` rather than the binary alone: a snip without the hook
  // subcommand would otherwise leave every command unfiltered silently.
  if (!(await rewrite("git status"))) {
    console.warn("[snip] snip hook unavailable (binary missing or too old) — plugin disabled")
    return {}
  }

  return {
    "tool.execute.before": toolExecuteBefore,
  }
}

// V2 entry (OpenCode 2.x). V1 function plugins no longer load, so the default
// export is now a plain {id, setup} definition; the V1 shape above is kept for
// reference/compat. setup reuses the exact same probe + rewrite logic.
export const SnipPluginV2 = {
  id: "opencode-snip",
  async setup(ctx: {
    tool: {
      hook: (
        name: "execute.before",
        cb: (event: { tool: string; input: unknown }) => Promise<void> | void,
      ) => Promise<unknown> | unknown
    },
  }) {
    // Probes `snip hook` rather than the binary alone: a snip without the hook
    // subcommand would otherwise leave every command unfiltered silently.
    if (!(await rewrite("git status"))) {
      console.warn("[snip] snip hook unavailable (binary missing or too old) — plugin disabled")
      return
    }

    await ctx.tool.hook("execute.before", async (event) => {
      const output = event.input as { args?: { command?: unknown }; command?: unknown } | undefined
      // V1 passed (input, output) with args on output; V2 exposes the mutable
      // args object as event.input. Support both shapes defensively.
      const args =
        output && typeof output === "object" && "args" in output
          ? (output.args as { command?: unknown } | undefined)
          : (output as { command?: unknown } | undefined)
      if (!args || typeof args.command !== "string") return
      await toolExecuteBefore({ tool: event.tool } as never, { args } as never)
    })
  },
}

export default SnipPluginV2
