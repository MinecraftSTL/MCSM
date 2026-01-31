/**
 * File Lock Service
 *
 * Provides file locking functionality for instance file management.
 * This service handles all file lock related operations including:
 * - Checking if paths are locked
 * - Managing lock status during file operations (copy, move, delete)
 * - Performance optimizations for folder content checks
 */

import Instance from "../entity/instance/instance";
import StorageSubsystem from "../common/system_storage";

/**
 * Normalize path for consistent comparison
 * Converts backslashes to forward slashes and removes trailing slashes
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

/**
 * Get all parent folders of a path
 * e.g., "a/b/c/file.txt" returns ["a", "a/b", "a/b/c"]
 */
export function getParentFolders(filePath: string): string[] {
  const normalized = normalizePath(filePath);
  const parts = normalized.split("/");
  const parents: string[] = [];

  // Build parent paths (exclude the file itself)
  for (let i = 1; i < parts.length; i++) {
    parents.push(parts.slice(0, i).join("/"));
  }

  return parents;
}

/**
 * Update foldersWithLockedContent based on current lockedFiles
 * This recalculates which folders contain locked files for performance optimization
 */
export function updateFoldersWithLockedContent(instance: Instance): void {
  const lockedFiles = instance.config.lockedFiles || [];

  if (lockedFiles.length === 0) {
    instance.config.foldersWithLockedContent = [];
    return;
  }

  const foldersSet = new Set<string>();

  // For each locked file, add all its parent folders to the set
  for (const lockedPath of lockedFiles) {
    const parents = getParentFolders(lockedPath);
    for (const parent of parents) {
      foldersSet.add(parent);
    }
  }

  instance.config.foldersWithLockedContent = Array.from(foldersSet);
}

/**
 * Check if a path itself is directly locked (not inherited from parent)
 * Used for display purposes - files should show their own lock status independently
 */
