/**
 * OpenCode V2 plugin entry for harness-memory.
 *
 * OpenCode 2.x loads the package-root default export and requires a
 * `{ id, setup }` plugin definition — the V1 function-style plugins are
 * rejected with `SchemaError: Missing key at ["default"]`.
 *
 * The V1 hook implementations in `./plugin/opencode-plugin` are reused
 * verbatim; `setup()` only adapts them to the V2 single-event signatures:
 *
 *   V1 chat.message                        → session hook "prompt"
 *   V1 chat.params                         → session hook "context" (model state)
 *   V1 experimental.chat.system.transform  → session hook "context" (system push)
 *   V1 session.compacted                   → session hook "compaction"
 *   V1 tool.execute.before                 → tool hook "execute.before"
 *   V1 tool.execute.after                  → tool hook "execute.after"
 *   V1 session.idle                        → event subscription loop
 *
 * Deviation notes:
 * - V1 `chat.params` never mutates output (despite its name), so the V2
 *   `context` hook has nothing to write into `event.options`; it only records
 *   the current model/session state, which the system.transform mapping reads.
 * - V1 `session.compacted` fired *after* a compaction completed. V2 has no
 *   faithful post-compaction hook in the documented API; we use the
 *   "compaction" session hook (runs for the compaction request itself). Same
 *   set of events, slightly earlier timing.
 * - V2 tool hooks carry no `title`; we derive one (metadata.title, then the
 *   bash command, then the tool name) for evidence titles.
 */

import { HarnessMemoryPlugin } from "./plugin/opencode-plugin";

// Keep the library API reachable from the package-root entry.
export * from "./index";
export { HarnessMemoryPlugin };

type AnyHook = (input: any, output?: any) => Promise<void>;

