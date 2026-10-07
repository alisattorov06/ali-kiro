/**
 * Context Window Monitor
 * Warns when session token usage exceeds 70% of the context limit.
 * Appends a reminder to the next tool.execute.after output — once per session.
 *
 * Inspired by oh-my-openagent's context-window-monitor.ts.
 */

const CONTEXT_WARNING_THRESHOLD = 0.70
// Default to 200k tokens (Claude Sonnet 3.5+, Gemini 1.5 Pro, etc.)
// Override with FLOWDECK_CONTEXT_LIMIT env var
const DEFAULT_CONTEXT_LIMIT = Number(process.env.FLOWDECK_CONTEXT_LIMIT) || 200_000

interface TokenInfo {
  input: number
  output: number
  reasoning?: number
  cache?: { read: number; write: number }
}

interface CachedTokenState {
  tokens: TokenInfo
}

function contextReminder(usedPct: string, remainingPct: string, used: string, limit: string): string {
  return (
    `\n\n[FlowDeck Context Monitor]\n` +
    `Context: ${usedPct}% used (${used}/${limit} tokens), ${remainingPct}% remaining.\n` +
    `You still have context remaining — do NOT rush or skip tasks. Work thoroughly.`
  )
}

export function createContextWindowMonitorHook() {
  const remindedSessions = new Set<string>()
  const tokenCache = new Map<string, CachedTokenState>()

  const toolExecuteAfter = async (
    input: { sessionID: string },
    output: { output: string }
  ) => {
    const { sessionID } = input
    if (remindedSessions.has(sessionID)) return

    const cached = tokenCache.get(sessionID)
    if (!cached) return

    const { tokens } = cached
    const totalInput = (tokens.input ?? 0) + (tokens.cache?.read ?? 0)
    const usagePct = totalInput / DEFAULT_CONTEXT_LIMIT
    if (usagePct < CONTEXT_WARNING_THRESHOLD) return

    remindedSessions.add(sessionID)
    const usedPct = (usagePct * 100).toFixed(1)
    const remainingPct = ((1 - usagePct) * 100).toFixed(1)
    output.output += contextReminder(
      usedPct,
      remainingPct,
      totalInput.toLocaleString(),
      DEFAULT_CONTEXT_LIMIT.toLocaleString(),
    )
  }

  const event = async ({ event }: { event: { type: string; properties?: unknown } }) => {
    const props = event.properties as Record<string, unknown> | undefined

    if (event.type === "session.deleted") {
      const id = (props?.info as { id?: string } | undefined)?.id
      if (id) { remindedSessions.delete(id); tokenCache.delete(id) }
      return
    }

    if (event.type === "message.updated") {
      const info = props?.info as {
        role?: string
        sessionID?: string
        finish?: boolean
        tokens?: TokenInfo
      } | undefined
      if (!info || info.role !== "assistant" || !info.finish || !info.sessionID || !info.tokens) return
      tokenCache.set(info.sessionID, { tokens: info.tokens })
    }
  }

  return { "tool.execute.after": toolExecuteAfter, event }
}
