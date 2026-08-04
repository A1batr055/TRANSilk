import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";


function colLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const C = {
  navy: "17365D",
  blue: "1F4E78",
  light: "D9EAF7",
  pale: "F8FBFD",
  green: "E2F0D9",
  gold: "FFF2CC",
  white: "FFFFFF",
  border: "B4C7DC",
};

class StyleRegistry {
  constructor() {
    this.fonts = [{ name: "Calibri", size: 11, bold: false, color: "000000" }];
    this.fills = [{ pattern: "none" }, { pattern: "gray125" }];
    this.borders = [{}];
    this.xfs = [{ fontId: 0, fillId: 0, borderId: 0, align: null }];
    this._fontKey = new Map([["Calibri|11|false|000000", 0]]);
    this._fillKey = new Map([["none", 0], ["gray125", 1]]);
    this._borderKey = new Map([["none", 0]]);
    this._xfKey = new Map();
  }

  fontIndex({ name = "Calibri", size = 11, bold = false, color = "000000" } = {}) {
    const key = `${name}|${size}|${bold}|${color}`;
    if (this._fontKey.has(key)) return this._fontKey.get(key);
    const idx = this.fonts.length;
    this.fonts.push({ name, size, bold, color });
    this._fontKey.set(key, idx);
    return idx;
  }

  fillIndex(colorHex) {
    if (!colorHex) return 0;
    if (this._fillKey.has(colorHex)) return this._fillKey.get(colorHex);
    const idx = this.fills.length;
    this.fills.push({ pattern: "solid", fgColor: colorHex });
    this._fillKey.set(colorHex, idx);
    return idx;
  }

  borderIndex(spec) {
    const key = spec ? JSON.stringify(spec) : "none";
    if (this._borderKey.has(key)) return this._borderKey.get(key);
    const idx = this.borders.length;
    this.borders.push(spec || {});
    this._borderKey.set(key, idx);
    return idx;
  }

  xfIndex({ font, fill, border, align } = {}) {
    const fontId = this.fontIndex(font);
    const fillId = this.fillIndex(fill);
    const borderId = this.borderIndex(border);
    const alignKey = align ? JSON.stringify(align) : "";
    const key = `${fontId}|${fillId}|${borderId}|${alignKey}`;
    if (this._xfKey.has(key)) return this._xfKey.get(key);
    const idx = this.xfs.length;
    this.xfs.push({ fontId, fillId, borderId, align });
    this._xfKey.set(key, idx);
    return idx;
  }

  toXml() {
    const fontsXml = this.fonts
      .map((f) => {
        const parts = [`<sz val="${f.size}"/>`];
        if (f.color && f.color !== "000000") parts.push(`<color rgb="FF${f.color}"/>`);
        parts.push(`<name val="${escapeXml(f.name)}"/>`);
        if (f.bold) parts.push("<b/>");
        return `<font>${parts.join("")}</font>`;
      })
      .join("");
    const fillsXml = this.fills
      .map((f) => {
        if (f.pattern === "none") return `<fill><patternFill patternType="none"/></fill>`;
        if (f.pattern === "gray125") return `<fill><patternFill patternType="gray125"/></fill>`;
        return `<fill><patternFill patternType="solid"><fgColor rgb="FF${f.fgColor}"/><bgColor indexed="64"/></patternFill></fill>`;
      })
      .join("");
    const borderSide = (side) => (side ? `<color rgb="FF${side.color}"/>` : "");
    const bordersXml = this.borders
      .map((b) => {
        const bottom = b.bottom
          ? `<bottom style="${b.bottom.style}">${borderSide(b.bottom)}</bottom>`
          : "<bottom/>";
        return `<border><left/><right/><top/>${bottom}<diagonal/></border>`;
      })
      .join("");
    const xfsXml = this.xfs
      .map((xf) => {
        const alignXml = xf.align
          ? `<alignment${xf.align.horizontal ? ` horizontal="${xf.align.horizontal}"` : ""}${
              xf.align.vertical ? ` vertical="${xf.align.vertical}"` : ""
            }${xf.align.wrapText ? ` wrapText="1"` : ""}/>`
          : "";
        return (
          `<xf numFmtId="0" fontId="${xf.fontId}" fillId="${xf.fillId}" borderId="${xf.borderId}" xfId="0"` +
          `${xf.fontId ? ' applyFont="1"' : ""}${xf.fillId ? ' applyFill="1"' : ""}${xf.borderId ? ' applyBorder="1"' : ""}` +
          `${alignXml ? ' applyAlignment="1"' : ""}>${alignXml}</xf>`
        );
      })
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="${this.fonts.length}">${fontsXml}</fonts>
<fills count="${this.fills.length}">${fillsXml}</fills>
<borders count="${this.borders.length}">${bordersXml}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${this.xfs.length}">${xfsXml}</cellXfs>
</styleSheet>`;
  }
}

class SharedStrings {
  constructor() {
    this.list = [];
    this.index = new Map();
  }
  idOf(text) {
    if (this.index.has(text)) return this.index.get(text);
    const idx = this.list.length;
    this.list.push(text);
    this.index.set(text, idx);
    return idx;
  }
  toXml() {
    const items = this.list.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.list.length}" uniqueCount="${this.list.length}">${items}</sst>`;
  }
}

