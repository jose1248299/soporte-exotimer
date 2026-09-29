# Importador Start List con IA — primera versión

Implementación local del 29 de septiembre de 2026. La activación y las migraciones de producción se realizan por separado.

## Alcance

El importador interpreta XLSX, XLS y CSV para una competencia que ya tiene distancias, categorías y salidas. El usuario revisa una propuesta, resuelve dudas y confirma qué participantes guardar. El importador manual de Timing sigue disponible.

Esta versión no crea ni modifica la configuración de la competencia. Normaliza coincidencias inequívocas de nombres, mayúsculas, acentos y unidades de distancia; ofrece las opciones existentes cuando hay ambigüedad. Si falta una distancia o salida, debe configurarse y luego revisar nuevamente la propuesta.

En categorías Básicas se resuelve una categoría existente; la fecha de nacimiento es opcional. En Detalladas se exige fecha de nacimiento y género, y Registration calcula la categoría con la política vigente. Una categoría escrita en el archivo se trata como una referencia que debe concordar, nunca como permiso para saltarse el cálculo.

## Qué interpreta el agente

`startListWorkbook.js` conserva hojas, filas y celdas originales. Admite encabezados variables, bloques y varias hojas; el programa lee todas las filas del rango, aunque al modelo se envíen muestras de estructura.

`startListPlan.js` define el contrato del plan. El modelo identifica columnas o celdas de contexto para nombres, apellidos, nombre completo, documento, correo, teléfono, nacimiento, género, distancia, categoría, salida, club, dorsal y chip. No puede inventar constantes, reconstruir personas ni convertir edad en fecha de nacimiento. Las fórmulas no se ejecutan: se utiliza el valor guardado y se detecta su ausencia.

`startListAnalysis.js` aplica el plan sobre la fuente completa y produce candidatos, exclusiones y filas sin resolver. Las filas omitidas por la IA continúan visibles. Las exclusiones dudosas requieren una decisión del usuario. Se preservan los ceros iniciales de campos textuales cuando existen en el archivo.

`startListAi.js` utiliza respuestas JSON estructuradas, sin herramientas de escritura, sin almacenar la respuesta del proveedor y con tiempo límite. La conversación sólo elige IDs de opciones disponibles. Una frase como “sí, procede” no ejecuta una importación. Si falla el proveedor, la revisión puede continuar con las opciones manuales.

Límites: archivo 10 MB; 32 hojas; 80 columnas; 10 000 filas con datos; fuente serializada 5 MB; XLSX expandido 64 MB. La lectura se ejecuta en un worker con 256 MB y 10 segundos. El borrador completo de Registration admite 32 MB para conservar la fuente, propuesta, validaciones y recibos. Un archivo muy denso puede alcanzar los límites de fuente o borrador antes de las 10 000 filas.

Cada proceso del servicio admite un solo análisis de archivo a la vez, compartido entre Timing y WhatsApp. El permiso cubre tanto el worker de lectura como la propuesta estructural de IA y se libera también cuando hay errores. Otro archivo recibe un rechazo reintentable, sin permanecer en una cola en memoria: HTTP devuelve `429`, código `analysis_busy` y `Retry-After: 10`; WhatsApp solicita volver a enviar el archivo. Resolver opciones de un borrador ya leído puede continuar. Este límite protege la instancia actual de 500 MB y no implica cambiar su tamaño ni su costo.

## Canal Timing

El navegador usa el BFF de Timing en `/api/start-list/imports`. El BFF verifica la sesión y los permisos de la competencia, consulta el catálogo y llama a este servicio desde el servidor.

Este servicio expone:

- `POST /api/exotimer/start-list/analyze`: archivo codificado en base64 y catálogo vigente.
- `POST /api/exotimer/start-list/resolve`: fuente original, plan, decisiones y mensaje opcional; las preguntas se reconstruyen en el servidor.

Ambas rutas requieren `X-Support-Api-Key`. `X-Startlist-Operator` identifica al operador mediante HMAC, sin transmitir su token de Timing. Hay límites de concurrencia y frecuencia. El navegador nunca recibe la clave de soporte.

Registration persiste los borradores, versiones, selecciones validadas y recibos por fila. El guardado usa la importación operativa de Timing en ambos modos de categorías; no crea tickets, envía correos comerciales ni reemplaza participantes existentes. Una revisión modificada invalida la confirmación anterior. Los reintentos conservan la clave de idempotencia de cada fila.

Si el proceso se reinicia durante un guardado, consultar el borrador comprueba el bloqueo real de la operación antes de liberarlo para revisión. La validación de una fila ya intentada puede recuperar su acuse cuando Timing demuestra que el resultado existe; sólo actualiza los comprobantes locales, sin insertar ni recalcular al participante. Las operaciones que siguen activas conservan su bloqueo.

## Canal WhatsApp

1. Desde Start List, el usuario inicia sesión en Timing, selecciona la competencia y pulsa **Continuar en WhatsApp**.
2. Timing entrega un comando `VINCULAR <código>`, de un solo uso y con vencimiento de diez minutos.
3. Al enviar ese comando al WhatsApp de soporte, se delega acceso exclusivamente al borrador seleccionado. Puede ser un borrador vacío para recibir el archivo después.
4. El usuario envía el Excel/CSV y resuelve las preguntas en el chat. Se utiliza el mismo motor y el mismo catálogo que en Timing.
5. El bot presenta el resultado de la validación y un comando de confirmación. Se debe copiar exactamente el comando vigente. Está ligado a la versión, token de revisión y conjunto de filas mostrado; vence a los quince minutos.
6. `ESTADO` recupera el borrador y permite revisar nuevamente. `CANCELAR IMPORTACION` revoca el vínculo y conserva el borrador y los participantes ya importados. También puede revocarse desde Timing.

