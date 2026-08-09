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

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

function workbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
</styleSheet>`;

function sharedStringsXml(strings) {
  const items = strings.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
}

function dataValidationsXml(dataValidations) {
  if (!dataValidations || dataValidations.length === 0) return "";
  const items = dataValidations
    .map(
      (dv) =>
        `<dataValidation type="list" errorStyle="${dv.errorStyle || "stop"}" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${dv.sqref}"><formula1>"${dv.list.join(",")}"</formula1></dataValidation>`
    )
    .join("");
  return `<dataValidations count="${dataValidations.length}">${items}</dataValidations>`;
}

function sheetXml(headers, rows, dataValidations) {
  const colCount = headers.length;
  const lastCol = colLetter(colCount);
  const lastRow = rows.length + 1;
  const strIndex = new Map();
  const shared = [];
  const idOf = (s) => {
    if (!strIndex.has(s)) {
      strIndex.set(s, shared.length);
      shared.push(s);
    }
    return strIndex.get(s);
  };

  const headerCells = headers
    .map((h, i) => `<c r="${colLetter(i + 1)}1" s="2" t="s"><v>${idOf(h)}</v></c>`)
    .join("");
  const dataRows = rows
    .map((row, r) => {
      const cells = headers
        .map((_, i) => {
          const v = row[i] ?? "";
          return `<c r="${colLetter(i + 1)}${r + 2}" s="1" t="s"><v>${idOf(String(v))}</v></c>`;
        })
        .join("");
      return `<row r="${r + 2}">${cells}</row>`;
    })
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<sheetData><row r="1">${headerCells}</row>${dataRows}</sheetData>
<autoFilter ref="A1:${lastCol}${lastRow}"/>
${dataValidationsXml(dataValidations)}
</worksheet>`;

  return { xml, shared };
}

export async function writeSimpleWorkbook({ sheetName, headers, rows, dataValidations }) {
  const { xml: sheet1, shared } = sheetXml(headers, rows, dataValidations);
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("xl/workbook.xml", workbookXml(sheetName));
  zip.file("xl/_rels/workbook.xml.rels", WORKBOOK_RELS);
  zip.file("xl/styles.xml", STYLES_XML);
  zip.file("xl/sharedStrings.xml", sharedStringsXml(shared));
  zip.file("xl/worksheets/sheet1.xml", sheet1);
  return zip.generateAsync({ type: "nodebuffer" });
}

function colFromRef(ref) {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

export async function readSimpleWorkbook(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

  const workbookXmlText = await zip.file("xl/workbook.xml").async("string");
  const wb = parser.parse(workbookXmlText);
  const sheetsNode = wb.workbook.sheets.sheet;
  const firstSheet = Array.isArray(sheetsNode) ? sheetsNode[0] : sheetsNode;
  const rId = firstSheet["@_r:id"];

  const relsText = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const rels = parser.parse(relsText);
  const relNode = rels.Relationships.Relationship;
  const relList = Array.isArray(relNode) ? relNode : [relNode];
  const target = relList.find((r) => r["@_Id"] === rId)["@_Target"];
  const sheetPath = `xl/${target}`;

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

  const sheetText = await zip.file(sheetPath).async("string");
  const sheet = parser.parse(sheetText);
  const rowNode = sheet.worksheet.sheetData?.row ?? [];
  const rowList = Array.isArray(rowNode) ? rowNode : [rowNode];

  const grid = [];
  for (const row of rowList) {
    const rowNum = Number(row["@_r"]);
    const cellNode = row.c ?? [];
    const cellList = Array.isArray(cellNode) ? cellNode : [cellNode];
    const values = [];
    for (const cell of cellList) {
      if (cell["@_r"] === undefined) continue;
      const { col } = colFromRef(cell["@_r"]);
      const type = cell["@_t"];
      let value = "";
      if (type === "s") {
        value = sharedStrings[Number(cell.v)] ?? "";
      } else if (type === "inlineStr") {
        value = cell.is?.t ?? "";
      } else {
        value = cell.v !== undefined ? String(cell.v) : "";
      }
      values[col - 1] = value;
    }
    grid[rowNum - 1] = values;
  }

  const width = grid.reduce((m, r) => Math.max(m, r?.length ?? 0), 0);
  const filled = grid.map((r) => Array.from({ length: width }, (_, i) => r?.[i] ?? ""));
  const [headers, ...rows] = filled;
  const populated = rows
    .map((row, index) => ({ row, rowNumber: index + 2 }))
    .filter((item) => item.row.some((value) => value !== ""));
  return {
    headers: headers ?? [],
    rows: populated.map((item) => item.row),
    rowNumbers: populated.map((item) => item.rowNumber),
  };
}