const BORDER_THIN = { bottom: { style: "thin", color: C.border } };
const BORDER_HAIR = { bottom: { style: "hair", color: C.border } };

function buildGuideSheet(reg, strings, { title, rows }) {
  const cells = [];
  cells.push({ row: 1, col: 1, value: title, style: reg.xfIndex({ font: { name: "Microsoft YaHei", size: 16, bold: true, color: C.white }, fill: C.navy, align: { horizontal: "left", vertical: "middle" } }) });
  const headerStyle = reg.xfIndex({ font: { name: "Microsoft YaHei", size: 10, bold: true, color: C.white }, fill: C.blue, align: { horizontal: "center", vertical: "middle", wrapText: true }, border: BORDER_THIN });
  cells.push({ row: 3, col: 1, value: "项目", style: headerStyle });
  cells.push({ row: 3, col: 2, value: "内容", style: headerStyle });
  const labelStyle = reg.xfIndex({ font: { name: "Microsoft YaHei", size: 10, bold: true }, fill: C.light, align: { horizontal: "left", vertical: "middle", wrapText: true } });
  const valueStyle = reg.xfIndex({ font: { name: "Microsoft YaHei", size: 10 }, align: { horizontal: "left", vertical: "middle", wrapText: true } });
  let r = 4;
  const rowHeights = { 1: 30, 3: 20 };
  for (const [label, value] of rows) {
    cells.push({ row: r, col: 1, value: label, style: labelStyle });
    cells.push({ row: r, col: 2, value, style: valueStyle });
    rowHeights[r] = 30;
    r += 1;
  }
  const lastRow = r - 1;
  return {
    name: "使用说明",
    columns: [24, 86],
    merges: ["A1:B1"],
    freeze: null,
    autoFilter: null,
    cells,
    rowHeights,
    lastRow,
    lastCol: 2,
  };
}

