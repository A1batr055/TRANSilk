import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { TOOL_ROOT } from "./paths.mjs";
import { termFields, isReusableGlossaryTerm } from "./language.mjs";
import { writeAssetConfig } from "./assetConfig.mjs";

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export function termbaseDir() {
  const configured = String(process.env.TRANSILK_TERMBASE_DIR || "").trim();
  return configured ? path.resolve(configured) : path.join(TOOL_ROOT, "termbase");
}

export function termbasePath() {
  return path.join(termbaseDir(), "termbase.jsonl");
}

export function internalProjectsDir() {
  return path.join(termbaseDir(), "internal-projects");
}

export function externalMountsPath() {
  return path.join(termbaseDir(), "external-mounts.json");
}

function normalizeTerm(term) {
  return String(term ?? "").trim().toLowerCase();
}

function entryKey(sourceLanguage, targetLanguage, sourceTerm, domain) {
  return `${String(sourceLanguage ?? "").toLowerCase()}::${String(targetLanguage ?? "").toLowerCase()}::${normalizeTerm(sourceTerm)}::${normalizeTerm(domain)}`;
}

export function loadTermbase() {
  const p = termbasePath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export function loadInternalProjectTerms() {
  const dir = internalProjectsDir();
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".json")).sort()) {
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    for (const entry of snapshot.entries ?? []) {
      entries.push({ ...entry, sourceKind: "internal", projectId: snapshot.projectId });
    }
  }
  return entries;
}

export function listMountedTermbases() {
  const p = externalMountsPath();
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8")).map((mount) => ({
    ...mount,
    available: fs.existsSync(mount.path),
  }));
}

function loadMountedTerms() {
  const entries = [];
  for (const mount of listMountedTermbases().filter((item) => item.enabled !== false && item.available)) {
    const xml = fs.readFileSync(mount.path, "utf8");
    for (const entry of parseTbx(xml)) {
      entries.push({ ...entry, sourceKind: "external", sourceId: mount.id, sourcePath: mount.path });
    }
  }
  return entries;
}

export function loadAllLocalTerms() {
  const legacy = loadTermbase().map((entry) => ({ ...entry, sourceKind: "legacy" }));
  return [...legacy, ...loadInternalProjectTerms(), ...loadMountedTerms()];
}

export function buildTermbaseIndex(entries = loadAllLocalTerms()) {
  const index = new Map();
  for (const entry of entries) {
    if (!entry.sourceTerm) continue;
    const key = entryKey(entry.sourceLanguage, entry.targetLanguage, entry.sourceTerm, entry.domain);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(entry);
  }
  return index;
}

export function lookupTerm(index, sourceLanguage, targetLanguage, sourceTerm, domain) {
  const matches = index.get(entryKey(sourceLanguage, targetLanguage, sourceTerm, domain)) ?? [];
  const byTarget = new Map();
  for (const match of matches) {
    const key = normalizeTerm(match.targetTerm);
    if (!byTarget.has(key)) byTarget.set(key, { ...match, localSources: [] });
    byTarget.get(key).localSources.push({
      sourceKind: match.sourceKind || "legacy",
      projectId: match.projectId || "",
      sourceId: match.sourceId || "",
    });
  }
  return [...byTarget.values()];
}

export function mergeIntoTermbase(newEntries) {
  const index = buildTermbaseIndex(loadTermbase());
  for (const entry of newEntries) {
    if (!entry.sourceTerm || !entry.targetTerm) continue;
    const key = entryKey(entry.sourceLanguage, entry.targetLanguage, entry.sourceTerm, entry.domain);
    const group = index.get(key) ?? [];
    const matchIndex = group.findIndex((e) => normalizeTerm(e.targetTerm) === normalizeTerm(entry.targetTerm));
    if (matchIndex >= 0) group[matchIndex] = entry;
    else group.push(entry);
    index.set(key, group);
  }
  const merged = [...index.values()].flat();
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
    .filter(isReusableGlossaryTerm)
    .filter((g) => g.evidence_local_kind !== "project_override")
    .map((g) => ({
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      sourceTerm: g[sourceField],
      targetTerm: g[targetField],
      domain: g.domain || config.domain || "",
      definition: g.definition || g.definition_zh || "",
      note: g.note || g.note_zh || "",
      originProject: config.title || g.source_title || "",
      originEntryId: g.id || "",
      approvedOn: today,
      originEvidenceSource: g.evidence_source || "",
      originEvidenceQuote: g.evidence_quote || "",
      originVerificationLevel: g.evidence_verification_level || "",
      originEvidenceUrls: ((g.evidence_sources ?? []).length
        ? g.evidence_sources.map((source) => source?.url)
        : String(g.evidence_url || "").split(/\r?\n/))
        .filter(Boolean),
      updatedAt: today,
    }))
    .filter((e) => e.sourceTerm && e.targetTerm);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
}

