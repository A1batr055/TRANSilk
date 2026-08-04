import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimeTempFile } from "../paths.mjs";

const JSON_INSTRUCTION =
  "\n\n只输出合法 JSON，不要任何解释文字，不要用 markdown 代码围栏包裹。";

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

function runProcess(command, args, { cwd, input }) {
  return new Promise((resolve, reject) => {
    const [spawnCommand, spawnArgs] = process.platform === "win32"
      ? ["cmd.exe", ["/d", "/s", "/c", command, ...args]]
      : [command, args];
    const child = spawn(spawnCommand, spawnArgs, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => reject(new Error(`无法启动 ${command}：${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${command} 退出码 ${code}：${stderr || stdout}`));
      else resolve(stdout);
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function callClaudeCli({ model, effort }, { system, user, json }) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "transilk-claude-cwd-"));
  try {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--system-prompt",
      json ? `${system}${JSON_INSTRUCTION}` : system,
    ];
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    const stdout = await runProcess("claude", args, { cwd: scratchDir, input: user });
    const envelope = JSON.parse(stdout);
    const content = envelope.result ?? "";
    return json ? JSON.parse(stripCodeFence(content)) : content;
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

async function callCodexCli({ model, effort }, { system, user, json }) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "transilk-codex-cwd-"));
  const outputFile = runtimeTempFile("codex-result", ".txt");
  try {
    const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-C", scratchDir, "-o", outputFile];
    if (model) args.push("-m", model);
    if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
    args.push("-");
    const prompt = `${json ? `${system}${JSON_INSTRUCTION}` : system}\n\n${user}`;
    await runProcess("codex", args, { cwd: scratchDir, input: prompt });
    const content = fs.readFileSync(outputFile, "utf8");
    return json ? JSON.parse(stripCodeFence(content)) : content;
  } finally {
    fs.rmSync(outputFile, { force: true });
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

export async function callCliAgent(providerConfig, options) {
  if (providerConfig.cli === "claude") return callClaudeCli(providerConfig, options);
  if (providerConfig.cli === "codex") return callCodexCli(providerConfig, options);
  throw new Error(`未知的 CLI agent："${providerConfig.cli}"`);
}