function buildAlignedSheet(reg, strings, { title, pairs, sourceColumnLabel, targetColumnLabel, sourceLanguage, targetLanguage }) {
  const isZh = (l) => /^zh(?:-|$)/iu.test(l);
  const fontForLanguage = (l) => (isZh(l) ? "Microsoft YaHei" : "Aptos");
  const charsPerLine = (l) => (isZh(l) ? 28 : 58);

  const cells = [];
  cells.push({ row: 1, col: 1, value: title, style: reg.xfIndex({ font: { name: "Microsoft YaHei", size: 16, bold: true, color: C.white }, fill: C.navy, align: { horizontal: "left", vertical: "middle" } }) });
  const headerStyle = reg.xfIndex({ font: { name: "Microsoft YaHei", size: 10, bold: true, color: C.white }, fill: C.blue, align: { horizontal: "center", vertical: "middle", wrapText: true }, border: BORDER_THIN });
  const headers = ["ID", "类型", "主题", sourceColumnLabel, targetColumnLabel, "核对状态"];
  headers.forEach((h, i) => cells.push({ row: 3, col: i + 1, value: h, style: headerStyle }));

  const rowHeights = { 1: 30 };
  let r = 4;
  for (const pair of pairs) {
    const isHeading = pair.type !== "正文";
    const fill = isHeading ? C.light : pair.number % 2 === 0 ? C.pale : null;
    const centerAlign = { horizontal: "center", vertical: "top", wrapText: true };
    const leftAlign = { horizontal: "left", vertical: "top", wrapText: true };
    const baseFont = { name: "Microsoft YaHei", size: 10, bold: isHeading };
    const srcStyle = reg.xfIndex({ font: { ...baseFont, name: fontForLanguage(sourceLanguage) }, fill, align: leftAlign, border: BORDER_HAIR });
    const tgtStyle = reg.xfIndex({ font: { ...baseFont, name: fontForLanguage(targetLanguage) }, fill, align: leftAlign, border: BORDER_HAIR });
    const plainStyle = reg.xfIndex({ font: baseFont, fill, align: centerAlign, border: BORDER_HAIR });
    const statusStyle = reg.xfIndex({ font: baseFont, fill: C.green, align: centerAlign, border: BORDER_HAIR });

    cells.push({ row: r, col: 1, value: pair.id, style: plainStyle });
    cells.push({ row: r, col: 2, value: pair.type, style: plainStyle });
    cells.push({ row: r, col: 3, value: pair.topic, style: plainStyle });
    cells.push({ row: r, col: 4, value: pair.source, style: srcStyle });
    cells.push({ row: r, col: 5, value: pair.target, style: tgtStyle });
    cells.push({ row: r, col: 6, value: "已对齐", style: statusStyle, validation: ["已对齐", "待复核", "需调整"] });

    rowHeights[r] = Math.min(
      72,
      Math.max(24, Math.ceil(Math.max(pair.source.length / charsPerLine(sourceLanguage), pair.target.length / charsPerLine(targetLanguage))) * 15)
    );
    r += 1;
  }
  const lastRow = r - 1;
  return {
    name: "句段对齐",
    columns: [14, 12, 20, 58, 82, 12],
    merges: ["A1:F1"],
    freeze: { xSplit: 3, ySplit: 3 },
    autoFilter: `A3:F${lastRow}`,
    cells,
    rowHeights,
    lastRow,
    lastCol: 6,
  };
}

function buildTermsSheet(reg, strings, { title, glossary, sourceColumnLabel, targetColumnLabel, sourceField, targetField }) {
  const cells = [];
  cells.push({ row: 1, col: 1, value: title, style: reg.xfIndex({ font: { name: "Microsoft YaHei", size: 16, bold: true, color: C.white }, fill: C.navy, align: { horizontal: "left", vertical: "middle" } }) });
  const headerStyle = reg.xfIndex({ font: { name: "Microsoft YaHei", size: 10, bold: true, color: C.white }, fill: C.blue, align: { horizontal: "center", vertical: "middle", wrapText: true }, border: BORDER_THIN });
  const headers = ["ID", sourceColumnLabel, `${targetColumnLabel}首选词`, `${targetColumnLabel}变体`, "词类", "领域", "状态", "释义", "复用说明", "来源句段", `${sourceColumnLabel}语境`, `${targetColumnLabel}语境`, "查证依据"];
  headers.forEach((h, i) => cells.push({ row: 3, col: i + 1, value: h, style: headerStyle }));

  const centerCols = new Set([1, 5, 6, 7, 10]);
  const targetCols = new Set([3, 4, 12]);
  const rowHeights = { 1: 30 };
  let r = 4;
  for (const item of glossary) {
    const evidenceText = item.evidence_quote ? `[${item.evidence_source}] ${item.evidence_quote}` : "";
    const values = [
      item.id,
      item[sourceField],
      item[targetField],
      (item[`${targetField}_variants`] ?? item.en_variants ?? []).join("；"),
      item.part_of_speech,
      item.domain,
      item.status || "首选",
      item.definition ?? item.definition_zh,
      item.note ?? item.note_zh,
      item.source_segment_id,
      item.context_source ?? item.context_zh,
      item.context_target ?? item.context_en,
      evidenceText,
    ];
    const fill = r % 2 === 0 ? C.pale : null;
    values.forEach((value, i) => {
      const col = i + 1;
      const isStatus = col === 7;
      const align = { horizontal: centerCols.has(col) ? "center" : "left", vertical: "top", wrapText: true };
      const font = { name: targetCols.has(col) ? "Aptos" : "Microsoft YaHei", size: 10 };
      const style = reg.xfIndex({ font, fill: isStatus ? C.gold : fill, align, border: BORDER_HAIR });
      const cell = { row: r, col, value, style };
      if (isStatus) cell.validation = ["首选", "待复核", "弃用"];
      cells.push(cell);
    });
    rowHeights[r] = 54;
    r += 1;
  }
  const lastRow = r - 1;
  return {
    name: "术语库",
    columns: [14, 22, 30, 34, 12, 14, 10, 46, 48, 16, 58, 78, 60],
    merges: ["A1:M1"],
    freeze: { xSplit: 3, ySplit: 3 },
    autoFilter: `A3:M${lastRow}`,
    cells,
    rowHeights,
    lastRow,
    lastCol: 13,
  };
}

