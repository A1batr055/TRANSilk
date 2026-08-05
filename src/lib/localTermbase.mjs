import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { TOOL_ROOT } from "./paths.mjs";
import { termFields } from "./language.mjs";

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export function termbaseDir() {
  return path.join(TOOL_ROOT, "termbase");
}

export function termbasePath() {
  return path.join(termbaseDir(), "termbase.jsonl");
}

function normalizeTerm(term) {
  return String(term ?? "").trim().toLowerCase();
}

function entryKey(sourceLanguage, sourceTerm, domain) {
  return `${String(sourceLanguage ?? "").toLowerCase()}::${normalizeTerm(sourceTerm)}::${normalizeTerm(domain)}`;
}

export function loadTermbase() {
  const p = termbasePath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export function buildTermbaseIndex(entries = loadTermbase()) {
  const index = new Map();
  for (const entry of entries) {
    if (entry.sourceTerm) index.set(entryKey(entry.sourceLanguage, entry.sourceTerm, entry.domain), entry);
  }
  return index;
}

export function lookupTerm(index, sourceLanguage, sourceTerm, domain) {
  return index.get(entryKey(sourceLanguage, sourceTerm, domain)) ?? null;
}

export function mergeIntoTermbase(newEntries) {
  const index = buildTermbaseIndex();
  for (const entry of newEntries) {
    if (!entry.sourceTerm || !entry.targetTerm) continue;
    index.set(entryKey(entry.sourceLanguage, entry.sourceTerm, entry.domain), entry);
  }
  const merged = [...index.values()];
  fs.mkdirSync(termbaseDir(), { recursive: true });
  fs.writeFileSync(
    termbasePath(),
    merged.map((e) => JSON.stringify(e)).join("\n") + (merged.length ? "\n" : ""),
    "utf8"
  );
  return merged.length;
}

export function glossaryToTermbaseEntries(glossary, config) {
  const { sourceField, targetField } = termFields(config);
  const today = new Date().toISOString().slice(0, 10);
  return glossary
    .filter((g) => g.status !== "弃用")
    .map((g) => ({
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      sourceTerm: g[sourceField],
      targetTerm: g[targetField],
      domain: g.domain || config.domain || "",
      definition: g.definition || g.definition_zh || "",
      note: g.note || g.note_zh || "",
      updatedAt: today,
    }))
    .filter((e) => e.sourceTerm && e.targetTerm);
}

function textOf(node) {
  if (node == null) return "";
  if (typeof node === "object") return String(node["#text"] ?? "");
  return String(node);
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function descripText(descrips, type) {
  const match = asArray(descrips).find((d) => d?.["@_type"] === type);
  return match ? textOf(match) : "";
}

export function parseTbx(xml) {
  const doc = xmlParser.parse(xml);
  const body = doc?.tbx?.text?.body;
  if (!body) return [];
  const concepts = asArray(body.conceptEntry ?? body.termEntry);
  const results = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const concept of concepts) {
    const domain = descripText(concept.descrip, "subjectField");
    const definition = descripText(concept.descrip, "definition");
    const langs = asArray(concept.langSec)
      .map((sec) => ({ lang: sec["@_xml:lang"], term: textOf(asArray(sec.termSec)[0]?.term) }))
      .filter((l) => l.lang && l.term);
    for (const from of langs) {
      for (const to of langs) {
        if (from === to) continue;
        results.push({
          sourceLanguage: from.lang,
          targetLanguage: to.lang,
          sourceTerm: from.term,
          targetTerm: to.term,
          domain,
          definition,
          note: "",
          updatedAt: today,
        });
      }
    }
  }
  return results;
}

function detectXmlRoot(xml) {
  const match = xml.match(/<([a-zA-Z][\w-]*)[\s>]/);
  return match ? match[1] : "";
}

function walkFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else results.push(full);
  }
  return results;
}

export function importTermbaseFromPath(inputPath) {
  const stat = fs.statSync(inputPath);
  const files = stat.isDirectory() ? walkFiles(inputPath) : [inputPath];
  const imported = [];
  const skipped = [];
  const collected = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (![".tbx", ".tmx", ".xml"].includes(ext)) continue;
    const xml = fs.readFileSync(file, "utf8");
    const root = detectXmlRoot(xml);
    if (root !== "tbx") {
      skipped.push({ file, reason: root === "tmx" ? "TMX 记忆库暂不纳入本地术语库" : "不是有效的 TBX" });
      continue;
    }
    const entries = parseTbx(xml);
    if (!entries.length) {
      skipped.push({ file, reason: "未解析出术语条目" });
      continue;
    }
    collected.push(...entries);
    imported.push({ file, count: entries.length });
  }

  const termbaseSize = collected.length ? mergeIntoTermbase(collected) : loadTermbase().length;
  return { imported, skipped, addedOrUpdated: collected.length, termbaseSize };
}
