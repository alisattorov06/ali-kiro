// ali-kiro — CLI argument parsing. Unknown flags → UsageError (exit code 4).
import { TOOL_IDS } from '../core/ai-registry.mjs';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 4;
  }
}

const SHORT = {
  '-h': '--help',
  '-v': '--version',
  '-n': '--dry-run',
  '-y': '--yes',
  '-q': '--quiet',
};

const KNOWN = new Set([
  '--help',
  '--version',
  '--dry-run',
  '--yes',
  '--quiet',
  '--strict',
  '--target',
  '--only',
  '--skip',
  '--list',
  '--steps',
  '--no-config',
  '--no-plugins',
  '--no-skills',
  '--no-mcp',
  '--no-npm',
  '--demo',
]);

export const HELP = `ali-kiro — one-command installer/manager for AI coding assistants

USAGE
  ali-kiro [options]

GENERAL OPTIONS
  --help, -h            Show this help and exit
  --version, -v         Print version and exit
  --list                List the 7 known assistants with installed status
  --steps               Print the 7-step pipeline plan and exit
  --dry-run, -n         Print the plan only — make no changes (exit 0)
  --yes, -y             Non-interactive: pick all tools without the menu
  --quiet, -q           Suppress non-error output
  --strict              Abort on the first install/verify failure (default:
                        continue and report)
  --target <dir>        Install OpenCode config/plugins/skills/MCP into <dir>
                        instead of the default config dir (testing/portable)

SELECTION
  --only <id1,id2>      Install only the listed tools
  --skip <id1,id2>      Install everything except the listed tools
                        (ids: ${TOOL_IDS.join(', ')})

SCOPES (OpenCode full stack)
  --no-config           Skip config render
  --no-plugins          Skip plugins + dependency install + smoke tests
  --no-skills           Skip skills copy
  --no-mcp              Skip MCP server registration
  --no-npm              Skip install commands that need npm

DEMO
  --demo                Run a scripted fake session (no real installs)

EXIT CODES
  0  ok            1  environment problem     2  install failed
  3  verify failed 4  usage error

EXAMPLES
  ali-kiro --dry-run --target ~/ali-kiro-test
  ali-kiro --only opencode
  ali-kiro --skip cursor --yes
  ali-kiro --list`;

function splitList(v) {
  return String(v || '')
    .split(/[, ]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function validateIds(ids, flag) {
  for (const id of ids) {
    if (!TOOL_IDS.includes(id)) {
      throw new UsageError(`unknown tool id "${id}" for ${flag} (known ids: ${TOOL_IDS.join(', ')})`);
    }
  }
}

export function parseArgs(argv = []) {
  const out = {
    help: false,
    version: false,
    dryRun: false,
    yes: false,
    quiet: false,
    strict: false,
    target: null,
    only: [],
    skip: [],
    list: false,
    steps: false,
    noConfig: false,
    noPlugins: false,
    noSkills: false,
    noMcp: false,
    noNpm: false,
    demo: false,
    positional: [],
  };

  const args = [...argv];
  for (let i = 0; i < args.length; i++) {
    let flag = args[i];
    let inlineValue = null;
    const eq = flag.indexOf('=');
    if (flag.startsWith('--') && eq > 0) {
      inlineValue = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    if (Object.prototype.hasOwnProperty.call(SHORT, flag)) flag = SHORT[flag];

    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      i += 1;
      if (i >= args.length) throw new UsageError(`missing value for ${flag}`);
      return args[i];
    };

    switch (flag) {
      case '--help': out.help = true; break;
      case '--version': out.version = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--yes': out.yes = true; break;
      case '--quiet': out.quiet = true; break;
      case '--strict': out.strict = true; break;
      case '--list': out.list = true; break;
      case '--steps': out.steps = true; break;
      case '--demo': out.demo = true; break;
      case '--no-config': out.noConfig = true; break;
      case '--no-plugins': out.noPlugins = true; break;
      case '--no-skills': out.noSkills = true; break;
      case '--no-mcp': out.noMcp = true; break;
      case '--no-npm': out.noNpm = true; break;
      case '--target': out.target = takeValue(); break;
      case '--only': out.only = splitList(takeValue()); break;
      case '--skip': out.skip = splitList(takeValue()); break;
      default:
        if (flag.startsWith('-')) throw new UsageError(`unknown option: ${flag}`);
        out.positional.push(flag);
    }
  }

  validateIds(out.only, '--only');
  validateIds(out.skip, '--skip');
  return out;
}