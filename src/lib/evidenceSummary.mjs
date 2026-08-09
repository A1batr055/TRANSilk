export function summarizeEvidence(evidence = []) {
  const summary = {
    local: 0,
    webSearch: 0,
    webCrossChecked: 0,
    webSingleSource: 0,
    modelKnowledge: 0,
    webNotFound: 0,
    webError: 0,
  };
  for (const item of evidence) {
    if (item.source === "local") summary.local += 1;
    if (item.source === "web_search") {
      summary.webSearch += 1;
      if (item.verification_level === "cross_checked") summary.webCrossChecked += 1;
      else summary.webSingleSource += 1;
    }
    if (item.source !== "model_knowledge") continue;
    summary.modelKnowledge += 1;
    if (/^\[联网未检出(?:：[^\]]+)?\]/.test(String(item.quote ?? ""))) summary.webNotFound += 1;
    if (String(item.quote ?? "").startsWith("[联网失败：")) summary.webError += 1;
  }
  return summary;
}

export function formatEvidenceSummary(summary) {
  const webDetail = summary.webSearch > 0
    ? `（交叉查证 ${summary.webCrossChecked ?? 0}｜单一来源 ${summary.webSingleSource ?? summary.webSearch}）`
    : "";
  return `本地 ${summary.local}｜联网查证 ${summary.webSearch}${webDetail}｜模型知识 ${summary.modelKnowledge}`;
}