/** Best-effort human-readable text for a V2 Tool.Result. */
function toolResultToText(result: any): string {
  if (result === null || typeof result !== "object") return "";
  if (typeof result.output === "string") return result.output;
  if (typeof result.content === "string") return result.content;
  if (Array.isArray(result.content)) {
    const parts: string[] = [];
    for (const part of result.content) {
      if (
        part !== null &&
        typeof part === "object" &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        parts.push(part.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  if (result.output !== undefined) {
    try {
      return JSON.stringify(result.output);
    } catch {
      /* fall through */
    }
  }
  try {
    return JSON.stringify(result.content);
  } catch {
    return "";
  }
}

/** Best-effort tool-call title (V2 tool hooks expose no title field). */
function toolEventTitle(event: any): string {
  const meta = event.status === "error" ? event.error?.metadata : event.result?.metadata;
  if (meta && typeof meta.title === "string" && meta.title.length > 0) {
    return meta.title;
  }
  const input = event.input;
  if (
    event.tool === "bash" &&
    input !== null &&
    typeof input === "object" &&
    typeof input.command === "string" &&
    input.command.length > 0
  ) {
    return input.command;
  }
  return typeof event.tool === "string" ? event.tool : "tool";
}

/** Adapt a V2 execute.after event into the V1 `{title, output, metadata}` shape. */
function adaptToolAfterEvent(event: any): { title: string; output: string; metadata: unknown } {
  if (event.status === "error") {
    const err: any = event.error;
    let output = "";
    if (typeof err?.message === "string") {
      output = err.message;
    } else {
      try {
        output = JSON.stringify(err ?? "error");
      } catch {
        output = "error";
      }
    }
    return { title: toolEventTitle(event), output, metadata: err?.metadata ?? null };
  }

  const result: any = event.result;
  return {
    title: toolEventTitle(event),
    output: toolResultToText(result),
    metadata: result?.metadata ?? null,
  };
}

const plugin = {
  id: "harness-memory",
  async setup(ctx: any) {
    const location = ctx?.location ?? {};
    const directory: string =
      location.directory ??
      location.project?.directory ??
      location.project?.canonical ??
      process.cwd();

    const hooks = (await HarnessMemoryPlugin({
      directory,
      worktree: directory,
      project: location.project,
    })) as Record<string, AnyHook | undefined>;

    const registrations: Array<{ dispose?: () => unknown }> = [];
    const register = async (promise: unknown) => {
      const reg: any = await promise;
      if (reg && typeof reg === "object" && typeof reg.dispose === "function") {
        registrations.push(reg);
      }
    };

    // ---- V1 chat.message → session hook "prompt" -------------------------
    const onMessage = hooks["chat.message"];
    if (onMessage && ctx.session?.hook) {
      await register(
        ctx.session.hook("prompt", async (event: any) => {
          await onMessage(
            { sessionID: event.sessionID, messageID: event.messageID },
            // extractMessageText() reads parts[].text for the user message.
            { message: undefined, parts: [{ text: event.prompt?.text ?? "" }] },
          );
        }),
      );
    }

    // ---- V1 chat.params + system.transform → ONE "context" hook ----------
    // Registered as a single handler because V1 state is shared and ordering
    // matters: chat.params must run before system.transform on each call.
    const onParams = hooks["chat.params"];
    const onSystem = hooks["experimental.chat.system.transform"];
    if ((onParams || onSystem) && ctx.session?.hook) {
      await register(
        ctx.session.hook("context", async (event: any) => {
          if (onParams) {
            const ref: any = event.model;
            const model = {
              providerID: ref?.providerID ?? ref?.provider ?? "unknown",
              modelID: ref?.modelID ?? ref?.id ?? "unknown",
            };
            await onParams(
              { sessionID: event.sessionID, agent: event.agent, model },
              {},
            );
          }
          if (onSystem) {
            // V1 output.system is string[]; V2 event.system is SystemPart[]
            // ({type:"text", text}) — adapt on the way in.
            const system: string[] = [];
            await onSystem({ sessionID: event.sessionID }, { system });
            if (system.length > 0 && Array.isArray(event.system)) {
              for (const text of system) {
                if (typeof text === "string" && text.length > 0) {
                  event.system.push({ type: "text", text });
                } else if (text && typeof text === "object") {
                  event.system.push(text);
                }
              }
            }
          }
        }),
      );
    }

    // ---- V1 session.compacted → session hook "compaction" ---------------
    const onCompacted = hooks["session.compacted"];
    if (onCompacted && ctx.session?.hook) {
      await register(
        ctx.session.hook("compaction", async (event: any) => {
          await onCompacted({ sessionID: event.sessionID });
        }),
      );
    }

    // ---- V1 tool.execute.before → tool hook execute.before --------------
    const onBefore = hooks["tool.execute.before"];
    if (onBefore && ctx.tool?.hook) {
      await register(
        ctx.tool.hook("execute.before", async (event: any) => {
          await onBefore(
            { tool: event.tool, sessionID: event.sessionID, callID: event.id },
            // Same object reference as event.input: pendingToolArgs keeps it
            // for the after hook, and guard edits would propagate in place.
            { args: event.input },
          );
        }),
      );
    }

    // ---- V1 tool.execute.after → tool hook execute.after ----------------
    const onAfter = hooks["tool.execute.after"];
    if (onAfter && ctx.tool?.hook) {
      await register(
        ctx.tool.hook("execute.after", async (event: any) => {
          await onAfter(
            { tool: event.tool, sessionID: event.sessionID, callID: event.id },
            adaptToolAfterEvent(event),
          );
        }),
      );
    }

    // ---- V1 session.idle → event subscription loop ----------------------
    const onIdle = hooks["session.idle"];
    const ac = new AbortController();
    if (onIdle && ctx.event?.subscribe) {
      void (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: ac.signal })) {
            if (ev?.type === "session.idle") {
              // V2 events carry the payload under `data` (V1 used `properties`).
              const sessionID = ev?.data?.sessionID;
              if (sessionID) await onIdle({ sessionID });
            }
          }
        } catch {
          // Aborted during cleanup — subscription is over.
        }
      })();
    }

    return () => {
      try {
        ac.abort();
      } catch {
        /* noop */
      }
      for (const reg of registrations) {
        try {
          reg.dispose?.();
        } catch {
          /* noop */
        }
      }
    };
  },
};

export default plugin;