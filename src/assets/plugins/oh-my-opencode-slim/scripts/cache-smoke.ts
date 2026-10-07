/**
 * Cache smoke — live end-to-end probe answering "is provider prompt caching
 * working in my setup right now?"
 *
 * Starts a real `opencode serve` using your normal global config, auth, and
 * plugin, runs scripted conversations against your default (or given)
 * provider/model, and reads the provider-reported cache telemetry that
 * OpenCode stores on every assistant message (`tokens.cache.read/write`,
 * normalized from Anthropic's cache_control usage fields and OpenAI's
 * `prompt_tokens_details.cached_tokens`).
 *
 * The scenarios are designed to trigger this plugin's payload-touching
 * machinery on purpose — phase reminders, direct file reads, todo
 * churn, background job board injection/reconciliation, repeated specialist
 * delegation with session reuse — so each injection path is validated
 * against a real provider, including the subagent child sessions it spawns.
 *
 * Usage:
 *   bun run cache:smoke [-- options]
 *
 * Options:
 *   --server URL        Use an already-running OpenCode server instead of
 *                       starting one (skips spawn/cleanup of the server).
 *   --provider ID       Route turns to this provider (requires --model).
 *   --model ID          Route turns to this model (requires --provider).
 *   --agent NAME        Agent for each turn (default: server default).
 *   --scenario LIST     Comma list of scenario names, or "extensive"/"all"
 *                       (default: plain,tools — the cheap probe).
 *   --turn-timeout-ms N Per-turn timeout (default 300000).
 *   --keep-sessions     Don't delete the probe sessions afterwards.
 *   --board-strategy S  Pin backgroundJobs.strategy ("latest" or
 *                       "checkpoint-compatible") via a scratch project
 *                       config — for A/B-ing issue #874. Spawned server only.
 *
 * Exit codes: 0 caching works · 1 bust detected · 2 inconclusive (provider
 * reported no cache telemetry) · 3 setup/runtime error.
 *
 * Each run costs real requests against your provider; the extensive set also
 * spawns background specialist sessions and takes several minutes. This is a
 * manual/operational probe, not a CI test — the CI-side guarantees live in
 * the cache-safety suites (see docs/cache-verification.md).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface Args {
  server?: string;
  provider?: string;
  model?: string;
  agent?: string;
  scenarios: string[];
  turnTimeoutMs: number;
  keepSessions: boolean;
  /** Force backgroundJobs.strategy via a scratch project config (issue #874 A/B). */
  boardStrategy?: 'latest' | 'checkpoint-compatible';
}

interface Turn {
  text: string;
  /** Wait after the turn completes (lets background work land). */
  pauseAfterMs?: number;
}

interface Scenario {
  name: string;
  description: string;
  /** Plugin machinery this scenario is designed to fire. */
  triggers: string;
  turns: (nonce: string) => Turn[];
}

