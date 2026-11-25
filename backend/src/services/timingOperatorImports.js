const { requireOperator } = require('./timingOperatorContext');
const { reanalyzeStartList } = require('./startListAnalysis');
const { resolveConversationAnswers } = require('./startListAi');
const { batchRows, preserveAttemptedAnalysis } = require('./startListWhatsapp');
const ROOT = '/registration/api/v1/timing-imports/batches';
const blocked = candidate => !candidate || (candidate.issues || []).some(issue => issue.severity === 'error');

async function operate(session, args, input) {
  const { actor, request, db, reports } = session;
  if (!/^[a-f0-9-]{36}$/i.test(args.draft_id)) throw new Error('Borrador inválido. Adjunta primero el archivo.');
  const path = `${ROOT}/${args.draft_id}`;
  let batch = await request({ path });
  if (batch.competition_id !== actor.competitionId) throw new Error('El borrador pertenece a otra competición.');
  const meta = batch.metadata?.start_list;
  if (!meta?.analysis) throw new Error('El borrador no tiene un análisis de origen verificable.');
  if (args.operation === 'resolve') {
    const context = await session.inspect();
    const events = await request({ path: '/catalog/api/v1/events/', params: { competition_id: actor.competitionId, limit: 500, offset: 0 } });
    if (!Array.isArray(events) || events.some(e => e.competition_id !== actor.competitionId)) throw new Error('Catálogo de distancias inválido.');
    const catalog = { competitionId: actor.competitionId, events: events.map(event => {
      const policy = context.category_policies.find(p => p.event_id === event.id);
      const config = context.configs.find(c => c.event_id === event.id);
      if (!policy || !config) throw new Error('Completa la configuración de la distancia antes de importar.');
      return { id: event.id, name: event.name, distanceMeters: event.distance_meters, categoryMode: policy.mode,
        policyVersion: policy.version, cutoffDate: policy.cutoff_date, closed: policy.closed, pendingOperation: Boolean(policy.pending_operation_id),
        categories: (policy.categories || []).filter(c => c.is_active !== false && c.is_enabled !== false).map(c => ({ id: c.category_id, name: c.name, gender: c.gender, minAge: c.min_age, maxAge: c.max_age })),
        starts: (config.start_waves?.length ? config.start_waves.map(w => ({ id: String(w.id), name: w.name })) : (config.salidas || []).map((w,index) => ({ id: String(w.id || index), name: w.data?.nombre }))) };
    }) };
    const answers = await resolveConversationAnswers({ questions: meta.analysis.questions || [], message: input.text, catalog });
    const decisions = { ...(meta.decisions || {}) };
    for (const answer of answers.answers) decisions[answer.questionId] = answer.optionId;
    const analyzed = reanalyzeStartList({ sourceWorkbook: meta.analysis.sourceWorkbook, plan: meta.analysis.plan, catalog, decisions });
    const updated = preserveAttemptedAnalysis(analyzed, meta.analysis, batch.rows || []);
    const rows = new Map(batchRows(updated, actor.competitionId).map(row => [row.row_key,row]));
    for (const row of batch.rows || []) if (row.attempted || row.status === 'imported') rows.set(row.row_key, { row_key: row.row_key, source_ref: row.source_ref, payload: row.payload });
    batch = await request({ method: 'PATCH', path, data: { expected_version: batch.version, rows: [...rows.values()], metadata: {
      ...batch.metadata, start_list: { ...meta, analysis: updated, decisions, catalog } } } });
    reports.push(`Borrador ${batch.id}: decisiones guardadas. ${answers.clarification || ''}`);
  } else if (args.operation === 'import') {
    const context = await session.inspect();
    // Import validation does not simulate ranking changes from historical chip reads.
    if (context.has_finish_records !== false) throw new Error('Esta carrera ya tiene llegadas o no se pudo comprobarlo. La importación desde el chat requiere revisar el posible efecto de las lecturas; usa Start List para esa conciliación.');
    const candidates = new Map((meta.analysis.candidates || []).map(c => [c.id,c]));
    const eligible = (batch.rows || []).filter(row => !row.attempted && row.status !== 'imported' && !blocked(candidates.get(row.row_key))).map(row => row.row_key);
    for (let offset = 0; offset < eligible.length; offset += 100) {
      requireOperator();
      const selection = eligible.slice(offset, offset + 100);
      batch = await request({ method: 'POST', path: `${path}/preview`, data: { expected_version: batch.version, row_keys: selection } });
      const ready = (batch.rows || []).filter(row => selection.includes(row.row_key) && row.status === 'ready' && row.validation?.valid === true).map(row => row.row_key);
      if (!ready.length) continue;
      const audit = await db.supportAction.create({ data: { conversationId: input.conversationId, messageId: input.messageId, name: 'TIMING_OPERATOR_IMPORT', userType: 'SYSTEM_USER', status: 'PROPOSED',
        input: { actorId: actor.accountId, competitionId: actor.competitionId, draftId: batch.id, version: batch.version, rowKeys: ready } } });
      try {
        batch = await request({ method: 'POST', path: `${path}/commit`, data: { expected_version: batch.version, preview_token: batch.preview_token, row_keys: ready } });
        const receipts = batch.rows.filter(row => ready.includes(row.row_key)).map(row => ({ row_key: row.row_key, status: row.status, result_id: row.result_id, error: row.error }));
        await db.supportAction.update({ where: { id: audit.id }, data: { status: 'EXECUTED', output: { receipts, notifications_sent: false } } });
        reports.push(`Borrador ${batch.id}: ${receipts.filter(row => row.status === 'imported').length} de ${ready.length} filas confirmadas en este lote; las demás requieren revisar su estado.`);
      } catch (error) {
        await db.supportAction.update({ where: { id: audit.id }, data: { status: 'FAILED', error: 'No se confirmó el recibo. Consultar borrador antes de reenviar.' } });
        throw new Error('Se interrumpió el envío. Consulta el borrador para conocer las filas guardadas; no se reenviaron automáticamente.');
      }
    }
    if (!eligible.length) reports.push('No hay filas nuevas listas para importar; revisa las preguntas o los recibos del borrador.');
  } else if (args.operation !== 'inspect') throw new Error('Operación de listado inválida.');
  const analysis = batch.metadata?.start_list?.analysis || {};
  return { id: batch.id, version: batch.version, status: batch.status,
    counts: (batch.rows || []).reduce((counts,row) => ({ ...counts, [row.status]: (counts[row.status] || 0) + 1 }), {}),
    questions: (analysis.questions || []).filter(q => !q.resolved),
    rows: (batch.rows || []).slice(0,100).map(row => ({ key: row.row_key, status: row.status, validation: row.validation, error: row.error })),
    unassigned: analysis.unassignedRows?.length || 0, notifications_sent: false };
}
module.exports = { operate };
