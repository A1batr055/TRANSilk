import fs from "node:fs";
import path from "node:path";
import { TOOL_ROOT } from "./paths.mjs";
import { runConfigWizard } from "./configWizard.mjs";
import { withSpinner } from "./progress.mjs";
import { callOpenAICompatible } from "./providers/openaiCompatible.mjs";
import { callAnthropic } from "./providers/anthropic.mjs";
import { callCliAgent } from "./providers/cliAgent.mjs";

const SECRETS_PATH = path.join(TOOL_ROOT, "config", "secrets.local.json");

const DISPATCH = {
  "openai-compatible": callOpenAICompatible,
  anthropic: callAnthropic,
  "cli-agent": callCliAgent,
};

async function loadSecrets() {
  if (!fs.existsSync(SECRETS_PATH)) {
    console.log("未找到模型配置，启动配置向导……");
    return runConfigWizard();
  }
  return JSON.parse(fs.readFileSync(SECRETS_PATH, "utf-8"));
}

export async function callModel({ system, user, json = false, temperature = 0.2 }) {
  const secrets = await loadSecrets();
  const providerConfig = secrets[secrets.provider];
  if (!providerConfig) {
    throw new Error(`${SECRETS_PATH} 缺少 provider "${secrets.provider}" 对应的配置块`);
  }

  const call = DISPATCH[providerConfig.protocol];
  if (!call) {
    throw new Error(`未知协议 "${providerConfig.protocol}"，目前支持：${Object.keys(DISPATCH).join(", ")}`);
  }

  return withSpinner("调用模型中", () => call(providerConfig, { system, user, json, temperature }));
}