interface RequestRow {
  messageID: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface SessionReport {
  label: string;
  rows: RequestRow[];
}

type Verdict = 'ok' | 'plateau' | 'bust' | 'inconclusive';

/**
 * Requests at or above this input size with zero cache reads (after the
 * first request of their session) count as suspect — comfortably above
 * every provider's minimum cacheable prefix (OpenAI 1024, Anthropic ≤4096).
 */
const SUSPECT_INPUT_THRESHOLD = 4096;

/**
 * Cache-read plateau detection (issue #874 signature): the reusable prefix
 * stops growing — `cache-read` stays frozen at the same nonzero value for
 * consecutive requests while sizeable uncached input keeps accumulating.
 * Distinct from a bust (reads never drop to zero). Small frozen streaks are
 * normal (providers round reads to ~128-token boundaries), so both
 * thresholds must be met.
 */
const PLATEAU_STREAK_THRESHOLD = 3;
const PLATEAU_INPUT_THRESHOLD = 6144;

interface PlateauFinding {
  frozenAt: number;
  requests: number;
  accumulatedInput: number;
}

const NO_TOOLS = 'Do not use any tools.';

const SCENARIOS: Scenario[] = [
  {
    name: 'plain',
    description: 'multi-turn conversation, no tools',
    triggers: 'phase reminder, skills filter, system transform',
    turns: (nonce) => [
      {
        text: `Cache smoke probe ${nonce}. Reply with exactly "ack 1" and nothing else. ${NO_TOOLS}`,
      },
      { text: `Reply with exactly "ack 2" and nothing else. ${NO_TOOLS}` },
      { text: `Reply with exactly "ack 3" and nothing else. ${NO_TOOLS}` },
    ],
  },
  {
    name: 'tools',
    description: 'tool loop within and across turns',
    triggers: 'tool-result growth across steps',
    turns: (nonce) => [
      {
        text: `Cache smoke probe ${nonce}. Read the file package.json in the current directory and reply with only the value of its "name" field.`,
      },
      { text: `Reply with exactly "ack done" and nothing else. ${NO_TOOLS}` },
    ],
  },
  {
    name: 'nudge',
    description: 'direct file read followed by phase reminders',
    triggers: 'direct file read, phase reminder across subsequent turns',
    turns: (nonce) => [
      {
        text: `Cache smoke probe ${nonce}. Do not delegate: use your read tool yourself on package.json and reply with only its "name" value.`,
      },
      { text: `Reply with exactly "ack nudged" and nothing else. ${NO_TOOLS}` },
      {
        text: `Reply with exactly "ack settled" and nothing else. ${NO_TOOLS}`,
      },
    ],
  },
  {
    name: 'todos',
    description: 'todo list created, updated, and completed across turns',
    triggers: 'todowrite churn, todo hygiene',
    turns: (nonce) => [
      {
        text: `Cache smoke probe ${nonce}. Use the todowrite tool to create exactly three todos named alpha, beta, gamma. Then reply with exactly "ack todos".`,
      },
      {
        text: 'Mark the todo alpha as completed and add a new todo named delta. Then reply with exactly "ack updated".',
      },
      {
        text: 'Mark every remaining todo as completed. Then reply with exactly "ack cleared".',
      },
      { text: `Reply with exactly "ack final" and nothing else. ${NO_TOOLS}` },
    ],
  },
  {
    name: 'long',
    description: 'six-turn conversation, growing history',
    triggers: 'sliding cache breakpoints over a long same-session history',
    turns: (nonce) => [
      {
        text: `Cache smoke probe ${nonce}. Reply with exactly "ack 1" and nothing else. ${NO_TOOLS}`,
      },
      { text: `Name one prime number below 10. One word only. ${NO_TOOLS}` },
      { text: `Name one planet. One word only. ${NO_TOOLS}` },
      { text: `Name one color. One word only. ${NO_TOOLS}` },
      { text: `Name one weekday. One word only. ${NO_TOOLS}` },
      {
        text: `Reply with exactly "ack long done" and nothing else. ${NO_TOOLS}`,
      },
    ],
  },
  {
    name: 'board',
    description:
      'background task launched without waiting; board appears, completion lands, reconcile',
    triggers:
      'background job board trailing injection, injected completion message, reconciliation',
    turns: (nonce) => [
      {
        text: `Cache smoke probe ${nonce}. Launch exactly one background @explorer task that lists the files in the current directory. Do not wait for it — reply immediately with exactly "ack launched".`,
        pauseAfterMs: 30_000,
      },
      {
        text: 'Reconcile any completed background tasks now, then reply with exactly "ack reconciled".',
      },
      {
        text: `Reply with exactly "ack board done" and nothing else. ${NO_TOOLS}`,
      },
    ],
  },
  {
    name: 'board-churn',
    description:
      'many turns while background launches churn the job board between requests (issue #874 workload)',
    triggers:
      'board strip/re-append across consecutive requests; detects cache-read plateaus where the reusable prefix stops growing',
    turns: (nonce) => [
      {
        text: `Cache smoke probe ${nonce}. Launch exactly one background @explorer task that lists the files in the current directory. Do not wait — reply immediately with exactly "ack churn 1".`,
        pauseAfterMs: 20_000,
      },
      {
        text: `Reply with exactly "ack churn 2" and nothing else. ${NO_TOOLS}`,
      },
      {
        text: 'Launch exactly one background @explorer task that counts the lines in package.json. Do not wait — reply immediately with exactly "ack churn 3".',
        pauseAfterMs: 20_000,
      },
      {
        text: `Reply with exactly "ack churn 4" and nothing else. ${NO_TOOLS}`,
      },
      {
        text: 'Launch exactly one background @explorer task that reports the largest file in the current directory. Do not wait — reply immediately with exactly "ack churn 5".',
        pauseAfterMs: 20_000,
      },
      {
        text: 'Reconcile all completed background tasks now, then reply with exactly "ack reconciled".',
      },
      {
        text: `Reply with exactly "ack churn 7" and nothing else. ${NO_TOOLS}`,
      },
      {
        text: `Reply with exactly "ack churn 8" and nothing else. ${NO_TOOLS}`,
      },
    ],
  },
  {
    name: 'running-lane',
    description:
      'parent keeps talking while a background lane is still running (PR #871 window)',
    triggers:
      'running task tool_result sits mid-history across consecutive requests; byte churn there busts the cache tail',
    turns: (nonce) => [
      {
        text: `Cache smoke probe ${nonce}. Launch exactly one background @explorer task with this prompt: "Produce a very thorough report of at least 600 words describing every file in the current directory, its likely purpose, and recommendations." Do not wait for it — reply immediately with exactly "ack lane started".`,
      },
      {
        text: `Reply with exactly "ack while running" and nothing else. ${NO_TOOLS}`,
      },
      {
        text: `Reply with exactly "ack still running" and nothing else. ${NO_TOOLS}`,
        pauseAfterMs: 45_000,
      },
      {
        text: 'Reconcile any completed background tasks, then reply with exactly "ack lane done".',
      },
    ],
  },
  {
    name: 'agents',
    description:
      'repeated delegation: same specialist twice (session reuse), then a second specialist',
    triggers:
      'board churn across multiple tasks, task session reuse by alias, @mention rewriting, subagent session caching',
    turns: (nonce) => [
      {
        text: `Cache smoke probe ${nonce}. Launch a background @explorer task to list the files in the current directory. Wait for it to complete, then reply with exactly "ack explorer 1".`,
      },
      {
        text: 'Give @explorer one more task: report how many lines package.json has. Wait for completion, then reply with exactly "ack explorer 2".',
      },
      {
        text: 'Now launch a background @fixer task to create a file named hello.txt containing the single word "hi". Wait for completion, then reply with exactly "ack fixer".',
      },
      {
        text: `Reply with exactly "ack agents done" and nothing else. ${NO_TOOLS}`,
      },
    ],
  },
];

const CHEAP_SET = ['plain', 'tools'];
const EXTENSIVE_SET = SCENARIOS.map((scenario) => scenario.name);

let shuttingDown = false;
let spawnedServe:
  | { child: ReturnType<typeof spawn>; scratch?: string }
  | undefined;

function stopSpawnedServe(
  spawned: { child: ReturnType<typeof spawn> } | undefined,
  signal: NodeJS.Signals,
): void {
  const pid = spawned?.child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      spawned.child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function cleanupSpawnedServe(): void {
  shuttingDown = true;
  const spawned = spawnedServe;
  spawnedServe = undefined;
  if (!spawned) return;
  // The record is passed explicitly: the module global is already cleared,
  // and reading it here would skip both signals and orphan the serve group.
  stopSpawnedServe(spawned, 'SIGTERM');
  stopSpawnedServe(spawned, 'SIGKILL');
  if (spawned.scratch) {
    try {
      rmSync(spawned.scratch, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function fail(message: string): never {
  console.error(`\ncache-smoke: ${message}`);
  cleanupSpawnedServe();
  process.exit(3);
}

function installInterruptHandlers(): void {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => fail(`interrupted (${signal})`));
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    scenarios: CHEAP_SET,
    turnTimeoutMs: 300_000,
    keepSessions: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) fail(`missing value for ${flag}`);
      i += 1;
      return next;
    };
    switch (flag) {
      case '--server':
        args.server = value().replace(/\/$/, '');
        break;
      case '--provider':
        args.provider = value();
        break;
      case '--model':
        args.model = value();
        break;
      case '--agent':
        args.agent = value();
        break;
      case '--scenario': {
        const requested = value();
        if (requested === 'all' || requested === 'extensive') {
          args.scenarios = EXTENSIVE_SET;
          break;
        }
        const names = requested.split(',');
        for (const name of names) {
          if (!SCENARIOS.some((scenario) => scenario.name === name)) {
            fail(
              `unknown scenario "${name}" (${EXTENSIVE_SET.join(' | ')} | extensive | all)`,
            );
          }
        }
        args.scenarios = names;
        break;
      }
      case '--turn-timeout-ms':
        args.turnTimeoutMs = Number(value());
        break;
      case '--keep-sessions':
        args.keepSessions = true;
        break;
      case '--board-strategy': {
        const strategy = value();
        if (strategy !== 'latest' && strategy !== 'checkpoint-compatible') {
          fail('--board-strategy must be "latest" or "checkpoint-compatible"');
        }
        args.boardStrategy = strategy;
        break;
      }
      default:
        fail(`unknown flag ${flag}`);
    }
  }
  if (!!args.provider !== !!args.model) {
    fail('--provider and --model must be given together');
  }
  if (args.boardStrategy && args.server) {
    fail(
      '--board-strategy requires a spawned server (it writes a scratch project config); drop --server',
    );
  }
  if (!Number.isFinite(args.turnTimeoutMs) || args.turnTimeoutMs <= 0) {
    fail('--turn-timeout-ms must be a positive number');
  }
  return args;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate a port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

async function request(
  base: string,
  method: string,
  route: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<unknown> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${method} ${route} returned HTTP ${response.status}`);
  }
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function waitForHealth(base: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/global/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('server did not become healthy within 40s');
}

function extractAssistantRows(rawMessages: unknown): RequestRow[] {
  if (!Array.isArray(rawMessages)) return [];
  const rows: RequestRow[] = [];
  for (const raw of rawMessages) {
    const info = isRecord(raw) && isRecord(raw.info) ? raw.info : undefined;
    if (info?.role !== 'assistant') continue;
    const tokens = isRecord(info.tokens) ? info.tokens : undefined;
    if (!tokens) continue;
    const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
    rows.push({
      messageID: typeof info.id === 'string' ? info.id : '?',
      input: finiteNumber(tokens.input),
      output: finiteNumber(tokens.output),
      cacheRead: finiteNumber(cache?.read),
      cacheWrite: finiteNumber(cache?.write),
    });
  }
  return rows;
}

async function fetchSessionRows(
  base: string,
  sessionID: string,
): Promise<RequestRow[]> {
  const rawMessages = await request(
    base,
    'GET',
    `/session/${encodeURIComponent(sessionID)}/message`,
  );
  return extractAssistantRows(rawMessages);
}

async function listChildSessions(
  base: string,
  parentID: string,
): Promise<Array<{ id: string; title: string }>> {
  const raw = await request(base, 'GET', '/session').catch(() => undefined);
  if (!Array.isArray(raw)) return [];
  const children: Array<{ id: string; title: string }> = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (item.parentID !== parentID || typeof item.id !== 'string') continue;
    children.push({
      id: item.id,
      title: typeof item.title === 'string' ? item.title : item.id,
    });
  }
  return children;
}

/** Suspect = non-first request with a sizeable prompt and zero cache reads. */
function suspectRows(rows: RequestRow[]): RequestRow[] {
  return rows
    .slice(1)
    .filter(
      (row) => row.cacheRead === 0 && row.input >= SUSPECT_INPUT_THRESHOLD,
    );
}

/**
 * Issue #874 signature: cache-read frozen at the same nonzero value across
 * consecutive requests while sizeable uncached input accumulates — the
 * reusable prefix has stopped growing even though nothing reads zero.
 */
function findPlateau(rows: RequestRow[]): PlateauFinding | undefined {
  let worst: PlateauFinding | undefined;
  let streak = 1;
  let accumulatedInput = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.cacheRead > 0 && row.cacheRead === rows[i - 1].cacheRead) {
      streak += 1;
      accumulatedInput += row.input;
      if (
        streak >= PLATEAU_STREAK_THRESHOLD &&
        accumulatedInput >= PLATEAU_INPUT_THRESHOLD &&
        (!worst || accumulatedInput > worst.accumulatedInput)
      ) {
        worst = {
          frozenAt: row.cacheRead,
          requests: streak,
          accumulatedInput,
        };
      }
    } else {
      streak = 1;
      accumulatedInput = 0;
    }
  }
  return worst;
}

function judge(reports: SessionReport[]): Verdict {
  const allRows = reports.flatMap((report) => report.rows);
  if (allRows.length < 2) return 'inconclusive';
  const anyTelemetry = allRows.some(
    (row) => row.cacheRead > 0 || row.cacheWrite > 0,
  );
  if (!anyTelemetry) return 'inconclusive';
  const suspects = reports.flatMap((report) => suspectRows(report.rows));
  if (suspects.length > 0) return 'bust';
  const plateaued = reports.some((report) => findPlateau(report.rows));
  return plateaued ? 'plateau' : 'ok';
}

function coverage(rows: RequestRow[]): string {
  const later = rows.slice(1);
  const read = later.reduce((sum, row) => sum + row.cacheRead, 0);
  const input = later.reduce((sum, row) => sum + row.input, 0);
  const denominator = read + input;
  return denominator > 0
    ? `${((read / denominator) * 100).toFixed(1)}%`
    : 'n/a';
}

function printSessionTable(report: SessionReport): void {
  console.log(`  ${report.label}`);
  if (report.rows.length === 0) {
    console.log('    no assistant requests with token telemetry recorded');
    return;
  }
  console.log(
    '    req  input      output   cache-read  cache-write  read-coverage',
  );
  const suspects = new Set(suspectRows(report.rows));
  report.rows.forEach((row, index) => {
    const denominator = row.input + row.cacheRead;
    const rowCoverage =
      denominator > 0
        ? `${((row.cacheRead / denominator) * 100).toFixed(1)}%`
        : 'n/a';
    const marker = suspects.has(row) ? '  ← SUSPECT' : '';
    console.log(
      `    #${String(index + 1).padEnd(3)}${String(row.input).padEnd(11)}${String(row.output).padEnd(9)}${String(row.cacheRead).padEnd(12)}${String(row.cacheWrite).padEnd(13)}${rowCoverage}${marker}`,
    );
  });
  console.log(
    `    cache-read coverage after first request: ${coverage(report.rows)}`,
  );
  const plateau = findPlateau(report.rows);
  if (plateau) {
    console.log(
      `    ⚠ plateau: cache-read frozen at ${plateau.frozenAt} for ${plateau.requests} consecutive requests while ${plateau.accumulatedInput} uncached input tokens accumulated`,
    );
  }
}

