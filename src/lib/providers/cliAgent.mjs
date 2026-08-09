import fs from "node:fs";
import { runtimeTempDir, runtimeTempFile } from "../paths.mjs";
import { runCliProcess } from "../cliProcess.mjs";

const JSON_INSTRUCTION =
  "\n\n只输出合法 JSON，不要任何解释文字，不要用 markdown 代码围栏包裹。";

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

function runProcess(command, args, { cwd, input, timeoutMs = 300000 }) {
  return runCliProcess(command, args, {
    cwd,
    input,
    timeoutMs,
    errorLabel: `${command} 调用`,
  });
}

async function callClaudeCli({ model, effort }, { system, user, json }) {
  const scratchDir = runtimeTempDir("model-claude");
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
  const scratchDir = runtimeTempDir("model-codex");
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
