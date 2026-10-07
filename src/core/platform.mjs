// ali-kiro — platform detection & environment helpers. Node builtins only.
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** "linux" | "macos" | "windows" */
export function detectOS() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

/** "x64" | "arm64" — the string variants package managers use. */
export function detectArch() {
  const map = {
    x64: 'x64',
    amd64: 'x64',
    ia32: 'x64',
    arm64: 'arm64',
    aarch64: 'arm64',
    arm: 'arm64',
  };
  return map[process.arch] || process.arch;
}

export function homeDir() {
  return os.homedir();
}

/**
 * OpenCode config directory.
 * Precedence: --target override > Windows APPDATA\opencode > USERPROFILE\.config\opencode
 *            > unix XDG_CONFIG_HOME/opencode > ~/.config/opencode
 */
export function configDir({ target } = {}) {
  if (target) return path.resolve(target);
  if (detectOS() === 'windows') {
    if (process.env.APPDATA) return path.join(process.env.APPDATA, 'opencode');
    return path.join(process.env.USERPROFILE || homeDir(), '.config', 'opencode');
  }
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  return path.join(homeDir(), '.config', 'opencode');
}

/** ali-kiro own state directory (~/.ali-kiro). */
export function stateDir() {
  return path.join(homeDir(), '.ali-kiro');
}

export function isTTY() {
  return Boolean(process.stdout && process.stdout.isTTY);
}

export function isRoot() {
  if (process.platform === 'win32') return false;
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** Shell lookup helper: does `cmd` exist on PATH? Uses `which` / `where`. */
export function has(cmd) {
  try {
    const isWin = process.platform === 'win32';
    const probe = isWin ? 'where' : 'which';
    const r = spawnSync(probe, [cmd], { stdio: 'ignore', shell: isWin });
    return r.status === 0;
  } catch {
    return false;
  }
}

export const PM_NAMES = ['npm', 'bun', 'brew', 'winget', 'pipx', 'pip', 'curl', 'wget', 'pwsh'];

/** Package managers present on this machine (subset of PM_NAMES). */
export function pm() {
  return PM_NAMES.filter(has);
}

/** "cmd" | "powershell" | "sh" — for building command lines. Windows prefers powershell. */
export function shellStyle() {
  return detectOS() === 'windows' ? 'powershell' : 'sh';
}