import { callModel } from "../lib/modelClient.mjs";
import { termFields } from "../lib/language.mjs";
import { listDomainLabels } from "../lib/domainTaxonomy.mjs";


function blockRanges(segments, sections) {
  return sections.map((sec, i) => {
    const end = i + 1 < sections.length ? sections[i + 1].start - 1 : segments.length;
    return { start: sec.start, end, topic: sec.topic };
  });
}

export async function extractCandidates(segments, config, modelCall = callModel) {
  const { sourceField, targetField } = termFields(config);
  const sourceLabel = config.sourceLabel || config.sourceLanguage;
  const targetLabel = config.targetLabel || config.targetLanguage;
  const sections = [{ start: 1, topic: config.defaultTopic }, ...config.sections];
  const ranges = blockRanges(segments, sections);
  const domainLabels = listDomainLabels();

  let counter = 0;
  const candidates = [];

  for (const range of ranges) {
    const blockSegments = segments.slice(range.start - 1, range.end);
    const numbered = blockSegments.map((s) => `[${s.id}] ${s.text}`).join("\n");

    const result = await modelCall({
      system:
        `你是${sourceLabel}到${targetLabel}翻译项目的术语抽取助手。只抽取真正需要统一译法的术语——专有名词、` +
        "技术术语、标准/牌号、缩略语；不要抽普通词汇或完整句子。只输出JSON，不要多余解释。",
      user:
        `本文件整体领域：${config.domain}；本段主题：${range.topic}\n\n` +
        `以下是带句段ID的${sourceLabel}原文：\n${numbered}\n\n` +
        `请抽取候选术语，每条给出：${sourceField}(${sourceLabel}原词，须原样摘自原文)、` +
        `${targetField}(唯一${targetLabel}译法——同一语境下译法唯一，不要给多个备选)、` +
        `part_of_speech(词性)、domain(这条术语本身所属的具体领域，必须从下面列表中选一项，一字不差地照抄，` +
        `不要自造新词：${domainLabels.join("、")}；大多数术语跟本文件整体领域一致，直接填本文件整体领域即可，` +
        `只有当这条术语明显属于另一个更贴切的领域时才改填那个领域)、` +
        `definition(用项目工作语言写的简短释义，不确定可留空)、` +
        `note(需要注意的地方，不确定可留空)、source_segment_id(取自上面方括号里的ID，选第一次出现的那条)。\n` +
        `按此JSON格式回复：{"terms": [{"${sourceField}":"...","${targetField}":"...",` +
        `"part_of_speech":"...","domain":"...","definition":"...","note":"...","source_segment_id":"..."}]}`,
      json: true,
    });

    for (const t of result.terms ?? []) {
      counter += 1;
      candidates.push({
        id: `CAND-${String(counter).padStart(4, "0")}`,
        sourceTermField: sourceField,
        targetTermField: targetField,
        [sourceField]: t[sourceField],
        [targetField]: t[targetField],
        ...(sourceField === "zh_CN" || targetField === "zh_CN" ? { zh_CN: t.zh_CN } : {}),
        ...(sourceField === "en_US" || targetField === "en_US" ? { en_US: t.en_US } : {}),
        part_of_speech: t.part_of_speech ?? "",
        domain: domainLabels.includes(t.domain) ? t.domain : config.domain,
        definition: t.definition ?? t.definition_zh ?? "",
        note: t.note ?? t.note_zh ?? "",
        definition_zh: t.definition_zh ?? t.definition ?? "",
        note_zh: t.note_zh ?? t.note ?? "",
        source_segment_id: t.source_segment_id,
      });
    }
  }

  return candidates;
}
