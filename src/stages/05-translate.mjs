import { callModel } from "../lib/modelClient.mjs";
import { assertIdSetMatches } from "../lib/bilingual.mjs";
import { termFields } from "../lib/language.mjs";


function blockRanges(segments, sections) {
  return sections.map((sec, i) => {
    const end = i + 1 < sections.length ? sections[i + 1].start - 1 : segments.length;
    return { start: sec.start, end, topic: sec.topic, styleNote: sec.styleNote };
  });
}

function relevantTerms(glossary, blockSegments, sourceField) {
  const confirmed = glossary.filter((g) => g.status === "首选");
  return confirmed.filter((g) => blockSegments.some((s) => s.text.includes(g[sourceField])));
}

export async function translateWithGlossary(segments, glossary, config, modelCall = callModel) {
  const { sourceField, targetField } = termFields(config);
  const sourceLabel = config.sourceLabel || config.sourceLanguage;
  const targetLabel = config.targetLabel || config.targetLanguage;
  const sections = [
    { start: 1, topic: config.defaultTopic, styleNote: config.defaultStyleNote },
    ...config.sections,
  ];
  const ranges = blockRanges(segments, sections);

  const byId = new Map();

  for (const range of ranges) {
    const blockSegments = segments.slice(range.start - 1, range.end);

    const pretranslated = blockSegments.filter((s) => s.target);
    for (const s of pretranslated) byId.set(s.id, s.target);
    const toTranslate = blockSegments.filter((s) => !s.target);
    if (toTranslate.length === 0) continue;

    const terms = relevantTerms(glossary, toTranslate, sourceField);
    const glossaryText =
      terms.map((t) => `${t[sourceField]} → ${t[targetField]}`).join("\n") || "（本段无适用已冻结术语）";
    const numbered = toTranslate.map((s) => `[${s.id}] ${s.text}`).join("\n");

    const result = await modelCall({
      system:
        `你是专业${sourceLabel}到${targetLabel}翻译。领域：${config.domain}；本段主题：${range.topic}；` +
        `本段文体/语域：${range.styleNote || "未定，按常规专业文本处理"}。` +
        "必须严格遵守给定术语表的译法，不得替换成别的说法；保持原文的语域和风格" +
        "（标题类短句译成标题风格，规格数值原样保留、单位不翻译）。只输出JSON，不要多余解释。",
      user:
        `冻结术语表(必须遵守)：\n${glossaryText}\n\n` +
        `请把以下带ID的${sourceLabel}原文逐条译成${targetLabel}，ID必须原样保留、不能增删、不能合并：\n${numbered}\n\n` +
        `按此JSON格式回复：{"translations": [{"id":"...","target":"..."}, ...]}`,
      json: true,
    });

    for (const t of result.translations ?? []) {
      byId.set(t.id, t.target ?? t.en ?? t.zh);
    }
  }

  const translatedSegments = segments.map((s) => ({
    id: s.id,
    source: s.text,
    target: byId.get(s.id) ?? "",
  }));
  assertIdSetMatches(
    translatedSegments.filter((s) => s.target !== ""),
    segments.map((s) => s.id)
  );
  return translatedSegments;
}
