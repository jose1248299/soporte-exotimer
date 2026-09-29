const crypto = require("node:crypto");
const {
  parseStartListWorkbookAsync, StartListAnalysisError, START_LIST_LIMITS,
  sourceCellText, columnName,
} = require("./startListWorkbook");
const {
  START_LIST_FIELDS, normalizeLabel, headerFields, isHeaderRow,
  inferStartListPlan, validateStartListPlan, buildStartListAnalysisContext,
} = require("./startListPlan");

const FIELD_LABELS = {
  firstName: "Nombres", lastName: "Apellidos", fullName: "Nombre completo", document: "Documento",
  email: "Correo", phone: "Teléfono", birthDate: "Fecha de nacimiento", gender: "Género",
  category: "Categoría", distance: "Distancia", start: "Salida", club: "Club", dorsal: "Dorsal", chip: "Chip",
};

function makeQuestionId(type, scope, value) {
  return `${type}:${crypto.createHash("sha256").update(JSON.stringify([scope, value])).digest("hex").slice(0, 24)}`;
}

function decisionValue(decisions, id) {
  const supplied = Array.isArray(decisions)
    ? decisions.find((item) => item.questionId === id || item.id === id)?.optionId
    : decisions?.[id];
  return typeof supplied === "object" && supplied != null ? supplied.optionId : supplied;
}

function normalizeGender(value) {
  const gender = normalizeLabel(value);
  if (["m", "masculino", "masculina", "male", "hombre", "hombres", "varon", "varones", "h"].includes(gender)) return "M";
  if (["f", "femenino", "femenina", "female", "mujer", "mujeres", "dama", "damas"].includes(gender)) return "F";
  return null;
}

function normalizeBirthDate(value, { date1904 = false, now = new Date() } = {}) {
  if (value == null || String(value).trim() === "") return null;
  let year, month, day;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) return null;
    const parsed = require("xlsx").SSF.parse_date_code(value, { date1904 });
    if (!parsed) return null;
    ({ y: year, m: month, d: day } = parsed);
  } else {
    const input = String(value).trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
    const local = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(input);
    if (iso) [, year, month, day] = iso.map(Number);
    else if (local) [, day, month, year] = local.map(Number);
    else return null;
  }
  if (year < 1900 || year > now.getUTCFullYear() || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  const result = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return result <= now.toISOString().slice(0, 10) ? result : null;
}

function distanceKey(value) {
  const normalized = normalizeLabel(value);
  const raw = String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const onlyDistance = /^(\d+(?:[.,]\d+)?)\s*(km|k|kilometros?|m|metros?)$/.exec(raw);
  if (!onlyDistance) return normalized;
  const meters = Number(onlyDistance[1].replace(",", ".")) * (/^(m|metros?)$/.test(onlyDistance[2]) ? 1 : 1000);
  return `meters:${meters}`;
}

function approximateScore(label, source) {
  const left = normalizeLabel(label);
  const right = normalizeLabel(source);
  if (!right) return 0;
  if (left === right || distanceKey(left) === distanceKey(right)) return 100;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const common = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const distanceLeft = left.match(/\d+(?:[.,]\d+)?\s*(?:k|km)\b/)?.[0];
  const distanceRight = right.match(/\d+(?:[.,]\d+)?\s*(?:k|km)\b/)?.[0];
  return Math.min(95, Math.round(50 * common / Math.max(1, union)) + (distanceLeft && distanceRight && distanceKey(distanceLeft) === distanceKey(distanceRight) ? 40 : 0));
}

function validateCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.events)) throw new StartListAnalysisError("invalid_catalog", "No se pudo cargar el catálogo de la competencia.");
  const ids = new Set();
  for (const event of catalog.events) {
    if (!Number.isSafeInteger(Number(event.id)) || Number(event.id) < 1 || !String(event.name || "").trim() || ids.has(String(event.id))) {
      throw new StartListAnalysisError("invalid_catalog", "El catálogo contiene distancias sin identificador válido o repetidas.");
    }
    ids.add(String(event.id));
    const categoryIds = new Set();
    for (const category of event.categories || []) {
      if (!Number.isSafeInteger(Number(category.id)) || Number(category.id) < 1 || !String(category.name || "").trim() || categoryIds.has(String(category.id))) {
        throw new StartListAnalysisError("invalid_catalog", "El catálogo contiene categorías sin identificador válido o repetidas.");
      }
      categoryIds.add(String(category.id));
    }
    const startIds = new Set();
    for (const start of event.starts || []) {
      if (start.id == null || !String(start.id).trim() || !String(start.name || "").trim() || startIds.has(String(start.id))) {
        throw new StartListAnalysisError("invalid_catalog", "El catálogo contiene salidas sin identificador válido o repetidas.");
      }
      startIds.add(String(start.id));
    }
  }
  return catalog;
}

function checkSourceWorkbook(parsed) {
  if (!parsed?.file?.sha256 || !/^[a-f0-9]{64}$/.test(parsed.file.sha256) || !Array.isArray(parsed.sourceRows) || !Array.isArray(parsed.workbook?.sheets)) {
    throw new StartListAnalysisError("invalid_source_workbook", "El archivo guardado no tiene una estructura válida.");
  }
  if (parsed.sourceRows.length > START_LIST_LIMITS.maxRows || parsed.workbook.sheets.length > START_LIST_LIMITS.maxSheets) {
    throw new StartListAnalysisError("workbook_too_large", "El archivo guardado supera los límites de análisis.");
  }
  const unique = new Set();
  let cells = 0;
  for (const row of parsed.sourceRows) {
    const sheet = parsed.workbook.sheets[row.sheetIndex];
    if (!sheet || !Number.isInteger(row.row) || row.row < 1 || row.row > START_LIST_LIMITS.maxRowsPerSheet || !Array.isArray(row.cells) || row.cells.length > START_LIST_LIMITS.maxColumns) {
      throw new StartListAnalysisError("invalid_source_row", "Una fila guardada no pertenece al archivo.");
    }
    const expectedId = `${parsed.file.sha256}:s${row.sheetIndex + 1}:r${row.row}`;
    if (row.id !== expectedId || unique.has(row.id)) throw new StartListAnalysisError("invalid_source_row", "Las referencias de fila guardadas son inválidas o están repetidas.");
    unique.add(row.id);
    const columns = new Set();
    for (const cell of row.cells) {
      if (!Number.isInteger(cell.column) || cell.column < 1 || cell.column > START_LIST_LIMITS.maxColumns || columns.has(cell.column) || cell.address !== `${columnName(cell.column)}${row.row}` || sourceCellText(cell).length > START_LIST_LIMITS.maxCellCharacters) {
        throw new StartListAnalysisError("invalid_source_cell", "Una referencia de celda guardada no es válida.");
      }
      columns.add(cell.column);
      if (++cells > START_LIST_LIMITS.maxCells) throw new StartListAnalysisError("too_many_cells", "El archivo guardado tiene demasiadas celdas.");
    }
  }
  if (Buffer.byteLength(JSON.stringify(parsed)) > START_LIST_LIMITS.maxSourceBytes) {
    throw new StartListAnalysisError("source_too_large", "La tabla supera el límite de 5 MB de datos. Divide el listado en archivos más pequeños.");
  }
  return parsed;
}

function isSafeTotalRow(row, fields) {
  const nonempty = row.cells.filter((cell) => sourceCellText(cell).trim());
  if (!nonempty.length || !/^(total(?:es)?|subtotal|cantidad(?: de participantes)?|total (?:de )?(?:participantes|inscritos))\s*:?$/i.test(sourceCellText(nonempty[0]).trim())) return false;
  const identityColumns = new Set(fields.filter((item) => ["document", "email", "birthDate", "phone"].includes(item.field)).map((item) => item.column));
  return nonempty.slice(1).every((cell) => !identityColumns.has(cell.column) && /^\d+(?:[.,]\d+)?$/.test(sourceCellText(cell).trim()));
}