function printScenarioReport(
  scenario: Scenario,
  reports: SessionReport[],
  verdict: Verdict,
): void {
  console.log(`\n━━ scenario: ${scenario.name} (${scenario.description})`);
  console.log(`  triggers: ${scenario.triggers}`);
  for (const report of reports) {
    printSessionTable(report);
  }
  const labels: Record<Verdict, string> = {
    ok: '✅ every sizeable follow-up request read the provider cache',
    plateau:
      '⚠️ cache-read plateaued — reads never dropped to zero, but the reusable prefix stopped growing while input accumulated (issue #874 signature)',
    bust: '❌ SUSPECT requests above read 0 cached tokens — the prompt prefix changed between requests',
    inconclusive:
      '⚠️ provider reported no cache telemetry — cannot verify (provider may not support or report caching)',
  };
  console.log(`  verdict: ${labels[verdict]}`);
}

async function runScenario(
  base: string,
  args: Args,
  scenario: Scenario,
): Promise<{ reports: SessionReport[]; verdict: Verdict }> {
  const created = await request(base, 'POST', '/session', {});
  const sessionID = isRecord(created) ? String(created.id ?? '') : '';
  if (!sessionID) throw new Error('POST /session returned no session id');
  const cleanupIDs = [sessionID];

  try {
    const nonce = crypto.randomUUID();
    for (const turn of scenario.turns(nonce)) {
      await request(
        base,
        'POST',
        `/session/${encodeURIComponent(sessionID)}/message`,
        {
          ...(args.agent ? { agent: args.agent } : {}),
          ...(args.provider && args.model
            ? { model: { providerID: args.provider, modelID: args.model } }
            : {}),
          parts: [{ type: 'text', text: turn.text }],
        },
        args.turnTimeoutMs,
      );
      if (turn.pauseAfterMs) {
        console.log(
          `  (waiting ${Math.round(turn.pauseAfterMs / 1000)}s for background work…)`,
        );
        await new Promise((resolve) => setTimeout(resolve, turn.pauseAfterMs));
      }
    }

    const reports: SessionReport[] = [
      {
        label: `session ${sessionID} (main)`,
        rows: await fetchSessionRows(base, sessionID),
      },
    ];
    for (const child of await listChildSessions(base, sessionID)) {
      cleanupIDs.push(child.id);
      reports.push({
        label: `session ${child.id} (subagent: ${child.title})`,
        rows: await fetchSessionRows(base, child.id),
      });
    }
    return { reports, verdict: judge(reports) };
  } finally {
    if (!args.keepSessions) {
      for (const id of cleanupIDs.reverse()) {
        await request(
          base,
          'DELETE',
          `/session/${encodeURIComponent(id)}`,
        ).catch(() => {});
      }
    } else {
      console.log(`  sessions kept: ${cleanupIDs.join(', ')}`);
    }
  }
}

