import { callModel } from "../lib/modelClient.mjs";
import { listDomainLabels, PENDING_DOMAIN_LABEL } from "../lib/domainTaxonomy.mjs";

export async function analyzeText(segments, sections, config) {
  const blockSample = (start, end) =>
    segments
      .slice(start - 1, Math.min(start - 1 + 10, end))
      .map((s) => s.text)
      .join("\n");

  const blocks = sections.map((sec, i) => {
    const end = i + 1 < sections.length ? sections[i + 1].start - 1 : segments.length;
    return { start: sec.start, end, sample: blockSample(sec.start, end) };
  });

  const promptBlocks = blocks
    .map((b, i) => `【第${i + 1}段，句段${b.start}-${b.end}起始节选】\n${b.sample}`)
    .join("\n\n");

  const domainLabels = listDomainLabels();

  const result = await callModel({
    system:
      `你是${config.sourceLabel || config.sourceLanguage}到${config.targetLabel || config.targetLanguage}翻译项目的文本分析助手。` +
      "给你的是同一份翻译素材文件中按顺序排列的多个段落节选。通常整份文件保持同一主题和文体；" +
      "只有在文本确实出现明显变化时，才为对应段落标注不同主题或文体；没有明显变化时请重复使用同一判断。" +
      "请只输出JSON，不要多余解释。",
    user:
      `${promptBlocks}\n\n请判断：\n` +
      `1) domain：整份文件的领域，必须从下面列表中选一项，一字不差地照抄，不要自造新词、不要增删字：\n${domainLabels.join("、")}\n` +
      `如果列表里没有足够贴切的一项，domain 填"${PENDING_DOMAIN_LABEL}"，并在 domainSuggestion 里给出你认为合适的简短中文领域短语(不超过10个字)；` +
      `如果成功从列表中选中了某项，domainSuggestion 填空字符串。\n` +
      `2) topics：一个数组，对应上面每一段各自的主题概括，简短中文短语(不超过12个字)，长度必须等于${blocks.length}\n` +
      `3) styleNotes：一个数组，对应上面每一段各自的文体/语域特征，供翻译时定风格用，` +
      `简短中文短语(不超过20个字，例如"客观陈述句，操作步骤用祈使句"或"营销文案，短句强调感染力，保留品牌语气")，长度必须等于${blocks.length}\n\n` +
      `按此JSON格式回复：{"domain": "...", "domainSuggestion": "...", "topics": ["...", "..."], "styleNotes": ["...", "..."]}`,
    json: true,
  });

  if (!Array.isArray(result.topics) || result.topics.length !== blocks.length) {
    throw new Error(`模型返回的topics数量(${result.topics?.length})与section数量(${blocks.length})不符`);
  }
  if (!Array.isArray(result.styleNotes) || result.styleNotes.length !== blocks.length) {
    throw new Error(`模型返回的styleNotes数量(${result.styleNotes?.length})与section数量(${blocks.length})不符`);
  }

  const defaultTopic = result.topics[0];
  const defaultStyleNote = result.styleNotes[0];
  const newSections = sections.slice(1).map((sec, i) => ({
    start: sec.start,
    topic: result.topics[i + 1],
    styleNote: result.styleNotes[i + 1],
  }));

  const domain = domainLabels.includes(result.domain) ? result.domain : PENDING_DOMAIN_LABEL;
  const domainSuggestion = domain === PENDING_DOMAIN_LABEL ? String(result.domainSuggestion || result.domain || "").trim() : "";

  return {
    ...config,
    domain,
    domainSuggestion,
    defaultTopic,
    defaultStyleNote,
    sections: newSections,
  };
}
