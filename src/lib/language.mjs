const LANGUAGE_NAMES = {
  zh: ["中文", "中文"],
  en: ["英文", "英语"],
  ja: ["日文", "日语"],
  ko: ["韩文", "韩语"],
  fr: ["法文", "法语"],
  de: ["德文", "德语"],
  es: ["西文", "西班牙语"],
  it: ["意大利文", "意大利语"],
  pt: ["葡文", "葡萄牙语"],
  ru: ["俄文", "俄语"],
  ar: ["阿拉伯文", "阿拉伯语"],
  th: ["泰文", "泰语"],
  vi: ["越南文", "越南语"],
};

export const LANGUAGE_OPTIONS = [
  ["zh-CN", "中文"],
  ["en-US", "英语"],
  ["ja-JP", "日语"],
  ["ko-KR", "韩语"],
  ["fr-FR", "法语"],
  ["de-DE", "德语"],
  ["es-ES", "西班牙语"],
  ["it-IT", "意大利语"],
  ["pt-BR", "葡萄牙语"],
  ["ru-RU", "俄语"],
  ["ar-SA", "阿拉伯语"],
  ["th-TH", "泰语"],
  ["vi-VN", "越南语"],
];

export const DIRECTION_PROFILES = {
  "zh-en": createLanguageProfile("zh-CN", "en-US"),
  "en-zh": createLanguageProfile("en-US", "zh-CN"),
};

function normalizeLanguageCode(code) {
  const normalized = String(code ?? "").trim().replace(/_/g, "-");
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(normalized)) {
    throw new Error(`语言代码无效：${code}。请使用类似 fr、ja-JP 或 zh-CN 的 BCP-47 代码。`);
  }
  const [base, ...rest] = normalized.split("-");
  return [base.toLowerCase(), ...rest.map((part) => part.length === 2 ? part.toUpperCase() : part)].join("-");
}

function baseLanguage(code) {
  return code.split("-")[0].toLowerCase();
}

function languageName(code) {
  const base = baseLanguage(code);
  return LANGUAGE_NAMES[base]?.[0] ?? code;
}

function languageField(code) {
  return normalizeLanguageCode(code).replace(/-/g, "_");
}

function splitDirection(direction) {
  const value = String(direction ?? "").trim();
  if (value.includes("->")) return value.split("->");
  if (value.includes("/")) return value.split("/");
  const match = value.match(/^([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)-([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)$/);
  return match ? [match[1], match[2]] : [];
}

export function createLanguageProfile(sourceLanguage, targetLanguage) {
  const source = normalizeLanguageCode(sourceLanguage);
  const target = normalizeLanguageCode(targetLanguage);
  const sourceLabel = languageName(source);
  const targetLabel = languageName(target);
  return {
    direction: `${source}-${target}`,
    sourceLanguage: source,
    targetLanguage: target,
    sourceLabel,
    targetLabel,
    sourceColumnLabel: `${sourceLabel}原文`,
    targetColumnLabel: `${targetLabel}译文`,
    languageLabel: `${sourceLabel}-${targetLabel}`,
    sourceTermField: languageField(source),
    targetTermField: languageField(target),
  };
}

export function detectDirection(segments) {
  const text = segments.map((segment) => segment.text ?? "").join(" ");
  const han = (text.match(/[\p{Script=Han}]/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return latin > han ? "en-zh" : "zh-en";
}

export function resolveLanguageProfile(direction, segments = []) {
  const resolved = String(direction ?? "").trim();
  if (!resolved || resolved.toLowerCase() === "auto" || resolved.toLowerCase().startsWith("auto->")) {
    throw new Error("必须明确选择源语和目标语，已停用自动识别。请使用类似 zh-CN->en-US 的翻译方向。");
  }
  if (DIRECTION_PROFILES[resolved]) return DIRECTION_PROFILES[resolved];
  let [source, target] = splitDirection(resolved);
  if (!source || !target) throw new Error(`不支持的翻译方向：${direction}`);
  if (target.toLowerCase() === "auto") throw new Error("目标语不能使用自动识别，请明确选择目标语言。");
  return createLanguageProfile(source, target);
}

export function termFields(config) {
  if (config.sourceTermField && config.targetTermField) {
    return { sourceField: config.sourceTermField, targetField: config.targetTermField };
  }
  return {
    sourceField: languageField(config.sourceLanguage),
    targetField: languageField(config.targetLanguage),
  };
}

export function dedupeGlossaryTerms(entries, config) {
  const { sourceField, targetField } = termFields(config);
  const seen = new Set();
  return entries.filter((g) => {
    const key = `${g[sourceField]}|${g[targetField]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isReusableGlossaryTerm(entry) {
  const status = entry.status || "首选";
  return status === "首选" && entry.translation_action !== "do_not_translate";
}

export function reusableGlossaryTerms(entries, config) {
  return dedupeGlossaryTerms(entries.filter(isReusableGlossaryTerm), config);
}

export function languageLabelFor(code) {
  return languageName(normalizeLanguageCode(code));
}
