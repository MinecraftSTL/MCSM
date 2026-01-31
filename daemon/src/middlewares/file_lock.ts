/**
 * File Lock Middleware
 *
 * This middleware intercepts file operations and checks if the target files are locked.
 * It provides a non-invasive way to enforce file lock permissions at the routing layer.
 *
 * The middleware checks the `isAdmin` flag in the request data:
 * - If isAdmin is true, the operation is allowed (admin can modify locked files)
 * - If isAdmin is false or not set, locked files cannot be modified
 */

import RouterContext from "../entity/ctx";
import { $t } from "../i18n";
import * as protocol from "../service/protocol";
import InstanceSubsystem from "../service/system_instance";
import { isPathLocked, isPathOrContentsLocked } from "../service/file_lock_service";

/**
 * Configuration for file lock check
 */
interface FileLockCheckConfig {
  /** The event name pattern to match */
  event: string;
  /** Function to extract target paths from request data */
  getTargets: (data: any) => string[];
  /** Whether to check contents (for folder operations) */
  checkContents?: boolean;
  /** Whether this operation is admin-only (skip non-admin check) */
  adminOnly?: boolean;
}

/**
 * File operations that need lock checking
 * Each config defines how to extract target paths from the request data
 */
const FILE_LOCK_CHECK_CONFIGS: FileLockCheckConfig[] = [
  // List directory - check if target directory itself is locked (not contents)
  {
    event: "file/list",
    getTargets: (data) => {
      const target = data.target;
      // Skip root directory check
      if (!target || target === "/" || target === ".") return [];
      return [target];
    },
    checkContents: false
  },
  // Edit file - check if file is locked
  {
    event: "file/edit",
    getTargets: (data) => (data.target ? [data.target] : []),
    checkContents: true
  },
  // Chmod - check if file is locked
  {
    event: "file/chmod",
    getTargets: (data) => (data.target ? [data.target] : []),
    checkContents: true
  },
  // Copy files - check if source files are locked
  {
    event: "file/copy",
    getTargets: (data) => {
      const targets = data.targets as string[][] | undefined;
      if (!targets || !Array.isArray(targets)) return [];
      return targets.map((t) => t[0]); // Source paths
    },
    checkContents: true
  },
  // Move files - check if source files are locked
  {
    event: "file/move",
    getTargets: (data) => {
      const targets = data.targets as string[][] | undefined;
      if (!targets || !Array.isArray(targets)) return [];
      return targets.map((t) => t[0]); // Source paths
    },
    checkContents: true
  },
  // Delete files - check if files are locked
  {
    event: "file/delete",
    getTargets: (data) => {
      const targets = data.targets as string[] | undefined;
      if (!targets || !Array.isArray(targets)) return [];
      return targets;
    },
    checkContents: true
  },
  // Compress files - check if files are locked
  {
    event: "file/compress",
    getTargets: (data) => {
      const targets = data.targets as string[] | undefined;
      if (!targets || !Array.isArray(targets)) return [];
      return targets;
    },
    checkContents: true
  }
];

/**
 * Find the matching config for an event
 */
function findConfig(event: string): FileLockCheckConfig | undefined {
  return FILE_LOCK_CHECK_CONFIGS.find((config) => config.event === event);
}

/**
 * Check if any of the target paths are locked
 * @param instanceUuid The instance UUID
 * @param targets Array of paths to check
 * @param checkContents Whether to check if paths contain locked files
 * @returns The first locked path found, or null if none are locked
 */
function checkTargetsLocked(
  instanceUuid: string,
  targets: string[],
  checkContents: boolean
): string | null {
  const instance = InstanceSubsystem.getInstance(instanceUuid);
  if (!instance) return null;

  for (const target of targets) {
    if (checkContents) {
      const lockedPath = isPathOrContentsLocked(instance, target);
      if (lockedPath) return lockedPath;
    } else {
      if (isPathLocked(instance, target)) return target;
    }
  }

  return null;
}

/**
 * File lock middleware for Socket.io routes
 *
 * This middleware checks if the requested file operation targets locked files.
 * If the user is not an admin and the target is locked, the operation is blocked.
 *
 * Usage: Register this middleware with routerApp.use()
 */
export function fileLockMiddleware(
  event: string,
  ctx: RouterContext,
  data: any,
  next: Function
): void {
  // Only check file operations
  if (!event.startsWith("file/")) {
    return next();
  }

  // Find matching config
  const config = findConfig(event);
  if (!config) {
    // No config for this event, allow it
    return next();
  }

  // Skip check for admin-only operations (they have their own permission check)
  if (config.adminOnly) {
    return next();
  }

  // Check if user is admin
  const isAdmin = data?.isAdmin === true;
  if (isAdmin) {
    // Admin can access locked files
    return next();
  }

  // Get instance UUID
  const instanceUuid = data?.instanceUuid;
  if (!instanceUuid) {
    return next();
  }

  // Get target paths
  const targets = config.getTargets(data);
  if (targets.length === 0) {
    return next();
  }

  // Check if any target is locked
  const lockedPath = checkTargetsLocked(
    instanceUuid,
    targets,
    config.checkContents !== false // Default to true
  );

  if (lockedPath) {
    // Target is locked, block the operation
    protocol.error(ctx, event, {
      err: $t("TXT_CODE_file_locked_error")
    });
    return;
  }

  // All checks passed, continue
  next();
}

/**
 * Export the middleware for use in router.ts
 */
export default fileLockMiddleware;