export function syncProjectAssets(config, projectDir, built) {
  if (!built?.jsonl || !fs.existsSync(built.jsonl)) {
    throw new Error("术语资产 JSONL 不存在，无法同步本地术语库");
  }
  const projectId = config.projectId || crypto.randomUUID();
  const resolvedConfig = config.projectId ? config : { ...config, projectId };
  if (!config.projectId) writeAssetConfig(projectDir, resolvedConfig);

  const assetContent = fs.readFileSync(built.jsonl, "utf8");
  const assetHash = sha256(assetContent);
  const snapshotName = `${sha256(projectId).slice(0, 32)}.json`;
  const snapshotPath = path.join(internalProjectsDir(), snapshotName);
  if (fs.existsSync(snapshotPath)) {
    const existing = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    if (existing.assetHash === assetHash) {
      return { changed: false, projectId, assetHash, entries: existing.entries?.length ?? 0, snapshotPath };
    }
  }

  const glossary = assetContent.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const entries = glossaryToTermbaseEntries(glossary, resolvedConfig).map((entry) => ({
    ...entry,
    sourceKind: "internal",
    projectId,
    assetHash,
  }));
  writeJsonAtomic(snapshotPath, {
    schemaVersion: 1,
    projectId,
    projectTitle: config.title,
    assetHash,
    syncedAt: new Date().toISOString(),
    entries,
  });
  return { changed: true, projectId, assetHash, entries: entries.length, snapshotPath };
}

function mountId(filePath) {
  const normalized = process.platform === "win32" ? filePath.toLowerCase() : filePath;
  return sha256(normalized).slice(0, 20);
}

function writeMountRegistry(mounts) {
  writeJsonAtomic(externalMountsPath(), mounts.map(({ available, ...mount }) => mount));
}

export function mountExternalTermbase(inputPath) {
  const resolvedInput = path.resolve(inputPath);
  const stat = fs.statSync(resolvedInput);
  const files = (stat.isDirectory() ? walkFiles(resolvedInput) : [resolvedInput])
    .filter((file) => [".tbx", ".xml", ".tmx"].includes(path.extname(file).toLowerCase()));
  const mounts = listMountedTermbases();
  const byId = new Map(mounts.map((mount) => [mount.id, mount]));
  const mounted = [];
  const skipped = [];

  for (const file of files) {
    const xml = fs.readFileSync(file, "utf8");
    if (detectXmlRoot(xml) !== "tbx") {
      skipped.push({ file, reason: "不是有效的 TBX" });
      continue;
    }
    const entries = parseTbx(xml);
    if (!entries.length) {
      skipped.push({ file, reason: "未解析出术语条目" });
      continue;
    }
    const id = mountId(path.resolve(file));
    const previous = byId.get(id);
    const mount = {
      id,
      name: path.basename(file),
      path: path.resolve(file),
      enabled: true,
      mountedAt: previous?.mountedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fileHash: sha256(xml),
      entryCount: entries.length,
    };
    byId.set(id, mount);
    mounted.push({ file: mount.path, id, count: entries.length, updated: Boolean(previous) });
  }
  writeMountRegistry([...byId.values()]);
  return { mounted, skipped, totalMounts: byId.size };
}

export function unmountExternalTermbase(identifier) {
  const mounts = listMountedTermbases();
  const resolved = path.resolve(identifier);
  const kept = mounts.filter((mount) => mount.id !== identifier && path.resolve(mount.path) !== resolved);
  if (kept.length === mounts.length) return { removed: null, totalMounts: mounts.length };
  const removed = mounts.find((mount) => !kept.some((item) => item.id === mount.id));
  writeMountRegistry(kept);
  return { removed, totalMounts: kept.length };
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
  const result = mountExternalTermbase(inputPath);
  return {
    imported: result.mounted,
    mounted: result.mounted,
    skipped: result.skipped,
    addedOrUpdated: result.mounted.reduce((sum, item) => sum + item.count, 0),
    termbaseSize: loadAllLocalTerms().length,
    totalMounts: result.totalMounts,
  };
}
