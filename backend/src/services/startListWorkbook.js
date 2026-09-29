const crypto = require("node:crypto");
const path = require("node:path");
const { inflateRawSync } = require("node:zlib");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");

const START_LIST_LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxZipEntries: 4096,
  maxSheets: 32,
  maxRowsPerSheet: 10000,
  maxRows: 10000,
  maxColumns: 80,
  maxCells: 500000,
  maxCellCharacters: 4096,
  maxSourceBytes: 5 * 1024 * 1024,
});

class StartListAnalysisError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StartListAnalysisError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StartListAnalysisError(code, message);
}

function spreadsheetKind(filename = "", mimeType = "") {
  const extension = path.extname(String(filename).toLowerCase());
  if ([".xlsx", ".xls", ".csv"].includes(extension)) return extension.slice(1);
  if (extension) return null;
  const mime = String(mimeType).toLowerCase().split(";")[0];
  if (mime === "text/csv" || mime === "application/csv") return "csv";
  if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (mime === "application/vnd.ms-excel") return "xls";
  return null;
}

// Inspect the ZIP directory before SheetJS expands an XLSX. Do not trust the
// compressed upload size alone, and reject formats requiring ZIP64 handling.
function checkXlsxArchive(buffer) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    fail("invalid_xlsx", "El archivo no es un libro XLSX válido.");
  }
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) fail("invalid_xlsx", "No se pudo leer la estructura del libro XLSX.");
  const entries = buffer.readUInt16LE(end + 10);
  const directoryBytes = buffer.readUInt32LE(end + 12);
  const directoryStart = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || entries === 0xffff || directoryStart === 0xffffffff) {
    fail("unsupported_xlsx", "Este tipo de archivo XLSX no está admitido.");
  }
  if (entries > START_LIST_LIMITS.maxZipEntries || directoryStart + directoryBytes > end) {
    fail("workbook_too_large", "El libro tiene demasiados elementos internos.");
  }
  let offset = directoryStart;
  let expandedBytes = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) {
      fail("invalid_xlsx", "El índice del archivo XLSX está incompleto.");
    }
    if (buffer.readUInt16LE(offset + 8) & 1) {
      fail("encrypted_workbook", "Guarda una copia del libro sin contraseña para analizarla.");
    }
    const expanded = buffer.readUInt32LE(offset + 24);
    const compressed = buffer.readUInt32LE(offset + 20);
    const method = buffer.readUInt16LE(offset + 10);
    const localOffset = buffer.readUInt32LE(offset + 42);
    expandedBytes += expanded;
    if (expanded === 0xffffffff || expandedBytes > START_LIST_LIMITS.maxExpandedBytes) {
      fail("workbook_too_large", "El contenido del libro supera el límite de análisis.");
    }
    if (localOffset + 30 > directoryStart || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      fail("invalid_xlsx", "Una entrada del libro XLSX no es válida.");
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    if (buffer.readUInt16LE(localOffset + 8) !== method || localFlags !== buffer.readUInt16LE(offset + 8)
      || (!(localFlags & 8) && (buffer.readUInt32LE(localOffset + 18) !== compressed || buffer.readUInt32LE(localOffset + 22) !== expanded))) {
      fail("invalid_xlsx", "Los tamaños o métodos de compresión del libro XLSX no coinciden.");
    }
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (dataStart + compressed > directoryStart || ![0, 8].includes(method)) {
      fail("invalid_xlsx", "La compresión del archivo XLSX no está admitida.");
    }
    // Directory sizes are untrusted too. Verify the actual expansion with a
    // bounded inflater before handing the archive to the workbook reader.
    try {
      const entryBytes = buffer.subarray(dataStart, dataStart + compressed);
      const decoded = method === 0 ? entryBytes : inflateRawSync(entryBytes, { maxOutputLength: Math.max(1, expanded) });
      if (decoded.length !== expanded) fail("invalid_xlsx", "El tamaño de una entrada del libro no coincide.");
    } catch {
      fail("invalid_xlsx", "Una entrada del libro XLSX supera su tamaño declarado o está dañada.");
    }
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    if (offset > directoryStart + directoryBytes) fail("invalid_xlsx", "El índice del libro XLSX no es válido.");
  }
  if (offset !== directoryStart + directoryBytes) fail("invalid_xlsx", "El índice del libro XLSX no coincide con su contenido.");
}