async function main(): Promise<void> {
  installInterruptHandlers();
  const args = parseArgs(process.argv.slice(2));

  let base = args.server;
  let scratch: string | undefined;

  if (!base) {
    const binary = process.env.OPENCODE_BIN ?? Bun.which('opencode');
    if (!binary) {
      fail(
        'opencode binary not found — install opencode or set OPENCODE_BIN, or pass --server URL',
      );
    }
    scratch = mkdtempSync(path.join(tmpdir(), 'cache-smoke-'));
    writeFileSync(
      path.join(scratch, 'package.json'),
      `${JSON.stringify({ name: 'cache-smoke-fixture', version: '0.0.0' }, null, 2)}\n`,
    );
    if (args.boardStrategy) {
      // Project-local plugin config overrides the user config, pinning the
      // board strategy for this run regardless of global settings.
      mkdirSync(path.join(scratch, '.opencode'), { recursive: true });
      writeFileSync(
        path.join(scratch, '.opencode', 'oh-my-opencode-slim.json'),
        `${JSON.stringify(
          {
            backgroundJobs: {
              strategy: args.boardStrategy,
              maxRetainedSnapshots: 20,
            },
          },
          null,
          2,
        )}\n`,
      );
      console.log(
        `board strategy pinned via project config: ${args.boardStrategy}`,
      );
    }
    const port = await getFreePort();
    base = `http://127.0.0.1:${port}`;
    console.log(`starting opencode serve on ${base} (cwd: ${scratch})`);
    const child = spawn(
      binary,
      ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
      {
        cwd: scratch,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    spawnedServe = { child, scratch };
    const stderrChunks: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(String(chunk));
    });
    child.once('exit', (code) => {
      if (shuttingDown) return;
      if (code !== null && code !== 0) {
        console.error(stderrChunks.join('').slice(-2000));
        fail(`opencode serve exited early with code ${code}`);
      }
    });
    await waitForHealth(base);
  }

  try {
    const scenarios = SCENARIOS.filter((scenario) =>
      args.scenarios.includes(scenario.name),
    );
    const verdicts: Verdict[] = [];
    for (const scenario of scenarios) {
      console.log(`\nrunning scenario: ${scenario.name}…`);
      const { reports, verdict } = await runScenario(base, args, scenario);
      printScenarioReport(scenario, reports, verdict);
      verdicts.push(verdict);
    }

    console.log('');
    if (verdicts.includes('bust')) {
      console.log(
        'RESULT: ❌ cache bust detected. Cross-check the plugin build (bun run build), then use docs/cache-verification.md to localize the changing prefix byte.',
      );
      process.exitCode = 1;
    } else if (verdicts.includes('plateau')) {
      console.log(
        'RESULT: ⚠️ cache-read plateau detected — the reusable prefix stopped growing (issue #874). Compare board strategies with --board-strategy latest vs checkpoint-compatible.',
      );
      process.exitCode = 1;
    } else if (verdicts.every((verdict) => verdict === 'inconclusive')) {
      console.log(
        'RESULT: ⚠️ inconclusive — the provider reported no cache telemetry for any request.',
      );
      process.exitCode = 2;
    } else {
      console.log(
        'RESULT: ✅ provider prompt caching is working across the tested scenarios.',
      );
    }
  } finally {
    cleanupSpawnedServe();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
