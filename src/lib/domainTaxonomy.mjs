import fs from "node:fs";
import path from "node:path";
import { TOOL_ROOT } from "./paths.mjs";

export const PENDING_DOMAIN_LABEL = "待归类";

export function domainTaxonomyDir() {
  return path.join(TOOL_ROOT, "domain-taxonomy");
}

export function domainTaxonomyPath() {
  return path.join(domainTaxonomyDir(), "domains.jsonl");
}

export function domainTaxonomyLocalPath() {
  return path.join(domainTaxonomyDir(), "domains.local.jsonl");
}

export function pendingDomainsPath() {
  return path.join(domainTaxonomyDir(), "pending.jsonl");
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch (error) {
      throw new Error(`${filePath} 第 ${index + 1} 行不是合法 JSON：${error.message}`);
    }
  });
}

function appendJsonl(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
}

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
  fs.writeFileSync(filePath, content, "utf8");
}

export function ensureDomainTaxonomyFiles({ localPath = domainTaxonomyLocalPath(), pendingPath = pendingDomainsPath() } = {}) {
  for (const filePath of [localPath, pendingPath]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf8");
  }
  return { seedPath: domainTaxonomyPath(), localPath, pendingPath };
}

export function loadDomains(filePath = domainTaxonomyPath()) {
  return readJsonl(filePath);
}

export function loadLocalDomains(filePath = domainTaxonomyLocalPath()) {
  return readJsonl(filePath);
}

export function listDomainLabels({ seedPath = domainTaxonomyPath(), localPath = domainTaxonomyLocalPath() } = {}) {
  const seedLabels = loadDomains(seedPath).map((d) => d.label);
  const localLabels = loadLocalDomains(localPath).map((d) => d.label);
  return [...new Set([...seedLabels, ...localLabels])];
}

export function addDomain(label, {
  seedPath = domainTaxonomyPath(),
  localPath = domainTaxonomyLocalPath(),
} = {}) {
  const trimmed = String(label ?? "").trim();
  if (!trimmed) throw new Error("领域名不能为空");
  const existing = listDomainLabels({ seedPath, localPath });
  if (existing.includes(trimmed)) throw new Error(`领域“${trimmed}”已存在，未重复收录`);
  appendJsonl(localPath, { label: trimmed });
  return existing.length + 1;
}

export function loadPendingDomains(filePath = pendingDomainsPath()) {
  return readJsonl(filePath);
}

export function recordPendingDomain(suggestion, context = {}, filePath = pendingDomainsPath()) {
  appendJsonl(filePath, {
    suggestion: String(suggestion ?? "").trim(),
    title: context.title ?? "",
    date: context.date ?? new Date().toISOString().slice(0, 10),
  });
}

export function acceptPendingDomain(index, options = {}) {
  const pendingPath = options.pendingPath ?? pendingDomainsPath();
  const pending = loadPendingDomains(pendingPath);
  const entry = pending[index];
  if (!entry) throw new Error(`待归类记录不存在：${index + 1}`);
  const label = String(options.label ?? entry.suggestion).trim();
  const total = addDomain(label, options);
  writeJsonl(pendingPath, pending.filter((_, itemIndex) => itemIndex !== index));
  return { entry, label, total };
}

export function dismissPendingDomain(index, { pendingPath = pendingDomainsPath() } = {}) {
  const pending = loadPendingDomains(pendingPath);
  const entry = pending[index];
  if (!entry) throw new Error(`待归类记录不存在：${index + 1}`);
  writeJsonl(pendingPath, pending.filter((_, itemIndex) => itemIndex !== index));
  return entry;
}
