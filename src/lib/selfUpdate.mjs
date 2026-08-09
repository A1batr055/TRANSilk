import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TOOL_ROOT } from "./paths.mjs";

const UPSTREAM_BRANCH = "main";
const GIT_TIMEOUT_MS = 15000;
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_CHECK_STATE_PATH = path.join(TOOL_ROOT, ".runtime", "update-check.json");

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

export async function inspectForUpdates() {
  await runGit(["fetch", "origin", UPSTREAM_BRANCH]);
  const local = await runGit(["rev-parse", "HEAD"]);
  const remote = await runGit(["rev-parse", `origin/${UPSTREAM_BRANCH}`]);
  if (local === remote) {
    return { status: "up-to-date", message: "已是最新版本。" };
  }
  const base = await runGit(["merge-base", "HEAD", `origin/${UPSTREAM_BRANCH}`]);
  if (base === remote) {
    return { status: "ahead", message: "本地领先远端，暂无可拉取的更新。" };
  }
  if (base === local) {
    return { status: "available", message: "发现新版本，可在“其他设置”中安装更新。" };
  }
  return { status: "diverged", message: "本地与远端历史出现分叉，无法自动合并，请手动执行 git 操作处理。" };
}

export async function checkForUpdates() {
  const result = await inspectForUpdates();
  if (result.status !== "available") return result;
  await runGit(["pull", "--ff-only", "origin", UPSTREAM_BRANCH]);
  return { status: "updated", message: "已拉取最新更新，请重启程序生效。" };
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
