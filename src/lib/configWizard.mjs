
import fs from "node:fs";
import path from "node:path";
import prompts from "prompts";
import { TOOL_ROOT } from "./paths.mjs";
import { listAvailableModels } from "./modelCatalog.mjs";

export const SECRETS_PATH = path.join(TOOL_ROOT, "config", "secrets.local.json");

export const MODEL_PRESETS = {
  deepseek: {
    label: "DeepSeek",
    protocol: "openai-compatible",
    baseURL: "https://api.deepseek.com",
  },
  openai: {
    label: "OpenAI",
    protocol: "openai-compatible",
    baseURL: "https://api.openai.com/v1",
  },
  anthropic: {
    label: "Anthropic",
    protocol: "anthropic",
    baseURL: "https://api.anthropic.com",
  },
  "claude-cli": {
    label: "Claude Code CLI（订阅额度，无需 API key）",
    protocol: "cli-agent",
    cli: "claude",
  },
  "codex-cli": {
    label: "Codex CLI（订阅额度，无需 API key）",
    protocol: "cli-agent",
    cli: "codex",
  },
  custom: {
    label: "自定义（OpenAI 兼容协议）",
    protocol: "openai-compatible",
    baseURL: "",
  },
};

const onCancel = () => {
  throw new Error("配置向导已取消，未保存");
};

export async function runConfigWizard() {
  const { providerKey } = await prompts(
    {
      type: "select",
      name: "providerKey",
      message: "选择模型服务商",
      choices: Object.entries(MODEL_PRESETS).map(([value, p]) => ({ title: p.label, value })),
    },
    { onCancel },
  );
  if (!providerKey) onCancel();

  const preset = MODEL_PRESETS[providerKey];
  const protocol = preset.protocol;
  const isCliAgent = protocol === "cli-agent";

  let baseURL = "";
  let apiKey = "";
  if (!isCliAgent) {
    ({ baseURL, apiKey } = await prompts(
      [
        { type: "text", name: "baseURL", message: "API base URL", initial: preset.baseURL },
        { type: "password", name: "apiKey", message: "API key" },
      ],
      { onCancel },
    ));
  }

  let models = [];
  try {
    models = await listAvailableModels({ protocol, baseURL, apiKey, cli: preset.cli });
  } catch (error) {
    console.warn(error.message);
  }

  if (isCliAgent) {
    const modelDocURL = preset.cli === "claude"
      ? "https://code.claude.com/docs/en/model-config"
      : "https://learn.chatgpt.com/docs/models";
    const modelExample = preset.cli === "claude" ? "claude-fable-5" : "gpt-5.6-sol";
    console.log(`示例：${modelExample}；查看当前可用模型和命名：${modelDocURL}`);
  }

  const manualValue = "__manual__";
  const modelMessage = isCliAgent ? "选择模型（可留空使用 CLI 默认模型）" : "选择模型";
  const manualMessage = isCliAgent ? "模型 ID（可留空使用 CLI 默认模型）" : "手动输入模型 ID";
  const selection = await prompts({
    type: models.length ? "select" : "text",
    name: "model",
    message: models.length ? modelMessage : manualMessage,
    choices: models.length
      ? [...models.map((model) => ({ title: model, value: model })), { title: "手动输入模型 ID", value: manualValue }]
      : undefined,
  });
  let model = selection.model;
  if (model === manualValue) {
    ({ model } = await prompts({ type: "text", name: "model", message: manualMessage }));
  }
  if (!model && !isCliAgent) throw new Error("未选择模型，配置未保存");

  let effort = "";
  if (isCliAgent) {
    const effortHelp = preset.cli === "claude" ? "claude --help" : "codex --help";
    console.log(`示例：high；查看可选值：${effortHelp}`);
    ({ effort } = await prompts(
      { type: "text", name: "effort", message: "推理强度（可选，留空使用 CLI 默认值）" },
      { onCancel },
    ));
  }

  const secrets = {
    provider: providerKey,
    [providerKey]: isCliAgent
      ? { protocol, cli: preset.cli, model, ...(effort ? { effort } : {}) }
      : { protocol, baseURL, model, apiKey },
  };

  saveModelConfig(secrets);
  console.log(`已保存到 ${SECRETS_PATH}`);

  return secrets;
}

export function hasModelConfig() {
  return fs.existsSync(SECRETS_PATH);
}

export function readModelConfig() {
  if (!hasModelConfig()) return null;
  try {
    return JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function modelConfigSummary() {
  const config = readModelConfig();
  if (!config) return { configured: false, label: hasModelConfig() ? "配置无效" : "未配置" };
  const provider = config.provider;
  const model = config[provider]?.model;
  const providerLabel = MODEL_PRESETS[provider]?.label || provider;
  return { configured: true, provider, model, label: [providerLabel, model].filter(Boolean).join(" · ") };
}

export function saveModelConfig(secrets) {
  fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true });
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2) + "\n", "utf-8");
}

export function clearModelConfig() {
  if (!fs.existsSync(SECRETS_PATH)) return false;
  fs.unlinkSync(SECRETS_PATH);
  return true;
}
