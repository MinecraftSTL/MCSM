import { t } from "i18next";
import os from "os";
import { globalConfiguration, globalEnv } from "../entity/config";
import Instance from "../entity/instance/instance";
import { $t } from "../i18n";
import StorageSubsystem from "../common/system_storage";
import downloadManager from "../service/download_manager";
import { getFileManager, getWindowsDisks } from "../service/file_router_service";
import logger from "../service/log";
import * as protocol from "../service/protocol";
import { routerApp } from "../service/router";
import InstanceSubsystem from "../service/system_instance";
import uploadManager from "../service/upload_manager";
import { checkSafeUrl } from "../utils/url";
import {
  normalizePath,
  isPathDirectlyLocked,
  removeLockForPath,
  copyLockForPath,
  moveLockForPath,
  addLock,
  removeLock,
  checkLockStatus
} from "../service/file_lock_service";

// Some routers operate router authentication middleware
routerApp.use((event, ctx, data, next) => {
  if (event.startsWith("file/")) {
    const instanceUuid = data.instanceUuid;
    const instance = InstanceSubsystem.getInstance(instanceUuid);
    if (!instance) {
      return protocol.error(ctx, event, {
        instanceUuid: instanceUuid,
        err: $t("TXT_CODE_file_router.instanceNotExist", { instanceUuid: instanceUuid })
      });
    }

    if (
      [Instance.STATUS_BUSY, Instance.STATUS_STARTING].includes(instance.status()) &&
      !["file/list", "file/status"].includes(event)
    ) {
      return protocol.error(ctx, event, {
        instanceUuid: instanceUuid,
        err: $t("TXT_CODE_bbedcf29")
      });
    }
  }
  next();
});