export function isPathDirectlyLocked(instance: Instance, targetPath: string): boolean {
  const lockedFiles = instance.config.lockedFiles || [];
  if (lockedFiles.length === 0) return false;

  const normalizedTarget = normalizePath(targetPath);

  for (const lockedPath of lockedFiles) {
    const normalizedLocked = normalizePath(lockedPath);

    // Only check if target is exactly the locked path (no inheritance)
    if (normalizedTarget === normalizedLocked) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a path is locked (including parent folder inheritance)
 * Used for permission checking - modifications should be blocked if any parent is locked
 */
export function isPathLocked(instance: Instance, targetPath: string): boolean {
  const lockedFiles = instance.config.lockedFiles || [];
  if (lockedFiles.length === 0) return false;

  const normalizedTarget = normalizePath(targetPath);

  for (const lockedPath of lockedFiles) {
    const normalizedLocked = normalizePath(lockedPath);

    // Check if target is exactly the locked path
    if (normalizedTarget === normalizedLocked) {
      return true;
    }

    // Check if target is inside a locked directory
    if (normalizedTarget.startsWith(normalizedLocked + "/")) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a path contains any locked files (for folder operations)
 * This checks if any locked file is inside the given path
 * Performance optimization: first check foldersWithLockedContent before detailed check
 */
export function containsLockedPath(instance: Instance, targetPath: string): string | null {
  const lockedFiles = instance.config.lockedFiles || [];
  if (lockedFiles.length === 0) return null;

  const normalizedTarget = normalizePath(targetPath);

  // Performance optimization: check if this folder is marked as containing locked files
  const foldersWithLockedContent = instance.config.foldersWithLockedContent || [];
  if (foldersWithLockedContent.length > 0) {
    // Check if targetPath is in foldersWithLockedContent or is a parent of any marked folder
    let hasLockedContent = false;
    for (const markedFolder of foldersWithLockedContent) {
      // targetPath contains locked content if:
      // 1. targetPath equals a marked folder, or
      // 2. a marked folder starts with targetPath (targetPath is parent of marked folder)
      if (markedFolder === normalizedTarget || markedFolder.startsWith(normalizedTarget + "/")) {
        hasLockedContent = true;
        break;
      }
    }

    // If not marked as containing locked content, skip detailed check
    if (!hasLockedContent) {
      return null;
    }
  }

  // Detailed check: find the actual locked path
  for (const lockedPath of lockedFiles) {
    const normalizedLocked = normalizePath(lockedPath);

    // Check if the locked path is inside the target path
    if (normalizedLocked.startsWith(normalizedTarget + "/")) {
      return lockedPath;
    }
  }

  return null;
}

/**
 * Check if a path is locked or contains locked files
 * Used for operations that affect the path and all its contents (copy, move, delete)
 */
export function isPathOrContentsLocked(instance: Instance, targetPath: string): string | null {
  // First check if the path itself is locked
  if (isPathLocked(instance, targetPath)) {
    return targetPath;
  }
  // Then check if it contains any locked files
  return containsLockedPath(instance, targetPath);
}

/**
 * Remove lock for a specific path
 * Used when files are deleted or created to clear stale lock states
 * Also handles folder deletion - removes all locks for files inside the folder
 */
export function removeLockForPath(instance: Instance, targetPath: string): boolean {
  if (!instance.config.lockedFiles) return false;
  const normalizedTarget = normalizePath(targetPath);

  let modified = false;

  // Case 1: Target path itself is directly locked
  const index = instance.config.lockedFiles.indexOf(normalizedTarget);
  if (index > -1) {
    instance.config.lockedFiles.splice(index, 1);
    modified = true;
  }

  // Case 2: Target is a folder containing locked files - remove all nested locks
  // e.g., deleting "folder1" should also remove locks for "folder1/a/b.txt"
  const targetPrefix = normalizedTarget + "/";
  const pathsToRemove: string[] = [];

  for (const lockedPath of instance.config.lockedFiles) {
    if (lockedPath.startsWith(targetPrefix)) {
      pathsToRemove.push(lockedPath);
    }
  }

  // Remove all nested locked paths
  for (const pathToRemove of pathsToRemove) {
    const idx = instance.config.lockedFiles.indexOf(pathToRemove);
    if (idx > -1) {
      instance.config.lockedFiles.splice(idx, 1);
      modified = true;
    }
  }

  if (modified) {
    // Performance optimization: recalculate foldersWithLockedContent
    updateFoldersWithLockedContent(instance);
    StorageSubsystem.store("InstanceConfig", instance.instanceUuid, instance.config);
  }

  return modified;
}

/**
 * Copy lock status from source to destination
 * Used when copying files - if source is locked, destination should also be locked
 */
export function copyLockForPath(instance: Instance, sourcePath: string, destPath: string): boolean {
  if (!instance.config.lockedFiles) return false;
  const normalizedSource = normalizePath(sourcePath);
  const normalizedDest = normalizePath(destPath);

  // Check if source is directly locked
  if (instance.config.lockedFiles.includes(normalizedSource)) {
    // Add lock to destination if not already locked
    if (!instance.config.lockedFiles.includes(normalizedDest)) {
      instance.config.lockedFiles.push(normalizedDest);
      // Performance optimization: update foldersWithLockedContent
      updateFoldersWithLockedContent(instance);
      StorageSubsystem.store("InstanceConfig", instance.instanceUuid, instance.config);
    }
    return true;
  }
  return false;
}

/**
 * Move lock status from source to destination
 * Used when moving/renaming files - lock status transfers from source to destination
 * Also handles moving folders that contain locked files inside
 */
export function moveLockForPath(instance: Instance, sourcePath: string, destPath: string): boolean {
  if (!instance.config.lockedFiles) return false;
  const normalizedSource = normalizePath(sourcePath);
  const normalizedDest = normalizePath(destPath);

  let modified = false;

  // Case 1: Source path itself is directly locked
  const sourceIndex = instance.config.lockedFiles.indexOf(normalizedSource);
  if (sourceIndex > -1) {
    // Remove lock from source
    instance.config.lockedFiles.splice(sourceIndex, 1);
    // Add lock to destination if not already locked
    if (!instance.config.lockedFiles.includes(normalizedDest)) {
      instance.config.lockedFiles.push(normalizedDest);
    }
    modified = true;
  }

  // Case 2: Source is a folder containing locked files - update all nested locked paths
  // e.g., moving "folder1" to "folder2" should update "folder1/a/b.txt" to "folder2/a/b.txt"
  const sourcePrefix = normalizedSource + "/";
  const updatedPaths: { oldPath: string; newPath: string }[] = [];

  for (let i = 0; i < instance.config.lockedFiles.length; i++) {
    const lockedPath = instance.config.lockedFiles[i];
    if (lockedPath.startsWith(sourcePrefix)) {
      // This locked file is inside the moved folder
      const relativePath = lockedPath.substring(sourcePrefix.length);
      const newPath = normalizedDest + "/" + relativePath;
      updatedPaths.push({ oldPath: lockedPath, newPath });
    }
  }

  // Apply the path updates
  for (const { oldPath, newPath } of updatedPaths) {
    const idx = instance.config.lockedFiles.indexOf(oldPath);
    if (idx > -1) {
      instance.config.lockedFiles.splice(idx, 1);
      if (!instance.config.lockedFiles.includes(newPath)) {
        instance.config.lockedFiles.push(newPath);
      }
      modified = true;
    }
  }

  if (modified) {
    // Performance optimization: recalculate foldersWithLockedContent
    updateFoldersWithLockedContent(instance);
    StorageSubsystem.store("InstanceConfig", instance.instanceUuid, instance.config);
  }

  return modified;
}

/**
 * Add lock to a path
 */
export function addLock(instance: Instance, targetPath: string): boolean {
  const normalizedTarget = normalizePath(targetPath);

  // Initialize lockedFiles array if not exists
  if (!instance.config.lockedFiles) {
    instance.config.lockedFiles = [];
  }

  // Check if already locked
  if (instance.config.lockedFiles.includes(normalizedTarget)) {
    return false;
  }

  instance.config.lockedFiles.push(normalizedTarget);

  // Performance optimization: update foldersWithLockedContent
  updateFoldersWithLockedContent(instance);

  // Save instance config
  StorageSubsystem.store("InstanceConfig", instance.instanceUuid, instance.config);

  return true;
}

/**
 * Remove lock from a path
 */
export function removeLock(instance: Instance, targetPath: string): boolean {
  const normalizedTarget = normalizePath(targetPath);

  // Initialize lockedFiles array if not exists
  if (!instance.config.lockedFiles) {
    instance.config.lockedFiles = [];
    return false;
  }

  // Remove from locked files
  const index = instance.config.lockedFiles.indexOf(normalizedTarget);
  if (index === -1) {
    return false;
  }

  instance.config.lockedFiles.splice(index, 1);

  // Performance optimization: recalculate foldersWithLockedContent
  updateFoldersWithLockedContent(instance);

  // Save instance config
  StorageSubsystem.store("InstanceConfig", instance.instanceUuid, instance.config);

  return true;
}

/**
 * Check lock status for multiple targets
 * @param instance The instance to check
 * @param targets Array of paths to check
 * @param checkContents If true, also check if paths contain locked files
 * @returns Object with hasLocked flag and array of locked paths
 */
export function checkLockStatus(
  instance: Instance,
  targets: string[],
  checkContents: boolean = true
): { hasLocked: boolean; lockedPaths: string[] } {
  const lockedPaths: string[] = [];

  for (const target of targets) {
    if (checkContents) {
      // For non-admin users: check both path itself and contents
      const lockedPath = isPathOrContentsLocked(instance, target);
      if (lockedPath) {
        lockedPaths.push(lockedPath);
      }
    } else {
      // For admin users: only check path itself
      if (isPathLocked(instance, target)) {
        lockedPaths.push(target);
      }
    }
  }

  return {
    hasLocked: lockedPaths.length > 0,
    lockedPaths
  };
}