function sheetXml(sheet, strings) {
  const byRow = new Map();
  for (const cell of sheet.cells) {
    if (!byRow.has(cell.row)) byRow.set(cell.row, []);
    byRow.get(cell.row).push(cell);
  }
  const validations = [];
  const rowsXml = [...byRow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rowNum, cells]) => {
      const height = sheet.rowHeights[rowNum];
      const heightAttr = height ? ` customHeight="1" ht="${height}"` : "";
      const cellsXml = cells
        .sort((a, b) => a.col - b.col)
        .map((cell) => {
          if (cell.validation) {
            const ref = `${colLetter(cell.col)}${rowNum}`;
            validations.push({ sqref: ref, list: cell.validation });
          }
          const value = cell.value ?? "";
          if (value === "") return `<c r="${colLetter(cell.col)}${rowNum}" s="${cell.style}"/>`;
          const idx = strings.idOf(String(value));
          return `<c r="${colLetter(cell.col)}${rowNum}" s="${cell.style}" t="s"><v>${idx}</v></c>`;
        })
        .join("");
      return `<row r="${rowNum}"${heightAttr}>${cellsXml}</row>`;
    })
    .join("");

  const colsXml = sheet.columns.length
    ? `<cols>${sheet.columns.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const mergesXml = sheet.merges.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`
    : "";
  const paneXml = sheet.freeze
    ? `<pane xSplit="${sheet.freeze.xSplit}" ySplit="${sheet.freeze.ySplit}" topLeftCell="${colLetter(sheet.freeze.xSplit + 1)}${sheet.freeze.ySplit + 1}" activePane="bottomRight" state="frozen"/><selection pane="bottomRight"/>`
    : "";
  const viewXml = `<sheetViews><sheetView workbookViewId="0">${paneXml}</sheetView></sheetViews>`;
  const autoFilterXml = sheet.autoFilter ? `<autoFilter ref="${sheet.autoFilter}"/>` : "";
  const dataValidationsXml = validations.length
    ? `<dataValidations count="${validations.length}">${validations
        .map((dv) => `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${dv.sqref}"><formula1>"${dv.list.join(",")}"</formula1></dataValidation>`)
        .join("")}</dataValidations>`
    : "";
  const headerFooterXml = `<headerFooter><oddHeader>${escapeXml(sheet.headerText ?? "")}</oddHeader><oddFooter>${escapeXml("第 &P 页，共 &N 页")}</oddFooter></headerFooter>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${colLetter(sheet.lastCol)}${sheet.lastRow}"/>
${viewXml}
<sheetFormatPr defaultRowHeight="15"/>
${colsXml}
<sheetData>${rowsXml}</sheetData>
${mergesXml}
${autoFilterXml}
${dataValidationsXml}
${headerFooterXml}
</worksheet>`;
}

export async function writeAssetWorkbook({
  filePath,
  title,
  domain,
  label,
  pairs,
  glossary,
  sourceColumnLabel,
  targetColumnLabel,
  sourceLanguage,
  targetLanguage,
}) {
  const sourceField = sourceLanguage.replace(/-/g, "_");
  const targetField = targetLanguage.replace(/-/g, "_");
  const reg = new StyleRegistry();
  const strings = new SharedStrings();

  const guide = buildGuideSheet(reg, strings, {
    title: `《${title}》${label}对齐与术语资产`,
    rows: [
      ["对齐规模", `${pairs.length} 组双语句段。`],
      ["术语规模", `${glossary.length} 条术语。`],
      ["语言方向", `${sourceLanguage} → ${targetLanguage}。`],
      ["对齐原则", "按原始文件中的非空段落一对一对齐，不拆分、不合并、不改写。"],
      ["使用建议", "筛选“主题”或原文检索翻译记忆；在术语库中维护个人术语表。"],
      ["交换文件", `TMX、TBX、JSONL 位于“03_翻译记忆与术语交换文件”。`],
    ],
  });
  const aligned = buildAlignedSheet(reg, strings, {
    title: `双语句段对齐（${pairs.length} 组）`,
    pairs,
    sourceColumnLabel,
    targetColumnLabel,
    sourceLanguage,
    targetLanguage,
  });
  const terms = buildTermsSheet(reg, strings, {
    title: `个人知识库：${domain || "通用"}${sourceColumnLabel}—${targetColumnLabel}（${glossary.length} 条）`,
    glossary,
    sourceColumnLabel,
    targetColumnLabel,
    sourceField,
    targetField,
  });

  const sheets = [guide, aligned, terms];
  const headerText = `《${title}》双语资产`;
  for (const s of sheets) s.headerText = headerText;

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`
  );
  const sheetRelCount = sheets.length;
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${sheetRelCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId${sheetRelCount + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
  );

  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s, strings)));
  zip.file("xl/styles.xml", reg.toXml());
  zip.file("xl/sharedStrings.xml", strings.toXml());

  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const fs = await import("node:fs");
  fs.writeFileSync(filePath, buffer);
}

