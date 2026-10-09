# Avisos de corrección de tiempos a Slack

Preparación local, desactivada por defecto. No se crearon credenciales, no se enviaron
mensajes reales y no se desplegó. Canal aprobado en la conversación: privado
`#soporte-cronox` (`C0C869UV212`); alcance aprobado: identificador y enlace, sin DNI ni
teléfonos. El canal se selecciona al autorizar el webhook, no en el código.

## Qué observa

El observador consulta respuestas automáticas ya guardadas por el procesamiento actual.
El primer aviso llega después de clasificar la solicitud y guardar la respuesta, no al
recibir el webhook de WhatsApp. Si todavía no existe SupportCase por faltar competencia,
usa el identificador de conversación y después lo asocia al caso sin duplicar el aviso.
No observa importaciones de listas, mensajes manuales ni consultas ordinarias.
La detección depende de la clasificación existente; debe validarse con casos reales
autorizados antes de activar el emisor.

Consulta las acciones de corrección guardadas, incluidas ejecuciones humanas del panel.
El estado interno **VERIFIED** exige `EXOTIMER_APPLY_RESULT_TIME_EVIDENCE_CORRECTION`
con `verification.verified === true`. Una solicitud registrada, un `EXECUTED`, un
caso `RESOLVED` o una respuesta de IA que diga «corregido» no bastan. Una escritura
sin lectura concluyente y una lectura discrepante conservan su seguimiento interno sin
publicar ese estado en Slack.
No vuelve a llamar a Exotimer, no altera políticas, respuestas, estados de casos ni acciones.
Si alguien cambia tiempos fuera de este proyecto, no hay supervisión automática de ese
cambio salvo que el flujo existente guarde una nueva acción con evidencia.

El aviso comparte exclusivamente identificador y enlace autenticado. Los nombres,
dorsales, documentos, teléfonos, evidencias, entradas/salidas Exotimer y texto de IA
no se comparten, ni tampoco el estado operativo. El enlace abre el panel autenticado
y filtra el caso indicado;
si todavía no hay caso abre la conversación. La respuesta automática se consulta allí.
Los despliegues de frontend y backend deben incluir esta versión para abrir esos enlaces.

`SLACK_INCLUDE_AUTO_REPLY` debe mantenerse en `false`. Aunque se configure accidentalmente
en `true`, no habilita la publicación de respuestas ni de estados: el renderizador solo
admite identificador y enlace. Los avisos nuevos guardan únicamente estos dos campos;
los avisos históricos conservan sus datos de auditoría, pero el envío de cualquier aviso
pendiente filtra los campos antiguos. No se editan ni borran los mensajes ya publicados.

## Configuración pendiente de aprobación final

| Variable | Valor inicial | Uso |
| --- | --- | --- |
| `SLACK_CORRECTIONS_ENABLED` | `false` | Solo el literal `true` habilita el observador/emisor. |
| `SLACK_CORRECTIONS_WEBHOOK_URL` | vacío | Secreto del webhook de la app Slack, autorizado en el canal aprobado. |
| `SLACK_CASE_BASE_URL` | vacío | URL del frontend autenticado; por ejemplo la URL pública del sitio o localhost:5173. |
| `SLACK_INCLUDE_AUTO_REPLY` | `false` | Mantener así para compartir solo identificador y enlace. |

No se creó `.env` en este checkout. Los secretos deben introducirse por el mecanismo
seguro de la plataforma de ejecución después de autorizar la activación; no por chat,
ni en Git, ni en el frontend. No se agregó configuración a `.do/app.yaml`.

La propuesta usa una app con Incoming Webhooks, compatible con el plan gratuito, sin
Workflow Builder de pago. El webhook queda asociado al canal escogido al autorizarlo.
Slack Free permite hasta 10 apps, acceso al historial de 90 días y elimina contenido
con más de un año. El registro de soporte sigue siendo la fuente de evidencia.
Fuentes: [Incoming Webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/),
[límites del plan gratuito](https://slack.com/help/articles/115002422943-Usage-limits-for-free-workspaces).

Antes de activar: comprobar permiso para instalar la app, autorizar su webhook en
`#soporte-cronox`, verificar el acceso de los responsables al panel y aprobar el
despliegue/activación. Aplicar la migración añadida solo a la base autorizada.
La migración está preparada pero no se ha aplicado a ninguna base real.
La conexión de Slack del asistente no configura el emisor del servidor.
Cronox/ChatGPT no recibe ni supervisa automáticamente los avisos con esta preparación:
falta verificar la app receptora en el canal y su mecanismo de seguimiento.

## Persistencia, duplicados y fallos

La primera inicialización habilitada fija `startedAt` y excluye respuestas históricas.
El cursor se conserva al reiniciar. Tras una pausa, al reactivar se recuperan las
respuestas guardadas desde el inicio original; no se crea un cursor nuevo por reinicio.
Una marca transaccional por respuesta evita saltos cuando las transacciones se confirman
fuera del orden de sus IDs. Las solicitudes se deduplican por caso; las respuestas
opcionales por su contenido; los estados de acciones por acción/estado y el ID original
en reejecuciones idempotentes.

La cola reserva cada POST antes de enviar y limita el ritmo global a uno por segundo.
Solo `429` se reintenta automáticamente (Retry-After, máximo cinco intentos).
Timeout, errores de red, `5xx`, aceptación no confirmada o caída tras enviar quedan
`UNCERTAIN` sin reenvío automático. Esto prioriza evitar duplicados y puede dejar un
aviso sin entregar: revisar el canal y el registro antes de cualquier recuperación manual.
Incoming Webhooks no ofrece una garantía de entrega exactamente una vez.
Los errores guardados son códigos genéricos, sin URL del webhook ni cuerpo del proveedor.

`GET /api/notifications/slack`, protegido por la autenticación Firebase existente,
muestra configuración, inicialización y los 50 últimos estados de cola, sin secreto
ni texto de mensajes. `observerInitialized` confirma un registro persistido, no la
actividad actual del proceso ni la supervisión de Cronox.

## Comprobación local sin secretos

```powershell
npm ci --ignore-scripts
npm run prisma:generate
node --test backend/src/services/slackCorrections.test.js
npm test
npm --prefix frontend ci --ignore-scripts
npm run build:frontend
```

Las pruebas nuevas usan una base simulada y un transporte simulado. Cubren datos mínimos,
configuración desactivada, detección, evidencia verificable, promoción de conversación,
reinicios, transacciones tardías, concurrencia, `429`, incertidumbre, fallos de persistencia,
deduplicación y enlaces. No verifican entrega real, permisos Slack, acceso real a casos ni
la migración ejecutada sobre PostgreSQL.
