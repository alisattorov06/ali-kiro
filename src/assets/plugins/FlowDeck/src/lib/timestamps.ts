import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs"
import { join, extname } from "path"
import { createHash } from "crypto"

export interface FileMetadata {
  mtime: number   // milliseconds since epoch
  size: number
  hash: string    // sha256 hex
  type: string    // extension with dot, e.g. ".ts"
}

export interface FileCheckResult {
  changed: boolean
  reason?: 'new' | 'mtime_changed' | 'hash_changed'
  currentMeta?: FileMetadata
}

export interface TimestampsData {
  version: string  // "1.0"
  last_run: string  // ISO timestamp
  files: Record<string, FileMetadata>
  signatures: Record<string, string[]>
}

export function loadTimestamps(dir: string): TimestampsData | null {
  const path = join(dir, ".codebase", ".meta", "timestamps.json")
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as TimestampsData
  } catch {
    return null
  }
}

export function saveTimestamps(dir: string, data: TimestampsData): void {
  const metaDir = join(dir, ".codebase", ".meta")
  if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true })
  writeFileSync(join(metaDir, "timestamps.json"), JSON.stringify(data, null, 2), "utf-8")
}

export function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath)
  return createHash("sha256").update(content).digest("hex")
}

export function getFileMetadata(filePath: string, _baseDir: string): FileMetadata {
  const stat = statSync(filePath)
  const type = extname(filePath)
  const hash = computeFileHash(filePath)
  return { mtime: stat.mtimeMs, size: stat.size, hash, type }
}

export function checkFileChanged(
  filePath: string,
  storedMeta: FileMetadata | undefined,
  _baseDir: string
): FileCheckResult {
  if (!existsSync(filePath)) {
    return { changed: false }
  }
  const stat = statSync(filePath)
  const currentMtime = stat.mtimeMs

  if (!storedMeta) {
    return { changed: true, reason: "new", currentMeta: getFileMetadata(filePath, _baseDir) }
  }

  if (Math.abs(currentMtime - storedMeta.mtime) > 1000) {
    return { changed: true, reason: "mtime_changed", currentMeta: getFileMetadata(filePath, _baseDir) }
  }

  return { changed: false }
}
