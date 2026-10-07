/**
 * Register a command hook in the OpenCode config if it doesn't already exist.
 * Returns true if the command was registered, false if it already existed.
 */
export function registerCommandHook(
  opencodeConfig: Record<string, unknown>,
  commandName: string,
  template: string,
  description: string,
): boolean {
  const cmdConfig = (opencodeConfig as { command?: Record<string, unknown> })
    .command;
  if (cmdConfig?.[commandName]) return false;
  if (!opencodeConfig.command)
    (opencodeConfig as Record<string, unknown>).command = {};
  (
    (opencodeConfig as Record<string, unknown>).command as Record<
      string,
      unknown
    >
  )[commandName] = { template, description };
  return true;
}

/**
 * Sole decision surface for slash-command registration: every
 * `registerCommand` call must consult this before touching the OpenCode
 * config. A command is disabled when its name is listed in
 * `disabledCommands`; `/reflect` additionally follows the `reflect` skill
 * so `disabled_skills: ['reflect']` also unregisters the command.
 */
export function isCommandEnabled(
  commandName: string,
  options: {
    disabledCommands?: ReadonlySet<string>;
    disabledSkills?: readonly string[];
  } = {},
): boolean {
  if (options.disabledCommands?.has(commandName)) return false;
  if (commandName === 'reflect' && options.disabledSkills?.includes('reflect'))
    return false;
  return true;
}
