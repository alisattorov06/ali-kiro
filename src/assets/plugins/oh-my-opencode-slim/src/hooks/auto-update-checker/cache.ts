import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '../../utils/logger';
import { acquirePidFileLockWithRetryAsync } from '../../utils/pid-file-lock';
import { getCurrentRuntimePackageJsonPath } from './checker';
import { PACKAGE_NAME } from './constants';

interface AutoUpdateInstallContext {
  installDir: string;
  packageJsonPath: string;
}

interface PreparedPackageUpdate {
  stagingDir: string;
  targetDir: string;
}

export function getTargetInstallContext(
  installContext: AutoUpdateInstallContext,
  version: string,
): AutoUpdateInstallContext | null {
  const installParent = path.dirname(installContext.installDir);
  if (path.basename(installParent) !== 'packages') return null;
  const installDir = path.join(installParent, `${PACKAGE_NAME}@${version}`);
  return { installDir, packageJsonPath: path.join(installDir, 'package.json') };
}

export function resolveInstallContext(
  runtimePackageJsonPath: string | null = getCurrentRuntimePackageJsonPath(),
): AutoUpdateInstallContext | null {
  if (!runtimePackageJsonPath) return null;

  const packageDir = path.dirname(runtimePackageJsonPath);
  const nodeModulesDir = path.dirname(packageDir);
  const installDir = path.dirname(nodeModulesDir);
  const installParent = path.dirname(installDir);

  // Only the OpenCode v1 wrapper layout
  // (<cache>/packages/oh-my-opencode-slim@<spec>/node_modules/oh-my-opencode-slim)
  // is a supported install root. The v2 layout (<cache>/npm/<sanitize(spec)>/<int>/...)
  // is deliberately rejected, as is the legacy <cache>/package.json root.
  const isV1Wrapper =
    path.basename(packageDir) === PACKAGE_NAME &&
    path.basename(nodeModulesDir) === 'node_modules' &&
    path.basename(installParent) === 'packages' &&
    path.basename(installDir).startsWith(`${PACKAGE_NAME}@`);
  if (!isV1Wrapper) return null;

  const packageJsonPath = path.join(installDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return null;

  return { installDir, packageJsonPath };
}

/**
 * Cross-process mutex for auto-update installs, keyed by the target
 * install directory. Parallel OpenCode server processes (one per
 * desktop window) share the cache root; without this, each process
 * runs its own `bun install` for the same pending version (issue #1279).
 *
 * Waits asynchronously (never blocking the JS thread) for up to
 * `timeoutMs` — by default the 300s install timeout plus slack — for a
 * concurrent install to finish. A lock dir older than `maxAgeMs` counts
 * as stale even when its owner PID is alive (PID reuse or a wedged
 * holder must not wedge peers). Age is measured from the lock dir's
 * mtime, set at acquisition and never heartbeated, so `maxAgeMs`
 * (default 900s) must exceed the worst-case hold: the 300s install
 * timeout plus the publish/quarantine recursive rm of a full
 * `node_modules` tree. The two budgets are deliberately different —
 * staleness only ever applies across process generations, never to a
 * healthy holder mid-install. Returns a release function, or null if
 * the lock could not be acquired in time.
 */
export async function acquirePackageUpdateLock(
  targetInstallDir: string,
  timeoutMs = 330_000,
  maxAgeMs = 900_000,
): Promise<(() => void) | null> {
  const lockPath = path.join(
    path.dirname(targetInstallDir),
    `.${path.basename(targetInstallDir)}.install`,
  );
  return acquirePidFileLockWithRetryAsync(lockPath, timeoutMs, maxAgeMs);
}

/**
 * Prepares the current install root for a clean re-install of the target version.
 * Returns the install directory to run the package install in.
 */
export function preparePackageUpdate(
  version: string,
  packageName: string = PACKAGE_NAME,
  runtimePackageJsonPath: string | null = getCurrentRuntimePackageJsonPath(),
  cacheIdentity: string = version,
): PreparedPackageUpdate | null {
  let stagingDir: string | null = null;
  try {
    const installContext = resolveInstallContext(runtimePackageJsonPath);
    if (!installContext) {
      log('[auto-update-checker] No install context found for auto-update');
      return null;
    }

    const targetContext = getTargetInstallContext(
      installContext,
      cacheIdentity,
    );
    if (!targetContext) {
      log('[auto-update-checker] No v1 packages wrapper for auto-update');
      return null;
    }
    const targetParent = path.dirname(targetContext.installDir);
    fs.mkdirSync(targetParent, { recursive: true });
    stagingDir = fs.mkdtempSync(
      path.join(targetParent, `.${PACKAGE_NAME}@${cacheIdentity}.staging-`),
    );
    fs.writeFileSync(
      path.join(stagingDir, 'package.json'),
      JSON.stringify({
        private: true,
        dependencies: { [packageName]: version },
      }),
    );

    return { stagingDir, targetDir: targetContext.installDir };
  } catch (err) {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
    log('[auto-update-checker] Failed to prepare package update:', err);
    return null;
  }
}

export function discardPreparedPackageUpdate(
  prepared: PreparedPackageUpdate,
): void {
  fs.rmSync(prepared.stagingDir, { recursive: true, force: true });
}

export function publishPackageUpdate(
  prepared: PreparedPackageUpdate,
  version: string,
): string | null {
  try {
    if (fs.existsSync(prepared.targetDir)) {
      if (verifyInstalledPackage(prepared.targetDir, version)) {
        discardPreparedPackageUpdate(prepared);
        return prepared.targetDir;
      }
      const quarantineDir = `${prepared.targetDir}.invalid-${process.pid}-${Date.now()}`;
      fs.renameSync(prepared.targetDir, quarantineDir);
      try {
        fs.renameSync(prepared.stagingDir, prepared.targetDir);
        if (verifyInstalledPackage(prepared.targetDir, version)) {
          fs.rmSync(quarantineDir, { recursive: true, force: true });
          return prepared.targetDir;
        }
        fs.rmSync(prepared.targetDir, { recursive: true, force: true });
        fs.renameSync(quarantineDir, prepared.targetDir);
        return null;
      } catch {
        if (fs.existsSync(prepared.targetDir)) {
          if (verifyInstalledPackage(prepared.targetDir, version)) {
            discardPreparedPackageUpdate(prepared);
            fs.rmSync(quarantineDir, { recursive: true, force: true });
            return prepared.targetDir;
          }
        }
      }
      if (!fs.existsSync(prepared.targetDir)) {
        fs.renameSync(quarantineDir, prepared.targetDir);
      }
      discardPreparedPackageUpdate(prepared);
      return null;
    }
    fs.renameSync(prepared.stagingDir, prepared.targetDir);
    if (verifyInstalledPackage(prepared.targetDir, version)) {
      return prepared.targetDir;
    }
    fs.rmSync(prepared.targetDir, { recursive: true, force: true });
    return null;
  } catch {
    discardPreparedPackageUpdate(prepared);
    return null;
  }
}

export function verifyInstalledPackage(
  installDir: string,
  version: string,
  packageName: string = PACKAGE_NAME,
): boolean {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.join(installDir, 'node_modules', packageName, 'package.json'),
        'utf-8',
      ),
    ) as { name?: string; version?: string };
    return packageJson.name === packageName && packageJson.version === version;
  } catch {
    return false;
  }
}
