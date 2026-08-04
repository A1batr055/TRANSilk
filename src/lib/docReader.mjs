import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";


function findAllNodes(node, tagName, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) findAllNodes(item, tagName, out);
    return out;
  }
  if (node == null || typeof node !== "object") return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === tagName) {
      out.push(...(Array.isArray(value) ? value : [value]));
    } else {
      findAllNodes(value, tagName, out);
    }
  }
  return out;
}

function collectRunTexts(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectRunTexts(item, out);
    return;
  }
  if (node == null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "w:t") {
      for (const item of Array.isArray(value) ? value : [value]) {
        out.push(typeof item === "string" ? item : String(item?.["#text"] ?? ""));
      }
    } else if (key === "w:tab") {
      out.push("\t");
    } else if (key === "w:br" || key === "w:cr") {
      out.push(" ");
    } else {
      collectRunTexts(value, out);
    }
  }
}

async function readDocxParagraphs(filePath) {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) {
    throw new Error(`不是有效的 .docx 文件（缺 word/document.xml）：${filePath}`);
  }
  const xmlText = await docFile.async("string");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const doc = parser.parse(xmlText);

  const paragraphNodes = findAllNodes(doc, "w:p");
  const paragraphs = paragraphNodes
    .map((p) => {
      const texts = [];
      collectRunTexts(p, texts);
      return texts.join("").trim();
    })
    .filter((text) => text.length > 0);

  return paragraphs;
}

function readTxtParagraphs(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const blocks = raw.split(/\r?\n\s*\r?\n+/);
  return blocks
    .map((block) =>
      block
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ")
    )
    .filter((text) => text.length > 0);
}

export async function readDocumentParagraphs(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".docx") return readDocxParagraphs(filePath);
  if (ext === ".txt" || ext === ".md") return readTxtParagraphs(filePath);
  throw new Error(`不支持的原始材料格式 "${ext}"：${filePath}（目前支持 .docx、.txt、.md；.doc 会在新建项目时转为 .docx）`);
}