El acceso delegado dura como máximo una hora y nunca más que la sesión original de Timing. Cada operación vuelve a comprobar la cuenta, sus permisos actuales y la competencia. Un teléfono de soporte por sí solo no concede acceso a Timing. Para cambiar de competencia se necesita otro vínculo emitido desde Timing.

El token de Timing permanece cifrado en Registration. Soporte conserva únicamente una concesión opaca, también cifrada y vinculada al identificador del remitente. La tabla `StartListWhatsappSession` guarda el estado temporal y el control de concurrencia del chat. Los códigos no se guardan como mensajes en claro. Las notificaciones duplicadas y las confirmaciones vencidas no ejecutan una nueva importación.

Al activar este canal, el webhook requiere la firma `X-Hub-Signature-256` de Meta sobre el cuerpo original. El flujo de importación se intercepta antes del agente general de soporte; éste no recibe nuevas herramientas generales para insertar participantes.

## Configuración y activación

Las banderas se evalúan en el servidor y están apagadas por defecto. No agregar secretos como variables `NEXT_PUBLIC_*`.

| Servicio | Variable | Uso |
| --- | --- | --- |
| Timing y soporte | `START_LIST_IMPORTS_ENABLED=true` | Habilita la primera versión |
| Timing | `SUPPORT_API_URL` | URL del servidor de soporte |
| Timing | `SUPPORT_API_ALLOWED_HOSTS` | Lista de hosts permitidos, separados por comas |
| Timing y soporte | `SUPPORT_EXOTIMER_API_KEY` | Clave compartida entre servidores |
| Soporte | `OPENAI_API_KEY`, `OPENAI_MODEL` | Configuración existente del proveedor; el modelo debe admitir el contrato estructurado |
| Soporte | `START_LIST_WHATSAPP_ENABLED=true` | Habilita la recepción y confirmación desde WhatsApp |
| Soporte | `META_APP_SECRET` | Verifica las firmas de Meta |
| Soporte | `START_LIST_WHATSAPP_ENCRYPTION_KEY` | Clave aleatoria de 32 bytes, codificada en base64, para las concesiones |
| Soporte | `START_LIST_REGISTRATION_INTERNAL_TOKEN` | Token interno autorizado por Registration |
| Soporte | `RACELINE_API_BASE_URL` o `EXOTIMER_API_BASE_URL` | Base existente de los microservicios |
| Registration | `TIMING_IMPORT_WHATSAPP_ENABLED=true` | Habilita concesiones de WhatsApp |
| Registration | `TIMING_IMPORT_CHANNEL_ENCRYPTION_KEY` | Clave Fernet para el token de Timing |

Se conserva la configuración existente de Meta para recibir medios y enviar mensajes. Las claves de cifrado deben ser estables entre réplicas y reinicios; una rotación exige revincular las concesiones activas.

Los proxies deben admitir los cuerpos de estas rutas: 11 MiB para la carga multipart a Timing, 15 MiB para análisis/resolución en soporte y al menos 32 MiB más margen de transporte para borradores de Registration. Los clientes internos limitan las respuestas a 64 MiB. Verificar también los tiempos de espera del proxy con una lista de prueba grande; el análisis y el guardado por bloques pueden tardar más que una consulta normal.

Orden de preparación:

1. Aplicar y verificar en un entorno de pruebas las dos migraciones de Registration (`20260930_startlist_import_batches.sql` y `20260930_timing_import_channels.sql`) y su versión de Timing Processing.
2. Aplicar la migración Prisma `20260930090000_startlist_whatsapp_session`, generar Prisma Client y desplegar soporte con las banderas apagadas.
3. Desplegar Timing con las variables del BFF y la bandera apagada.
4. Probar en ese entorno con datos sintéticos: categorías Básicas/Detalladas, varias hojas, conflictos, pérdida de conexión, permisos retirados, vínculo y confirmación de WhatsApp.
5. Habilitar primero el importador de Timing y después el canal WhatsApp. Verificar con una competencia de prueba antes de abrirlo a operadores reales.

Para retirar la funcionalidad, apagar las banderas y regresar al importador manual. Revocar las concesiones activas si corresponde. No eliminar las tablas, recibos ni participantes: desactivar la interfaz no deshace una importación confirmada.

## Validación local y límites pendientes

Los tests usan libros sintéticos y dobles de Identity, catálogo, Registration, proveedor IA y WhatsApp. Ejecutar `npm test` y `npm run prisma:generate` en soporte; consultar los tests del BFF/UI en Timing y los servicios de importación en Registration/Timing Processing.

Verificado localmente: 79 pruebas de soporte aprobadas, 39 pruebas de UI/BFF aprobadas, generación Prisma y compilación completa de Timing aprobadas. Se revisó la interfaz con componentes reales y datos ficticios. Un caso adicional comprobó la conversión del motor al contrato Pydantic de Registration para Básica sin nacimiento y Detallada con nacimiento, preservando ceros iniciales de documentos.

Backend: 205 pruebas de Registration aprobadas y 15 omitidas; 29 pruebas focales de Timing Processing aprobadas. Se comprobaron caídas durante el guardado, bloqueos activos y conciliación del acuse sin una segunda materialización. Las verificaciones que requieren PostgreSQL real están pendientes.

No se han llamado al proveedor IA ni a WhatsApp reales, importado participantes de producción o desplegado estos cambios. Las migraciones de PostgreSQL deben ensayarse antes de activar; el entorno local no tiene un daemon PostgreSQL/Docker disponible.
