export const SIGNATURE_PATTERNS: RegExp[] = [
  /import\s+(?:(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g,
  /export\s+(?:\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

export interface ConflictReport {
  conflicts: Array<{
    file: string
    oldCount: number
    newCount: number
    affectedImports: string[]
  }>
}

export function extractSignatures(content: string): string[] {
  const signatures: string[] = []
  const lines = content.split("\n")

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    for (const pattern of SIGNATURE_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(line)) !== null) {
        if (match[1]) {
          signatures.push(`import:${match[1]}:${lineIndex + 1}`)
        }
      }
    }
  }

  return signatures
}

export function detectConflicts(
  oldSigs: Record<string, string[]>,
  newSigs: Record<string, string[]>
): ConflictReport {
  const conflicts: ConflictReport["conflicts"] = []

  for (const [file, newFileSigs] of Object.entries(newSigs)) {
    const oldFileSigs = oldSigs[file] || []
    if (JSON.stringify(oldFileSigs.sort()) !== JSON.stringify(newFileSigs.sort())) {
      conflicts.push({
        file,
        oldCount: oldFileSigs.length,
        newCount: newFileSigs.length,
        affectedImports: newFileSigs.filter(s => !oldFileSigs.includes(s)),
      })
    }
  }

  return { conflicts }
}
