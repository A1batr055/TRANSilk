import { spawn } from "node:child_process";
import { TOOL_ROOT } from "./paths.mjs";

const UPSTREAM_BRANCH = "main";

function runGit(args) {
  return new Promise((resolve, reject) => {
    const [spawnCommand, spawnArgs] = process.platform === "win32"
      ? ["cmd.exe", ["/d", "/s", "/c", "git", ...args]]
      : ["git", args];
    const child = spawn(spawnCommand, spawnArgs, { cwd: TOOL_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => reject(new Error(`无法启动 git：${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} 退出码 ${code}`));
      else resolve(stdout.trim());
    });
  });
}

export async function checkForUpdates() {
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
    await runGit(["pull", "--ff-only", "origin", UPSTREAM_BRANCH]);
    return { status: "updated", message: "已拉取最新更新，请重启程序生效。" };
  }
  return { status: "diverged", message: "本地与远端历史出现分叉，无法自动合并，请手动执行 git 操作处理。" };
}