function columnName(column) {
  let result = "";
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  }
  return result;
}

function decodeCellAddress(address) {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(String(address));
  if (!match) return null;
  return {
    row: Number(match[2]),
    column: [...match[1]].reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0),
  };
}

function sourceCellText(cell) {
  if (cell == null) return "";
  if (cell.text != null) return String(cell.text);
  return cell.value == null ? "" : String(cell.value);
}

function parseStartListWorkbook({ buffer, filename, mimeType }) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    fail("missing_file", "Selecciona un archivo Excel o CSV.");
  }
  const bytes = Buffer.from(buffer);
  if (!bytes.length) fail("empty_file", "El archivo está vacío.");
  if (bytes.length > START_LIST_LIMITS.maxFileBytes) fail("file_too_large", "El archivo supera el límite de 10 MB.");
  const kind = spreadsheetKind(filename, mimeType);
  if (!kind) fail("unsupported_file", "Se admiten archivos XLSX, XLS y CSV.");
  if (kind === "xlsx") checkXlsxArchive(bytes);
  if (kind === "xls" && !bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) {
    fail("invalid_xls", "El archivo no es un libro XLS válido. Guárdalo como XLSX o CSV.");
  }
  const XLSX = require("xlsx");
  let book;
  try {
    let input = bytes;
    if (kind === "csv") {
      if (bytes[0] === 0xff && bytes[1] === 0xfe) input = new TextDecoder("utf-16le").decode(bytes);
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) input = new TextDecoder("utf-16be").decode(bytes);
      else {
        try { input = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { input = new TextDecoder("windows-1252").decode(bytes); }
      }
    }
    book = XLSX.read(input, {
      type: kind === "csv" ? "string" : "buffer",
      raw: kind === "csv",
      cellDates: false,
      cellNF: true,
      cellText: true,
      cellFormula: true,
      sheetRows: START_LIST_LIMITS.maxRowsPerSheet + 1,
      dense: false,
      WTF: false,
    });
  } catch {
    fail("unreadable_file", "No se pudo leer el archivo. Comprueba que no tenga contraseña y guárdalo como XLSX o CSV.");
  }
  if (book.SheetNames.length > START_LIST_LIMITS.maxSheets) fail("too_many_sheets", "El libro supera el límite de 32 hojas.");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const date1904 = Boolean(book.Workbook?.WBProps?.date1904);
  const sourceRows = [];
  let cellsTotal = 0;
  const sheets = book.SheetNames.map((name, sheetIndex) => {
    const sheet = book.Sheets[name];
    const reference = sheet["!fullref"] || sheet["!ref"];
    const range = reference ? XLSX.utils.decode_range(reference) : null;
    if (range && (range.e.r >= START_LIST_LIMITS.maxRowsPerSheet || range.e.c >= START_LIST_LIMITS.maxColumns)) {
      fail("sheet_too_large", `La hoja ${name} supera el límite de ${START_LIST_LIMITS.maxRowsPerSheet} filas o ${START_LIST_LIMITS.maxColumns} columnas.`);
    }
    const rows = new Map();
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith("!")) continue;
      const coordinates = decodeCellAddress(address);
      if (!coordinates || (!cell.f && (cell.v == null || String(cell.v).trim() === ""))) continue;
      if (coordinates.row > START_LIST_LIMITS.maxRowsPerSheet || coordinates.column > START_LIST_LIMITS.maxColumns) {
        fail("sheet_too_large", `La hoja ${name} contiene celdas fuera de los límites admitidos.`);
      }
      if (++cellsTotal > START_LIST_LIMITS.maxCells) fail("too_many_cells", "El archivo contiene más de 500 000 celdas con datos.");
      const value = cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : cell.v ?? "";
      const text = cell.w != null ? String(cell.w) : String(value);
      if (text.length > START_LIST_LIMITS.maxCellCharacters || String(value).length > START_LIST_LIMITS.maxCellCharacters) {
        fail("cell_too_large", `La celda ${name}!${address} supera el límite de texto admitido.`);
      }
      const normalizedCell = {
        address,
        column: coordinates.column,
        ...(typeof value === "number" || String(value) !== text ? { value } : {}),
        text,
        type: cell.t || typeof value,
        ...(cell.z && XLSX.SSF.is_date(cell.z) ? { isDate: true } : {}),
        ...(cell.f ? { formula: true } : {}),
        ...(cell.f && cell.v == null ? { missingFormulaResult: true } : {}),
        ...(typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) ? { unsafeNumber: true } : {}),
      };
      if (!rows.has(coordinates.row)) rows.set(coordinates.row, []);
      rows.get(coordinates.row).push(normalizedCell);
    }
    const sheetRows = [...rows.entries()].sort(([left], [right]) => left - right).map(([row, cells]) => ({
      id: `${sha256}:s${sheetIndex + 1}:r${row}`,
      sheetIndex,
      sheetName: name,
      row,
      hidden: Boolean(sheet["!rows"]?.[row - 1]?.hidden),
      cells: cells.sort((left, right) => left.column - right.column),
    }));
    sourceRows.push(...sheetRows);
    if (sourceRows.length > START_LIST_LIMITS.maxRows) fail("too_many_rows", "El archivo contiene más de 10 000 filas con datos.");
    return {
      index: sheetIndex,
      name,
      hidden: Boolean(book.Workbook?.Sheets?.[sheetIndex]?.Hidden),
      rowCount: sheetRows.length,
      firstRow: sheetRows[0]?.row || null,
      lastRow: sheetRows.at(-1)?.row || null,
      columnCount: sheetRows.reduce((maximum, row) => Math.max(maximum, row.cells.at(-1)?.column || 0), 0),
      merges: (sheet["!merges"] || []).map((merge) => XLSX.utils.encode_range(merge)),
    };
  });
  if (!sourceRows.length) fail("empty_workbook", "No se encontraron celdas con datos en el archivo.");
  return {
    file: { sha256, name: path.basename(String(filename || `start-list.${kind}`)), bytes: bytes.length, kind },
    workbook: { sheets, rowCount: sourceRows.length, cellCount: cellsTotal, date1904 },
    sourceRows,
  };
}

