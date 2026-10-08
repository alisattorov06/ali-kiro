// ali-kiro — AI assistant catalog. One entry per supported tool.
//
// Install commands are OS-specific lists of:
//   { type: 'shell', line: 'curl -fsSL ... | bash', requires: ['curl'] }
//   { type: 'exec',  cmd: 'npm', args: [...],         requires: ['npm'] }
// `{arch}` placeholders in shell lines are interpolated with detectArch().
// Entries flagged `check` carry instructions for QA verification.

export const catalog = [
  {
    name: 'OpenCode',
    id: 'opencode',
    verifyCmd: 'opencode',
    verifyArg: ['--version'],
    homepage: 'https://opencode.ai/docs',
    needsNode: true,
    needsPython: false,
    check: 'linux/macOS via official install script; windows npm primary (winget id "OpenCode.OpenCode" unverified — flag for QA)',
    note: 'Flagship AI coding agent. The full-stack lane (config/plugins/skills/MCP/service) is applied after the binary is present.',
    manual: [
      'macOS/Linux:  curl -fsSL https://opencode.ai/install | bash',
      'macOS (brew): brew install anomalyco/tap/opencode',
      'Windows:      npm install -g opencode-ai   (alternatives: choco install opencode / scoop install opencode)',
    ],
    perOS: {
      linux: {
        type: 'script',
        cmds: [
          { type: 'shell', line: 'curl -fsSL https://opencode.ai/install | bash', requires: ['curl'] },
          { type: 'exec', cmd: 'npm', args: ['install', '-g', 'opencode-ai'], requires: ['npm'] },
        ],
      },
      macos: {
        type: 'script',
        cmds: [
          { type: 'shell', line: 'curl -fsSL https://opencode.ai/install | bash', requires: ['curl'] },
          { type: 'exec', cmd: 'npm', args: ['install', '-g', 'opencode-ai'], requires: ['npm'] },
        ],
      },
      windows: {
        type: 'npm',
        cmds: [{ type: 'exec', cmd: 'npm', args: ['install', '-g', 'opencode-ai'], requires: ['npm'] }],
      },
    },
  },
  {
    name: 'Claude Code',
    id: 'claude-code',
    verifyCmd: 'claude',
    verifyArg: ['--version'],
    homepage: 'https://docs.anthropic.com/en/docs/claude-code',
    needsNode: true,
    needsPython: false,
    check: '',
    note: 'Anthropic Claude Code — npm package @anthropic-ai/claude-code on all OS.',
    manual: ['npm install -g @anthropic-ai/claude-code'],
    perOS: {
      linux: { type: 'npm', cmds: [{ type: 'exec', cmd: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'], requires: ['npm'] }] },
      macos: { type: 'npm', cmds: [{ type: 'exec', cmd: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'], requires: ['npm'] }] },
      windows: { type: 'npm', cmds: [{ type: 'exec', cmd: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'], requires: ['npm'] }] },
    },
  },
  {
    name: 'Codex',
    id: 'codex',
    verifyCmd: 'codex',
    verifyArg: ['--version'],
    homepage: 'https://developers.openai.com/codex/',
    needsNode: true,
    needsPython: false,
    check: '',
    note: 'OpenAI Codex CLI — npm package @openai/codex on all OS.',
    manual: ['npm install -g @openai/codex'],
    perOS: {
      linux: { type: 'npm', cmds: [{ type: 'exec', cmd: 'npm', args: ['install', '-g', '@openai/codex'], requires: ['npm'] }] },
      macos: { type: 'npm', cmds: [{ type: 'exec', cmd: 'npm', args: ['install', '-g', '@openai/codex'], requires: ['npm'] }] },
      windows: { type: 'npm', cmds: [{ type: 'exec', cmd: 'npm', args: ['install', '-g', '@openai/codex'], requires: ['npm'] }] },
    },
  },
  {
    name: 'Cursor',
    id: 'cursor',
    verifyCmd: 'cursor',
    verifyArg: ['--version'],
    homepage: 'https://cursor.com/downloads',
    needsNode: false,
    needsPython: false,
    check: 'linux AppImage URL https://download.cursor.sh/linux/appimage/{arch} flagged for QA — cursor.com/downloads may rotate it',
    note: 'Cursor AI editor (desktop app). verify needs the binary on PATH (linux AppImage is symlinked into ~/.local/bin).',
    manual: [
      'macOS:   brew install --cask cursor',
      'Windows: winget install Anysphere.Cursor',
      'Linux:   download AppImage from https://cursor.com/downloads, chmod +x, symlink into ~/.local/bin/cursor',
    ],
    perOS: {
      linux: {
        type: 'appimage',
        cmds: [
          { type: 'shell', line: 'mkdir -p "$HOME/.local/bin"', requires: ['curl'] },
          { type: 'shell', line: 'curl -fsSL https://download.cursor.sh/linux/appimage/{arch} -o "$HOME/.local/bin/cursor.AppImage"', requires: ['curl'] },
          { type: 'shell', line: 'chmod +x "$HOME/.local/bin/cursor.AppImage" && ln -sf "$HOME/.local/bin/cursor.AppImage" "$HOME/.local/bin/cursor"' },
          { type: 'exec', cmd: 'brew', args: ['install', '--cask', 'cursor'], requires: ['brew'] },
        ],
      },
      macos: {
        type: 'brewCask',
        cmds: [{ type: 'exec', cmd: 'brew', args: ['install', '--cask', 'cursor'], requires: ['brew'] }],
      },
      windows: {
        type: 'winget',
        cmds: [{ type: 'exec', cmd: 'winget', args: ['install', 'Anysphere.Cursor'], requires: ['winget'] }],
      },
    },
  },
  {
    name: 'Aider',
    id: 'aider',
    verifyCmd: 'aider',
    verifyArg: ['--version'],
    homepage: 'https://aider.chat',
    needsNode: false,
    needsPython: true,
    check: '',
    note: 'AI pair programmer. Homebrew on macOS; pipx (or pip --user) elsewhere.',
    manual: ['macOS:   brew install aider', 'Linux/Windows: pipx install aider-chat   (or: pip install --user aider-chat)'],
    perOS: {
      linux: {
        type: 'pipx',
        cmds: [
          { type: 'exec', cmd: 'pipx', args: ['install', 'aider-chat'], requires: ['pipx'] },
          { type: 'exec', cmd: 'pip', args: ['install', '--user', 'aider-chat'], requires: ['pip'] },
        ],
      },
      macos: {
        type: 'brew',
        cmds: [
          { type: 'exec', cmd: 'brew', args: ['install', 'aider'], requires: ['brew'] },
          { type: 'exec', cmd: 'pipx', args: ['install', 'aider-chat'], requires: ['pipx'] },
        ],
      },
      windows: {
        type: 'pipx',
        cmds: [
          { type: 'exec', cmd: 'pipx', args: ['install', 'aider-chat'], requires: ['pipx'] },
          { type: 'exec', cmd: 'pip', args: ['install', '--user', 'aider-chat'], requires: ['pip'] },
        ],
      },
    },
  },
  {
    name: 'Gemini CLI',
    id: 'gemini',
    verifyCmd: 'gemini',
    verifyArg: ['--version'],
    homepage: 'https://github.com/google-gemini/gemini-cli',
    needsNode: true,
    needsPython: false,
    check: '',
    note: 'Google Gemini CLI — npm package @google/gemini-cli (Node 20+ recommended).',
    manual: ['npm install -g @google/gemini-cli'],
    perOS: {
      linux: { type: 'npm', cmds: [{ type: 'exec', cmd: 'npm', args: ['install', '-g', '@google/gemini-cli'], requires: ['npm'] }] },
      macos: { type: 'npm', cmds: [{ type: 'exec', cmd: 'npm', args: ['install', '-g', '@google/gemini-cli'], requires: ['npm'] }] },
      windows: { type: 'npm', cmds: [{ type: 'exec', cmd: 'npm', args: ['install', '-g', '@google/gemini-cli'], requires: ['npm'] }] },
    },
  },
  {
    name: 'Antigravity',
    id: 'antigravity',
    verifyCmd: 'agy',
    verifyArg: ['--version'],
    homepage: 'https://antigravity.google/product/antigravity-cli',
    needsNode: false,
    needsPython: false,
    check: '',
    note: 'Google Antigravity CLI — Terminal TUI (binary `agy`, installed to ~/.local/bin or %LOCALAPPDATA%\\agy\\bin). First `agy` run requires Google sign-in (browser flow). No npm package exists — do not use the npm "antigravity" placeholder.',
    manual: [
      'macOS/Linux:  curl -fsSL https://antigravity.google/cli/install.sh | bash',
      'macOS (brew): brew install --cask antigravity-cli',
      'Windows:      irm https://antigravity.google/cli/install.ps1 | iex   (alternatives: winget install --id Google.AntigravityCLI -e)',
    ],
    perOS: {
      linux: {
        type: 'script',
        cmds: [
          { type: 'shell', line: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', requires: ['curl'] },
          { type: 'exec', cmd: 'brew', args: ['install', '--cask', 'antigravity-cli'], requires: ['brew'] },
        ],
      },
      macos: {
        type: 'script',
        cmds: [
          { type: 'shell', line: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', requires: ['curl'] },
          { type: 'exec', cmd: 'brew', args: ['install', '--cask', 'antigravity-cli'], requires: ['brew'] },
        ],
      },
      windows: {
        type: 'script',
        cmds: [
          { type: 'shell', line: 'irm https://antigravity.google/cli/install.ps1 | iex', requires: ['pwsh'] },
          { type: 'exec', cmd: 'winget', args: ['install', '--id', 'Google.AntigravityCLI', '-e'], requires: ['winget'] },
        ],
      },
    },
  },
];

export function entryById(id) {
  return catalog.find((e) => e.id === id);
}

export const TOOL_IDS = catalog.map((e) => e.id);