export async function readAssetWorkbook(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

  const workbookXmlText = await zip.file("xl/workbook.xml").async("string");
  const wb = parser.parse(workbookXmlText);
  const sheetsNode = wb.workbook.sheets.sheet;
  const sheetList = Array.isArray(sheetsNode) ? sheetsNode : [sheetsNode];

  const relsText = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const rels = parser.parse(relsText);
  const relNode = rels.Relationships.Relationship;
  const relList = Array.isArray(relNode) ? relNode : [relNode];
  const targetFor = (rId) => relList.find((r) => r["@_Id"] === rId)["@_Target"];

  let sharedStrings = [];
  const sstFile = zip.file("xl/sharedStrings.xml");
  if (sstFile) {
    const sstText = await sstFile.async("string");
    const sst = parser.parse(sstText);
    const siNode = sst.sst?.si ?? [];
    const siList = Array.isArray(siNode) ? siNode : [siNode];
    sharedStrings = siList.map((si) => {
      if (si.t !== undefined) return typeof si.t === "string" ? si.t : String(si.t?.["#text"] ?? "");
      const runs = Array.isArray(si.r) ? si.r : [si.r];
      return runs.map((r) => r?.t ?? "").join("");
    });
  }

  const sheetNames = sheetList.map((s) => s["@_name"]);
  const sheets = {};
  for (const s of sheetList) {
    const target = targetFor(s["@_r:id"]);
    const sheetPath = `xl/${target}`;
    const sheetText = await zip.file(sheetPath).async("string");
    const parsed = parser.parse(sheetText);
    const ws = parsed.worksheet;

    const rowNode = ws.sheetData?.row ?? [];
    const rowList = Array.isArray(rowNode) ? rowNode : [rowNode];
    const grid = [];
    for (const row of rowList) {
      const rowNum = Number(row["@_r"]);
      const cellNode = row.c ?? [];
      const cellList = Array.isArray(cellNode) ? cellNode : [cellNode];
      const values = [];
      for (const cell of cellList) {
        if (cell["@_r"] === undefined) continue;
        const match = cell["@_r"].match(/^([A-Z]+)(\d+)$/);
        let col = 0;
        for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
        const type = cell["@_t"];
        let value = "";
        if (type === "s") value = sharedStrings[Number(cell.v)] ?? "";
        else if (cell.v !== undefined) value = String(cell.v);
        values[col - 1] = value;
      }
      grid[rowNum - 1] = values;
    }
    const rowCount = grid.length;
    let width = 0;
    for (let i = 0; i < rowCount; i += 1) width = Math.max(width, grid[i]?.length ?? 0);
    const filled = [];
    for (let i = 0; i < rowCount; i += 1) {
      const r = grid[i];
      filled.push(Array.from({ length: width }, (_, j) => r?.[j] ?? ""));
    }

    const autoFilter = ws.autoFilter ? ws.autoFilter["@_ref"] : null;
    const paneNode = ws.sheetViews?.sheetView?.pane;
    const freeze = paneNode
      ? { xSplit: Number(paneNode["@_xSplit"] ?? 0), ySplit: Number(paneNode["@_ySplit"] ?? 0), state: paneNode["@_state"] }
      : null;

    sheets[s["@_name"]] = { rows: filled, rowCount: filled.length, autoFilter, freeze };
  }

  return { sheetNames, sheets };
}