function parseStartListWorkbookAsync(input, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { startListWorkbook: true, input },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
    let completed = false;
    const finish = (error, result) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new StartListAnalysisError("parse_timeout", "El archivo tardó demasiado en leerse. Divide el libro o guárdalo como CSV.")), timeoutMs);
    worker.once("message", (message) => {
      if (message.error) finish(new StartListAnalysisError(message.error.code || "unreadable_file", message.error.message));
      else finish(null, message.result);
    });
    worker.once("error", () => finish(new StartListAnalysisError("parse_failed", "No se pudo leer el archivo dentro de los límites disponibles.")));
    worker.once("exit", (code) => {
      if (!completed) finish(new StartListAnalysisError("parse_failed", `No se pudo completar la lectura del archivo (${code}).`));
    });
  });
}

if (!isMainThread && workerData?.startListWorkbook) {
  try { parentPort.postMessage({ result: parseStartListWorkbook(workerData.input) }); }
  catch (error) { parentPort.postMessage({ error: { code: error.code || "unreadable_file", message: error.message } }); }
}

module.exports = {
  START_LIST_LIMITS,
  StartListAnalysisError,
  spreadsheetKind,
  parseStartListWorkbook,
  parseStartListWorkbookAsync,
  sourceCellText,
  columnName,
  decodeCellAddress,
};