function buildAnalysis(parsed, catalog, proposedPlan, decisions = {}, analysisIssues = []) {
  checkSourceWorkbook(parsed);
  validateCatalog(catalog);
  const plan = validateStartListPlan(proposedPlan || inferStartListPlan(parsed), parsed);
  const questions = new Map();
  const globalIssues = [...analysisIssues];
  const rowLookup = new Map(parsed.sourceRows.map((row) => [`${row.sheetIndex}:${row.row}`, row]));
  const consumed = new Set();
  const excludedRows = [];
  const candidates = [];

  function question(type, scope, sourceValue, rowIds, options, { required = true, selected = null, field = null, title = null } = {}) {
    const id = makeQuestionId(type, scope, normalizeLabel(sourceValue));
    const requested = decisionValue(decisions, id);
    const answer = requested == null ? null : options.find((option) => option.id === String(requested));
    if (requested != null && !answer) {
      if (!globalIssues.some((issue) => issue.code === "invalid_decision" && issue.questionId === id)) {
        globalIssues.push({ code: "invalid_decision", severity: "error", questionId: id, message: "Una respuesta ya no coincide con las opciones vigentes. Revísala de nuevo." });
      }
      selected = null;
    }
    const selection = answer || (requested == null ? selected : null);
    if (!questions.has(id)) {
      questions.set(id, { id, type, field, title, sourceValue: String(sourceValue || ""), rowIds: [], options, required, resolved: Boolean(selection), selectedOptionId: selection?.id || null });
    }
    const result = questions.get(id);
    result.rowIds.push(...rowIds.filter((id) => !result.rowIds.includes(id)));
    result.required ||= required;
    return { selection, id };
  }

  function issue(candidate, code, message, extra = {}) {
    candidate.issues.push({ code, severity: "error", message, ...extra });
  }

  function rowReview(row, required = true) {
    return question("row", parsed.file.sha256, row.id, [row.id], [
      { id: "row:keep", label: "Conservar como participante y revisar columnas" },
      { id: "row:exclude", label: "Excluir esta fila del listado" },
    ], { required, title: `Revisar ${row.sheetName} · fila ${row.row}` });
  }

  // A row explicitly retained outside a guessed block gets its own editable
  // mapping. No inferred name/date is inserted to turn it into a participant.
  for (const row of parsed.sourceRows) {
    const inBlock = plan.blocks.some((block) => block.sheetIndex === row.sheetIndex && row.row >= block.firstRow && row.row <= block.lastRow);
    const rowQuestionId = makeQuestionId("row", parsed.file.sha256, normalizeLabel(row.id));
    if (!inBlock && decisionValue(decisions, rowQuestionId) === "row:keep") {
      plan.blocks.push({ sheetIndex: row.sheetIndex, headerRow: null, firstRow: row.row, lastRow: row.row, fields: [], excludeRows: [] });
    }
  }

  for (const block of plan.blocks) {
    const sheet = parsed.workbook.sheets[block.sheetIndex];
    const blockKey = `${block.sheetIndex}:${block.firstRow}:${block.lastRow}`;
    const rows = parsed.sourceRows.filter((row) => row.sheetIndex === block.sheetIndex && row.row >= block.firstRow && row.row <= block.lastRow);
    const header = block.headerRow ? rowLookup.get(`${block.sheetIndex}:${block.headerRow}`) : null;
    const keepHeader = header && decisionValue(decisions, makeQuestionId("row", parsed.file.sha256, normalizeLabel(header.id))) === "row:keep";
    if (header && !consumed.has(header.id) && !keepHeader) {
      // A provider cannot declare arbitrary participant data to be a header.
      if (isHeaderRow(header)) {
        consumed.add(header.id);
        excludedRows.push({ id: header.id, source: { sheetIndex: header.sheetIndex, sheetName: header.sheetName, row: header.row }, reason: "header", confirmed: true });
      }
    }
    const fields = new Map(block.fields.map((field) => [field.field, { ...field }]));
    for (const field of START_LIST_FIELDS) {
      const original = fields.get(field);
      const required = field === "fullName" && !fields.has("firstName") && !fields.has("fullName");
      const options = Array.from({ length: sheet.columnCount }, (_, index) => {
        const column = index + 1;
        const headerText = header?.cells.find((cell) => cell.column === column)?.text;
        return { id: `column:${column}`, label: `${columnName(column)}${headerText ? ` · ${headerText}` : ""}`, column };
      });
      options.unshift({ id: "unmapped", label: "Sin columna", column: null });
      if (original?.contextCell) options.push({ id: `cell:${original.contextCell}`, label: `Usar ${sheet.name}!${original.contextCell}`, contextCell: original.contextCell });
      if (["distance", "category", "start", "gender", "club"].includes(field)) options.push({ id: "sheet_name", label: `Usar nombre de hoja: ${sheet.name}`, fromSheetName: true });
      const defaultId = original?.column != null ? `column:${original.column}` : original?.contextCell ? `cell:${original.contextCell}` : original?.fromSheetName ? "sheet_name" : "unmapped";
      const selected = options.find((option) => option.id === defaultId);
      const result = question("column", [parsed.file.sha256, blockKey, field], field, [], options, { required, selected: required ? null : selected, field, title: `Columna para ${FIELD_LABELS[field]} · ${sheet.name}` });
      if (result.selection && result.selection.id !== "unmapped") fields.set(field, { field, column: result.selection.column || null, contextCell: result.selection.contextCell || null, fromSheetName: Boolean(result.selection.fromSheetName) });
      else fields.delete(field);
    }
    const mappings = [...fields.values()];
    for (const row of rows) {
      consumed.add(row.id);
      const rowQuestionId = makeQuestionId("row", parsed.file.sha256, normalizeLabel(row.id));
      if (decisionValue(decisions, rowQuestionId) === "row:exclude") {
        rowReview(row);
        excludedRows.push({ id: row.id, source: { sheetIndex: row.sheetIndex, sheetName: row.sheetName, row: row.row }, reason: "user_excluded", confirmed: true });
        continue;
      }
      const keepRow = decisionValue(decisions, rowQuestionId) === "row:keep";
      if (!keepRow && isHeaderRow(row)) {
        excludedRows.push({ id: row.id, source: { sheetIndex: row.sheetIndex, sheetName: row.sheetName, row: row.row }, reason: "repeated_header", confirmed: true });
        continue;
      }
      if (!keepRow && isSafeTotalRow(row, mappings)) {
        excludedRows.push({ id: row.id, source: { sheetIndex: row.sheetIndex, sheetName: row.sheetName, row: row.row }, reason: "total", confirmed: true });
        continue;
      }
      const requestedExclusion = block.excludeRows.find((item) => item.row === row.row);
      const candidate = {
        id: row.id,
        source: { sheetIndex: row.sheetIndex, sheetName: row.sheetName, row: row.row },
        values: {}, evidence: {}, eventId: null, categoryId: null, startId: null,
        categoryMode: null, policyVersion: null, suppliedCategoryName: null,
        needsServerClassification: false, status: "pending", issues: [],
      };
      if (requestedExclusion) {
        const review = rowReview(row);
        if (review.selection?.id !== "row:keep") issue(candidate, "unverified_exclusion", "La IA propuso excluir esta fila, pero no se pudo comprobar que sea una cabecera o un total. Revísala.", { questionId: review.id });
      }
      for (const mapping of mappings) {
        let cell;
        let sourceRow = row;
        if (mapping.contextCell) {
          const contextRow = Number(mapping.contextCell.match(/\d+$/)[0]);
          sourceRow = rowLookup.get(`${row.sheetIndex}:${contextRow}`);
          cell = sourceRow?.cells.find((cell) => cell.address === mapping.contextCell);
        } else if (mapping.column != null) cell = row.cells.find((cell) => cell.column === mapping.column);
        const original = mapping.fromSheetName ? sheet.name : sourceCellText(cell);
        candidate.values[mapping.field] = original.trim();
        candidate.evidence[mapping.field] = { sheetIndex: row.sheetIndex, row: mapping.fromSheetName ? null : sourceRow?.row || row.row, cell: mapping.fromSheetName ? null : cell?.address || `${columnName(mapping.column)}${row.row}`, original, kind: mapping.fromSheetName ? "sheet_name" : mapping.contextCell ? "context_cell" : "cell" };
        if (cell?.missingFormulaResult) issue(candidate, "missing_formula_result", `La celda ${cell.address} contiene una fórmula sin resultado guardado. Abre y guarda el Excel antes de importarlo.`, { field: mapping.field });
        if (cell?.unsafeNumber && ["document", "dorsal", "chip", "phone"].includes(mapping.field)) issue(candidate, "unsafe_numeric_identifier", `La celda ${cell.address} puede haber perdido dígitos en Excel. Corrige ese identificador como texto.`, { field: mapping.field });
        if (mapping.field === "birthDate" && original.trim()) {
          const birthDate = normalizeBirthDate(typeof cell?.value === "number" ? cell.value : original, { date1904: parsed.workbook.date1904 });
          candidate.values.birthDate = birthDate;
          if (!birthDate) issue(candidate, "invalid_birth_date", "La fecha de nacimiento no es válida. Usa una fecha completa, sin sustituirla por la edad.", { field: "birthDate" });
        }
      }
      if (!candidate.values.firstName && !candidate.values.fullName) issue(candidate, "missing_name", "No se identificó el nombre del participante.", { field: "fullName" });
      if (candidate.values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate.values.email)) issue(candidate, "invalid_email", "El correo no tiene un formato válido.", { field: "email" });
      if (candidate.values.dorsal && !/^\d+$/.test(candidate.values.dorsal)) issue(candidate, "invalid_dorsal", "El dorsal debe contener solo números.", { field: "dorsal" });

      const distanceValue = candidate.values.distance || "";
      const eventOptions = [...catalog.events].sort((left, right) => approximateScore(right.name, distanceValue) - approximateScore(left.name, distanceValue) || Number(left.id) - Number(right.id))
        .map((event) => ({ id: `event:${event.id}`, label: event.name, eventId: Number(event.id) }));
      let exactEvents = distanceValue ? catalog.events.filter((event) => distanceKey(event.name) === distanceKey(distanceValue)) : [];
      if (!distanceValue && catalog.events.length === 1) exactEvents = catalog.events;
      // A recognized sheet label is evidence for distance when no data column exists.
      if (!distanceValue && exactEvents.length !== 1) exactEvents = catalog.events.filter((event) => distanceKey(event.name) === distanceKey(sheet.name));
      const eventQuestion = question("distance", catalog.competitionId, distanceValue || `Hoja ${sheet.name}`, [row.id], eventOptions, { selected: exactEvents.length === 1 ? eventOptions.find((option) => option.eventId === Number(exactEvents[0].id)) : null, title: "¿A qué distancia pertenece este grupo?" });
      const event = catalog.events.find((item) => Number(item.id) === eventQuestion.selection?.eventId);
      if (!event) issue(candidate, catalog.events.length ? "unresolved_distance" : "no_configured_distances", catalog.events.length ? "Selecciona una distancia existente para este grupo." : "La competencia no tiene distancias configuradas. Configúralas antes de importar.", { questionId: eventQuestion.id });
      else {
        candidate.eventId = Number(event.id);
        candidate.values.distance = event.name;
        candidate.categoryMode = event.categoryMode;
        candidate.policyVersion = event.policyVersion ?? null;
        if (!["basic", "detailed"].includes(event.categoryMode)) issue(candidate, "missing_category_policy", "No se pudo comprobar el modo de categorías de esta distancia.");
        if (event.closed || event.pendingOperation || event.pendingOperationId) issue(candidate, "category_policy_unavailable", "La configuración de categorías está cerrada o tiene una operación pendiente.");
      }

      const genderValue = candidate.values.gender || "";
      const canonicalGender = normalizeGender(genderValue);
      const genderOptions = [{ id: "gender:M", label: "Masculino", gender: "M" }, { id: "gender:F", label: "Femenino", gender: "F" }];
      const genderQuestion = question("gender", catalog.competitionId, genderValue, [row.id], genderOptions, { selected: genderOptions.find((option) => option.gender === canonicalGender), title: "¿Qué género corresponde a este valor?" });
      candidate.values.gender = genderQuestion.selection?.gender || null;
      if (!candidate.values.gender) issue(candidate, "unresolved_gender", "Selecciona el género indicado por el listado; no se deduce del nombre.", { questionId: genderQuestion.id });

      if (event) {
        const categoryValue = candidate.values.category || "";
        const categories = (event.categories || []).filter((category) => !normalizeGender(category.gender) || !candidate.values.gender || normalizeGender(category.gender) === candidate.values.gender);
        const categoryOptions = [...categories].sort((left, right) => approximateScore(right.name, categoryValue) - approximateScore(left.name, categoryValue) || Number(left.id) - Number(right.id))
          .map((category) => ({ id: `category:${category.id}`, label: `${category.name}${category.gender ? ` · ${category.gender}` : ""}`, categoryId: Number(category.id), categoryName: category.name }));
        let exactCategories = categories.filter((category) => normalizeLabel(category.name) === normalizeLabel(categoryValue));
        if (!categoryValue && event.categoryMode === "basic" && categories.length === 1) exactCategories = categories;
        const requiresCategory = event.categoryMode === "basic" || Boolean(categoryValue);
        if (requiresCategory) {
          const selected = exactCategories.length === 1 ? categoryOptions.find((option) => option.categoryId === Number(exactCategories[0].id)) : null;
          const categoryQuestion = question("category", [event.id, candidate.values.gender], categoryValue, [row.id], categoryOptions, { selected, title: "¿Qué categoría corresponde al valor del listado?" });
          if (!categoryQuestion.selection) issue(candidate, "unresolved_category", "Selecciona una categoría existente para este grupo.", { questionId: categoryQuestion.id });
          else {
            candidate.values.category = categoryQuestion.selection.categoryName;
            candidate.suppliedCategoryName = categoryQuestion.selection.categoryName;
            if (event.categoryMode === "basic") candidate.categoryId = categoryQuestion.selection.categoryId;
          }
        }
        if (event.categoryMode === "detailed") {
          candidate.needsServerClassification = true;
          if (!candidate.values.birthDate) issue(candidate, "missing_birth_date", "Esta distancia calcula categorías por fecha de nacimiento; falta una fecha válida.", { field: "birthDate" });
          // Age, category and cutoff are always validated by the authoritative
          // category service. A spreadsheet label is only a supplied claim.
        }

        const startValue = candidate.values.start || "";
        const starts = event.starts || [];
        const startOptions = [...starts].sort((left, right) => approximateScore(right.name, startValue) - approximateScore(left.name, startValue))
          .map((start) => ({ id: `start:${start.id}`, label: start.name, startId: start.id, startName: start.name }));
        let exactStarts = starts.filter((start) => normalizeLabel(start.name) === normalizeLabel(startValue));
        if (!startValue && starts.length === 1) exactStarts = starts;
        const startQuestion = question("start", event.id, startValue, [row.id], startOptions, { selected: exactStarts.length === 1 ? startOptions.find((option) => String(option.startId) === String(exactStarts[0].id)) : null, title: "¿Qué salida corresponde a este grupo?" });
        if (!startQuestion.selection) issue(candidate, "unresolved_start", starts.length ? "Selecciona una salida existente para este grupo." : "Esta distancia no tiene una salida configurada.", { questionId: startQuestion.id });
        else {
          candidate.startId = startQuestion.selection.startId;
          candidate.values.start = startQuestion.selection.startName;
        }
      }
      candidates.push(candidate);
    }
  }

  // No source row disappears because a model omitted a table, a title looked
  // unusual, or the guessed range ended early. Unclaimed rows remain visible.
  const unassignedRows = [];
  for (const row of parsed.sourceRows.filter((row) => !consumed.has(row.id))) {
    const review = rowReview(row);
    if (review.selection?.id === "row:exclude") {
      excludedRows.push({ id: row.id, source: { sheetIndex: row.sheetIndex, sheetName: row.sheetName, row: row.row }, reason: "user_excluded", confirmed: true });
    } else unassignedRows.push({
      id: row.id, source: { sheetIndex: row.sheetIndex, sheetName: row.sheetName, row: row.row },
      reason: "unassigned_source_row", message: "Esta fila no fue incluida en una tabla de participantes. Revísala antes de excluirla.", questionId: review.id,
    });
  }

  // Exact duplicates are a review conflict, never silently dropped or merged.
  for (const field of ["dorsal", "chip", "document", "email"]) {
    const index = new Map();
    for (const candidate of candidates) {
      const value = candidate.values[field];
      if (!value) continue;
      const normalized = field === "email" ? value.trim().toLowerCase() : field === "dorsal" ? value.replace(/^0+(?=\d)/, "") : value.trim();
      const scope = ["dorsal", "chip"].includes(field) ? "competition" : candidate.eventId || "unknown";
      const key = `${scope}:${normalized}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(candidate);
    }
    for (const group of index.values()) {
      if (group.length < 2) continue;
      for (const candidate of group) issue(candidate, "duplicate_in_file", `El ${FIELD_LABELS[field].toLowerCase()} se repite en el archivo. Revisa las filas antes de importar.`, { severity: field === "email" ? "warning" : "error", field, relatedRowIds: group.filter((other) => other.id !== candidate.id).map((other) => other.id) });
    }
  }
  for (const candidate of candidates) {
    candidate.status = candidate.issues.some((item) => item.severity === "error") ? "pending" : candidate.needsServerClassification ? "needs_classification" : "ready";
    if (candidate.status === "pending") rowReview(rowLookup.get(`${candidate.source.sheetIndex}:${candidate.source.row}`), false);
  }
  const pending = candidates.filter((candidate) => candidate.status === "pending").length;
  return {
    version: 1, file: parsed.file, workbook: parsed.workbook, sourceWorkbook: parsed,
    sourceRows: parsed.sourceRows, plan, candidates, excludedRows, unassignedRows,
    questions: [...questions.values()], issues: globalIssues,
    summary: {
      sourceRows: parsed.sourceRows.length, candidates: candidates.length, excluded: excludedRows.length,
      unassigned: unassignedRows.length, pending, ready: candidates.length - pending,
      needsServerClassification: candidates.filter((candidate) => candidate.status === "needs_classification").length,
      balanced: parsed.sourceRows.length === candidates.length + excludedRows.length + unassignedRows.length,
    },
  };
}

// HTTP and WhatsApp share this module in the service process. Acquire before
// starting the parser worker and retain the permit through structural AI work.
// Reject instead of retaining uploaded files in an unbounded waiting queue.
let analysisActive = false;

async function analyzeStartList({ buffer, mimeType, filename, catalog, decisions = {}, planAnalyzer = null }) {
  if (analysisActive) throw new StartListAnalysisError("analysis_busy", "Hay otro archivo en análisis. Espera unos segundos y vuelve a intentarlo.");
  analysisActive = true;
  try {
    const parsed = await parseStartListWorkbookAsync({ buffer, mimeType, filename });
    checkSourceWorkbook(parsed);
    let plan = inferStartListPlan(parsed);
    const issues = [];
    if (planAnalyzer) {
      try {
        const proposed = await planAnalyzer(buildStartListAnalysisContext(parsed, catalog));
        plan = validateStartListPlan(proposed, parsed);
      } catch {
        issues.push({ code: "ai_plan_unavailable", severity: "warning", message: "No se pudo validar la propuesta de IA. Revisa las columnas detectadas y las filas pendientes." });
      }
    }
    return buildAnalysis(parsed, catalog, plan, decisions, issues);
  } finally {
    analysisActive = false;
  }
}

function reanalyzeStartList({ workbook, sourceWorkbook, catalog, decisions = {}, plan }) {
  return buildAnalysis(sourceWorkbook || workbook, catalog, plan, decisions);
}

module.exports = {
  analyzeStartList, reanalyzeStartList, normalizeBirthDate, normalizeGender,
  distanceKey, makeQuestionId, FIELD_LABELS, checkSourceWorkbook,
};
