import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter } from '../utils/frontmatter';
import { getProjectConfigDirectories } from './loader';

/**
 * Discover valid skills in the current and ancestor project directories.
 *
 * This intentionally mirrors only the ancestor-local `.opencode/skills`
 * portion of OpenCode's broader skill discovery. Global skills, external
 * compatibility directories, configured extra paths, and URL sources are
 * outside this helper's scope.
 */
export function discoverProjectLocalSkillNames(
  projectDirectory: string,
  hostFlavor?: string,
): string[] {
  const names = new Set<string>();
  for (const configDirectory of getProjectConfigDirectories(
    projectDirectory,
    hostFlavor,
  )) {
    for (const name of discoverLocalSkills(path.dirname(configDirectory))) {
      names.add(name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function discoverLocalSkills(projectDirectory: string): string[] {
  const configuredRoot = path.join(projectDirectory, '.opencode', 'skills');
  let root: string;

  try {
    const canonicalProject = fs.realpathSync(projectDirectory);
    root = fs.realpathSync(configuredRoot);
    const expectedRoot = path.join(canonicalProject, '.opencode', 'skills');

    // Keep the opt-in strictly project-local. In particular, do not let a
    // symlinked `.opencode` or `skills` directory turn this into discovery of
    // an external/global skill tree.
    if (root !== expectedRoot) {
      return [];
    }
  } catch {
    return [];
  }

  const names = new Set<string>();

  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'SKILL.md') {
        continue;
      }

      try {
        const content = fs
          .readFileSync(entryPath, 'utf-8')
          .replace(/^\uFEFF/, '');
        const name = parseFrontmatter(content)?.name?.trim();
        if (name) {
          names.add(name);
        }
      } catch {
        // OpenCode ignores unusable skill files during discovery; keep this
        // opt-in helper non-fatal for unreadable or malformed local files.
      }
    }
  };

  visit(root);
  return [...names].sort((left, right) => left.localeCompare(right));
}
