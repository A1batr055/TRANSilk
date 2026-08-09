import { spawn } from "node:child_process";

function stopProcessTree(child) {
  if (!child?.pid) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", resolve);
      killer.on("close", resolve);
    });
  }
  child.kill("SIGTERM");
  return new Promise((resolve) => child.once("close", resolve));
}

export function runCliProcess(command, args, {
  cwd,
  input = "",
  timeoutMs = 300000,
  errorLabel = command,
} = {}) {
  return new Promise((resolve, reject) => {
    const [spawnCommand, spawnArgs] = process.platform === "win32"
      ? ["cmd.exe", ["/d", "/s", "/c", command, ...args]]
      : [command, args];
    const child = spawn(spawnCommand, spawnArgs, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await stopProcessTree(child);
      reject(new Error(`${errorLabel}超时（${Math.round(timeoutMs / 1000)}秒）`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => finish(() => reject(new Error(`无法启动${errorLabel}：${error.message}`))));
    child.on("close", (code) => finish(() => code === 0
      ? resolve(stdout)
      : reject(new Error(`${errorLabel}失败（退出码${code}）：${stderr || stdout}`))));
    child.stdin.end(input);
  });
}
