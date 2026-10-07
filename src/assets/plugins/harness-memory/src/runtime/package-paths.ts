import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));
const PARENT_DIR = resolve(RUNTIME_DIR, "..");
// Bundles live at dist/<x>/ (RUNTIME_DIR=dist/<x> → parent=dist) or at dist/
// root (RUNTIME_DIR=dist → parent=package root, which has no dist assets).
const DIST_ROOT = existsSync(join(PARENT_DIR, "db", "migrations"))
  ? PARENT_DIR
  : RUNTIME_DIR;

function getPackagePath(...segments: string[]): string {
  return join(DIST_ROOT, ...segments);
}

export function getBundledMigrationPath(): string {
  return getPackagePath("db", "migrations", "001_initial_schema.sql");
}

export function readBundledMigrationSql(): string {
  return readFileSync(getBundledMigrationPath(), "utf-8");
}

export function getBundledMigrationsDir(): string {
  return getPackagePath("db", "migrations");
}

export function readBundledMigrationFiles(): Array<{
  filename: string;
  sql: string;
}> {
  return readdirSync(getBundledMigrationsDir())
    .filter((filename) => filename.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right))
    .map((filename) => ({
      filename,
      sql: readFileSync(join(getBundledMigrationsDir(), filename), "utf-8"),
    }));
}

export function getBundledBaselineScorecardPath(): string {
  return getPackagePath("research", "eval", "baseline-scorecard.csv");
}

export function getBundledTaskCorpusPath(): string {
  return getPackagePath("research", "eval", "task-corpus.md");
}

export function resolveConsumerPath(...segments: string[]): string {
  return resolve(process.cwd(), ...segments);
}

export function resolveEvalOutputDir(outputDir?: string): string {
  return outputDir === undefined
    ? resolveConsumerPath("research", "eval", "output")
    : resolve(outputDir);
}

export function resolveBaselineOutputDir(outputDir?: string): string {
  return outputDir === undefined
    ? resolveConsumerPath("research", "eval", "output", "baseline")
    : resolve(outputDir);
}
