import fs from "node:fs";
import { writeSimpleWorkbook, readSimpleWorkbook } from "../lib/xlsx.mjs";
import { termFields } from "../lib/language.mjs";
import { listDomainLabels, PENDING_DOMAIN_LABEL, recordPendingDomain } from "../lib/domainTaxonomy.mjs";


const DELETE_MARK = "删除";

export function reviewHeaders(config) {
  const sourceLabel = config?.sourceLabel || config?.sourceLanguage || "原文";
  const targetLabel = config?.targetLabel || config?.targetLanguage || "译文";
  return ["id", sourceLabel, `${targetLabel}译法`, "领域", "依据", "来源 URL", "删除", "疑似重复"];
}

function colLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function normalizeKey(term) {
  return String(term ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function groupEvidence(evidence) {
  const map = new Map();
  for (const e of evidence) {
    if (!map.has(e.candidate_id)) map.set(e.candidate_id, []);
    map.get(e.candidate_id).push(e);
  }
  return map;
}

function bestEvidence(evidenceByCandidate, candidateId) {
  const list = evidenceByCandidate.get(candidateId) ?? [];
  const order = ["do_not_translate", "local", "web_search", "model_knowledge"];
  return list.slice().sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source))[0];
}

function formatEvidence(ev) {
  if (!ev) return "（无出处）";
  const quote = (ev.quote ?? "").slice(0, 120);
  if (ev.source === "do_not_translate") return `[不译] ${quote}`;
  const level = ev.source === "web_search"
    ? ev.verification_level === "cross_checked" ? "·交叉查证" : "·单一来源"
    : "";
  return `[${ev.source}${level}] ${quote}`;
}

function evidenceUrls(ev) {
  if (!ev) return "";
  const urls = (ev.sources ?? []).map((item) => item?.url).filter(Boolean);
  if (!urls.length && ev.url) urls.push(ev.url);
  return [...new Set(urls)].join("\n");
}

export async function exportCandidatesToWorkbook(candidates, evidence, workbookPath, config) {
  const evidenceByCandidate = groupEvidence(evidence);
  const headers = reviewHeaders(config);
  const { sourceField, targetField } = termFields(config);

  const groups = new Map();
  for (const c of candidates) {
    const key = `${normalizeKey(c[sourceField])}|${normalizeKey(c[targetField])}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c.id);
  }

  const rows = candidates.map((c) => {
    const key = `${normalizeKey(c[sourceField])}|${normalizeKey(c[targetField])}`;
    const group = groups.get(key);
    const duplicateHint = group.length > 1 ? `疑似重复于 ${group.filter((id) => id !== c.id).join("、")}` : "";
    const best = bestEvidence(evidenceByCandidate, c.id);
    return [
      c.id,
      c[sourceField],
      c[targetField],
      c.domain || "",
      formatEvidence(best),
      evidenceUrls(best),
      "",
      duplicateHint,
    ];
  });

  const lastRow = rows.length + 1;
  const domainCol = colLetter(headers.indexOf("领域") + 1);
  const deleteCol = colLetter(headers.indexOf("删除") + 1);
  const buffer = await writeSimpleWorkbook({
    sheetName: "候选术语审阅",
    headers,
    rows,
    dataValidations: [
      { sqref: `${deleteCol}2:${deleteCol}${lastRow}`, list: [DELETE_MARK] },
      { sqref: `${domainCol}2:${domainCol}${lastRow}`, list: [...listDomainLabels(), PENDING_DOMAIN_LABEL], errorStyle: "warning" },
    ],
  });
  fs.writeFileSync(workbookPath, buffer);
  return workbookPath;
}

export async function importReviewedGlossary(workbookPath, candidates, evidence = []) {
  const buffer = fs.readFileSync(workbookPath);
  const { headers, rows } = await readSimpleWorkbook(buffer);
  const idx = (name) => headers.indexOf(name);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const evidenceByCandidate = groupEvidence(evidence);
  const domainLabels = listDomainLabels();

  return rows.map((row) => {
    const id = row[idx("id")];
    const original = byId.get(id) ?? {};
    const sourceField = original.sourceTermField || Object.keys(original).find((key) => key.includes("_") && !key.startsWith("source_")) || "zh_CN";
    const targetField = original.targetTermField || (sourceField === "zh_CN" ? "en_US" : "zh_CN");
    const sourceHeader = headers[1];
    const targetHeader = headers[2];
    const deleted = row[idx("删除")]?.trim() === DELETE_MARK;
    const best = bestEvidence(evidenceByCandidate, id);

    const rawDomain = row[idx("领域")]?.trim() ?? "";
    let domain = original.domain ?? "";
    if (rawDomain && rawDomain !== domain) {
      if (domainLabels.includes(rawDomain) || rawDomain === PENDING_DOMAIN_LABEL) {
        domain = rawDomain;
      } else {
        recordPendingDomain(rawDomain, { title: original[sourceField] ?? id });
        domain = PENDING_DOMAIN_LABEL;
      }
    }

    return {
      id,
      [sourceField]: row[idx(sourceHeader)],
      [targetField]: row[idx(targetHeader)],
      ...(sourceField === "zh_CN" || targetField === "zh_CN" ? { zh_CN: sourceField === "zh_CN" ? row[idx(sourceHeader)] : row[idx(targetHeader)] } : {}),
      ...(sourceField === "en_US" || targetField === "en_US" ? { en_US: sourceField === "en_US" ? row[idx(sourceHeader)] : row[idx(targetHeader)] } : {}),
      en_variants: [],
      part_of_speech: original.part_of_speech ?? "",
      domain,
      status: deleted ? "弃用" : "首选",
      definition: original.definition ?? original.definition_zh ?? "",
      note: original.note ?? original.note_zh ?? "",
      definition_zh: original.definition_zh ?? original.definition ?? "",
      note_zh: original.note_zh ?? original.note ?? "",
      translation_action: original.translation_action ?? "translate",
      translation_action_reason: original.translation_action_reason ?? "",
      source_segment_id: original.source_segment_id ?? "",
      evidence_source: best?.source ?? "",
      evidence_quote: best?.quote ?? "",
      evidence_url: evidenceUrls(best),
    };
  });
}