// List the files in the specified instance working directory
routerApp.on("file/list", async (ctx, data) => {
  try {
    const instance = InstanceSubsystem.getInstance(data.instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));

    const fileManager = getFileManager(data.instanceUuid);
    const { page, pageSize, target, fileName } = data;
    fileManager.cd(target);
    const overview = await fileManager.list(page, pageSize, fileName);

    // Add locked status to each file item
    // Use isPathDirectlyLocked for display - files show their own lock status independently
    const lockedFiles = instance.config.lockedFiles || [];
    if (overview.items && Array.isArray(overview.items)) {
      overview.items = overview.items.map((item: any) => {
        const itemPath = target ? normalizePath(target + "/" + item.name) : item.name;
        return {
          ...item,
          locked: isPathDirectlyLocked(instance, itemPath)
        };
      });
    }

    // Also return the locked files list for admin reference
    const result = {
      ...overview,
      lockedFiles
    };

    protocol.response(ctx, result);
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// File chmod (only Linux)
routerApp.on("file/chmod", async (ctx, data) => {
  try {
    const fileManager = getFileManager(data.instanceUuid);
    const { chmod, target, deep } = data;
    await fileManager.chmod(target, chmod, deep);
    protocol.response(ctx, true);
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// Query the status of the file management system
routerApp.on("file/status", async (ctx, data) => {
  try {
    const instance = InstanceSubsystem.getInstance(data.instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));

    const downloadTasks = [];
    if (downloadManager.task) {
      downloadTasks.push({
        path: downloadManager.task.path,
        total: downloadManager.task.total,
        current: downloadManager.task.current,
        status: downloadManager.task.status,
        error: downloadManager.task.error
      });
    }

    protocol.response(ctx, {
      instanceFileTask: instance.info.fileLock ?? 0,
      globalFileTask: globalEnv.fileTaskCount ?? 0,
      downloadFileFromURLTask: downloadManager.downloadingCount,
      downloadTasks,
      platform: os.platform(),
      isGlobalInstance: data.instanceUuid === InstanceSubsystem.GLOBAL_INSTANCE_UUID,
      disks: getWindowsDisks()
    });
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// Create a new file
routerApp.on("file/touch", (ctx, data) => {
  try {
    const instance = InstanceSubsystem.getInstance(data.instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));

    const target = data.target;
    const fileManager = getFileManager(data.instanceUuid);
    fileManager.newFile(target);
    // Clear any stale lock status for the new file path
    removeLockForPath(instance, target);
    protocol.response(ctx, true);
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// Create a directory
routerApp.on("file/mkdir", (ctx, data) => {
  try {
    const instance = InstanceSubsystem.getInstance(data.instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));

    const target = data.target;
    const fileManager = getFileManager(data.instanceUuid);
    fileManager.mkdir(target);
    // Clear any stale lock status for the new directory path
    removeLockForPath(instance, target);
    protocol.response(ctx, true);
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// download a file from url
routerApp.on("file/download_from_url", async (ctx, data) => {
  try {
    const url = data.url;
    const fileName = data.fileName;

    if (!checkSafeUrl(url)) {
      protocol.responseError(ctx, t("TXT_CODE_3fe1b194"), {
        disablePrint: true
      });
      return;
    }

    const fileManager = getFileManager(data.instanceUuid);
    fileManager.checkPath(fileName);
    const targetPath = fileManager.toAbsolutePath(fileName);

    // Start download in background
    const fallbackUrl = data.fallbackUrl;

    const maxDownloadFromUrlFileCount = globalConfiguration.config.maxDownloadFromUrlFileCount;
    if (
      maxDownloadFromUrlFileCount > 0 &&
      downloadManager.downloadingCount >= maxDownloadFromUrlFileCount
    ) {
      protocol.responseError(ctx, t("TXT_CODE_821a742e", { count: maxDownloadFromUrlFileCount }), {
        disablePrint: true
      });
      return;
    }

    downloadManager.downloadFromUrl(url, targetPath, fallbackUrl).catch((err) => {
      logger.error(`Download failed: ${url} -> ${targetPath}`, err);
    });

    protocol.response(ctx, {});
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// stop download from url
routerApp.on("file/download_stop", (ctx, data) => {
  try {
    const fileManager = getFileManager(data.instanceUuid);
    fileManager.checkPath(data.fileName);
    const targetPath = fileManager.toAbsolutePath(data.fileName);
    const result = downloadManager.stop(targetPath);
    protocol.response(ctx, result);
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// copy the file
// Note: Lock permission check is done by file_lock middleware
routerApp.on("file/copy", async (ctx, data) => {
  try {
    const instance = InstanceSubsystem.getInstance(data.instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));

    // [["a.txt","b.txt"],["cxz","zzz"]]
    const targets = data.targets;
    const fileManager = getFileManager(data.instanceUuid);

    for (const target of targets) {
      fileManager.copy(target[0], target[1]);
      // Copy lock status from source to destination
      copyLockForPath(instance, target[0], target[1]);
    }
    protocol.response(ctx, true);
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// move the file
// Note: Lock permission check is done by file_lock middleware
routerApp.on("file/move", async (ctx, data) => {
  try {
    const instance = InstanceSubsystem.getInstance(data.instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));

    // [["a.txt","b.txt"],["cxz","zzz"]]
    const targets = data.targets;
    const fileManager = getFileManager(data.instanceUuid);

    for (const target of targets) {
      await fileManager.move(target[0], target[1]);
      // Move lock status from source to destination
      moveLockForPath(instance, target[0], target[1]);
    }
    protocol.response(ctx, true);
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// Delete Files
// Note: Lock permission check is done by file_lock middleware
routerApp.on("file/delete", async (ctx, data) => {
  try {
    const instance = InstanceSubsystem.getInstance(data.instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));

    const targets = data.targets;
    const fileManager = getFileManager(data.instanceUuid);

    for (const target of targets) {
      const path = fileManager.toAbsolutePath(target);
      const uploadTask = uploadManager.getByPath(path);
      if (uploadTask != undefined) {
        uploadManager.delete(uploadTask.id);
        uploadTask.writer.stop();
      } else {
        // async delete
        fileManager.delete(target);
      }
      // Clear lock status for deleted file/folder
      removeLockForPath(instance, target);
    }
    protocol.response(ctx, true);
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// edit file
// Note: Lock permission check is done by file_lock middleware
routerApp.on("file/edit", async (ctx, data) => {
  try {
    const instance = InstanceSubsystem.getInstance(data.instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));

    const target = data.target;
    const text = data.text;

    const fileManager = getFileManager(data.instanceUuid);
    const result = await fileManager.edit(target, text);
    protocol.response(ctx, result ? result : true);
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// compress/decompress the file
// Note: Lock permission check is done by file_lock middleware
routerApp.on("file/compress", async (ctx, data) => {
  const maxFileTask = globalConfiguration.config.maxFileTask;
  try {
    const source = data.source;
    const targets = data.targets;
    const type = data.type;
    const code = data.code;
    const fileManager = getFileManager(data.instanceUuid);
    const instance = InstanceSubsystem.getInstance(data.instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));
    if (instance.info.fileLock >= maxFileTask) {
      throw new Error(
        $t("TXT_CODE_file_router.unzipLimit", {
          maxFileTask: maxFileTask,
          fileLock: instance.info.fileLock
        })
      );
    }

    // Statistics of the number of tasks in a single instance file and the number of tasks in the entire daemon process
    function fileTaskStart() {
      if (instance) {
        instance.info.fileLock++;
        globalEnv.fileTaskCount++;
      }
    }

    function fileTaskEnd() {
      if (instance) {
        instance.info.fileLock--;
        globalEnv.fileTaskCount--;
      }
    }

    // start decompressing or compressing the file
    fileTaskStart();
    try {
      if (type === 1) {
        await fileManager.zip(source, targets, code);
      } else {
        await fileManager.unzip(source, targets, code);
      }
      protocol.response(ctx, true);
    } catch (error: any) {
      throw error;
    } finally {
      fileTaskEnd();
    }
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// Lock file/folder (admin only - permission check done at Panel level)
routerApp.on("file/lock", async (ctx, data) => {
  try {
    const instance = InstanceSubsystem.getInstance(data.instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));

    const { target } = data;
    addLock(instance, target);

    protocol.response(ctx, {
      locked: true,
      lockedFiles: instance.config.lockedFiles
    });
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// Unlock file/folder (admin only - permission check done at Panel level)
routerApp.on("file/unlock", async (ctx, data) => {
  try {
    const instance = InstanceSubsystem.getInstance(data.instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));

    const { target } = data;
    removeLock(instance, target);

    protocol.response(ctx, {
      locked: false,
      lockedFiles: instance.config.lockedFiles
    });
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});

// Check if path is locked (used by Panel for permission checking)
// checkContents: if true, also check if the path contains any locked files (for non-admin users)
routerApp.on("file/check_lock", async (ctx, data) => {
  try {
    const instance = InstanceSubsystem.getInstance(data.instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));

    const { targets, checkContents } = data;
    const result = checkLockStatus(instance, targets, checkContents);

    protocol.response(ctx, result);
  } catch (error: any) {
    protocol.responseError(ctx, error);
  }
});