import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TOOL_ROOT } from "./paths.mjs";

const UPSTREAM_BRANCH = "main";
const GIT_TIMEOUT_MS = 15000;
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_CHECK_STATE_PATH = path.join(TOOL_ROOT, ".runtime", "update-check.json");
const UPDATE_PROCESS_TIMEOUT_MS = 5 * 60 * 1000;

function killTree(child) {
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
  else child.kill();
}

function runGit(args, timeoutMs = GIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const [spawnCommand, spawnArgs] = process.platform === "win32"
      ? ["cmd.exe", ["/d", "/s", "/c", "git", ...args]]
      : ["git", args];
    const child = spawn(spawnCommand, spawnArgs, { cwd: TOOL_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 git：${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`git ${args.join(" ")} 超时（可能需要代理才能访问 GitHub）`));
        return;
      }
      if (code !== 0) reject(new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} 退出码 ${code}`));
      else resolve(stdout.trim());
    });
  });
}

function runProcess(command, args, { cwd, timeoutMs = UPDATE_PROCESS_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const [spawnCommand, spawnArgs] = process.platform === "win32" && command === "npm"
      ? ["cmd.exe", ["/d", "/s", "/c", "npm", ...args]]
      : [command, args];
    const child = spawn(spawnCommand, spawnArgs, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 ${command}：${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${command} ${args.join(" ")} 超时`));
      if (code !== 0) return reject(new Error(stderr.trim() || stdout.trim() || `${command} 退出码 ${code}`));
      resolve(stdout.trim());
    });
  });
}

function fileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function childPath(root, ...parts) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, ...parts);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`更新路径超出安装目录：${resolved}`);
  }
  return resolved;
}

export async function inspectForUpdates({ runGitImpl = runGit } = {}) {
  await runGitImpl(["fetch", "origin", UPSTREAM_BRANCH]);
  const local = await runGitImpl(["rev-parse", "HEAD"]);
  const remote = await runGitImpl(["rev-parse", `origin/${UPSTREAM_BRANCH}`]);
  if (local === remote) {
    return { status: "up-to-date", message: "已是最新版本。" };
  }
  const base = await runGitImpl(["merge-base", "HEAD", `origin/${UPSTREAM_BRANCH}`]);
  if (base === remote) {
    return { status: "ahead", message: "本地领先远端，暂无可拉取的更新。" };
  }
  if (base === local) {
    return { status: "available", message: "发现新版本，可在“其他设置”中安装更新。" };
  }
  return { status: "diverged", message: "本地与远端历史出现分叉，无法自动合并，请手动执行 git 操作处理。" };
}

export async function checkForUpdates({ runGitImpl = runGit, runProcessImpl = runProcess, toolRoot = TOOL_ROOT } = {}) {
  const dirty = await runGitImpl(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.trim()) throw new Error("检测到未提交的源码改动，已停止更新；请先提交或还原这些改动。");

  const previousHead = await runGitImpl(["rev-parse", "HEAD"]);
  const result = await inspectForUpdates({ runGitImpl });
  if (result.status !== "available") return result;

  const packageLockPath = childPath(toolRoot, "package-lock.json");
  const nodeModulesPath = childPath(toolRoot, "node_modules");
  const backupRoot = childPath(toolRoot, ".runtime", "update-backup");
  const backupNodeModulesPath = childPath(backupRoot, "node_modules");
  if (fs.existsSync(backupRoot)) throw new Error(`检测到未清理的更新备份，已停止更新：${backupRoot}`);

  const previousLockHash = fileHash(packageLockPath);
  const hadNodeModules = fs.existsSync(nodeModulesPath);
  let pulled = false;
  let dependencyReplacementStarted = false;
  let dependencyBackupCreated = false;

  try {
    await runGitImpl(["pull", "--ff-only", "origin", UPSTREAM_BRANCH]);
    pulled = true;
    const dependenciesChanged = previousLockHash !== fileHash(packageLockPath);
    if (dependenciesChanged) {
      fs.mkdirSync(backupRoot, { recursive: true });
      if (hadNodeModules) {
        fs.renameSync(nodeModulesPath, backupNodeModulesPath);
        dependencyBackupCreated = true;
      }
      dependencyReplacementStarted = true;
      await runProcessImpl("npm", ["install", "--no-audit", "--no-fund"], { cwd: toolRoot });
    }

    await runProcessImpl(process.execPath, [childPath(toolRoot, "src", "cli.mjs"), "--version"], { cwd: toolRoot });
    const postUpdateDirty = await runGitImpl(["status", "--porcelain", "--untracked-files=no"]);
    if (postUpdateDirty.trim()) throw new Error("更新后源码状态异常，已启动回滚。");

    let cleanupWarning = "";
    if (fs.existsSync(backupRoot)) {
      try {
        fs.rmSync(backupRoot, { recursive: true });
      } catch (error) {
        cleanupWarning = `；旧依赖备份未能清理：${error.message}`;
      }
    }
    return {
      status: "updated",
      message: `已安全更新${dependenciesChanged ? "并同步依赖" : ""}，请重启程序生效${cleanupWarning}。`,
    };
  } catch (error) {
    const rollbackErrors = [];
    if (pulled) {
      try {
        await runGitImpl(["reset", "--hard", previousHead]);
      } catch (rollbackError) {
        rollbackErrors.push(`代码恢复失败：${rollbackError.message}`);
      }
    }
    if (dependencyReplacementStarted) {
      try {
        if (dependencyBackupCreated && !fs.existsSync(backupNodeModulesPath)) {
          throw new Error("旧依赖备份不存在");
        }
        if (fs.existsSync(nodeModulesPath)) fs.rmSync(nodeModulesPath, { recursive: true });
        if (dependencyBackupCreated) fs.renameSync(backupNodeModulesPath, nodeModulesPath);
        if (fs.existsSync(backupRoot)) fs.rmSync(backupRoot, { recursive: true });
      } catch (rollbackError) {
        rollbackErrors.push(`依赖恢复失败：${rollbackError.message}`);
      }
    } else if (fs.existsSync(backupRoot)) {
      try {
        fs.rmSync(backupRoot, { recursive: true });
      } catch (rollbackError) {
        rollbackErrors.push(`更新备份清理失败：${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length) {
      throw new Error(`更新失败：${error.message}；自动回滚不完整：${rollbackErrors.join("；")}`);
    }
    throw new Error(`更新失败：${error.message}；已恢复到更新前版本。`);
  }
}

export async function autoCheckForUpdates({ now = Date.now(), statePath = AUTO_CHECK_STATE_PATH } = {}) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (Number.isFinite(state.checkedAt) && now - state.checkedAt < AUTO_CHECK_INTERVAL_MS) {
      return { status: "skipped", message: "尚未到下次自动检查时间。" };
    }
  } catch {}
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify({ checkedAt: now }, null, 2)}\n`, "utf8");
  return inspectForUpdates();
}
