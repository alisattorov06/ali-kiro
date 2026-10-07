import type { PluginInput } from '@opencode-ai/plugin';

/**
 * Returns the in-process OpenCode client for the given plugin directory.
 * The plugin host provides `input.client` — a direct in-process client into
 * the same OpenCode server the plugin runs inside. No loopback HTTP is
 * involved, and no client is cached: the host owns the client lifecycle.
 */
export function getClient(input: PluginInput): PluginInput['client'] {
  return input.client;
}
