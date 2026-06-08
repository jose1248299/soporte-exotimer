# Analisis de integracion con app-exotimer

Proyecto revisado: `C:\Users\gomez\Documents\Desarrollo de Software\app-exotimer\finisher-data-admin`.

## Resumen tecnico

`app-exotimer` es un frontend Next.js/React que consume una API externa definida por `NEXT_PUBLIC_APP_URL_HTTP_BACK`. En `.env.local` apunta a `https://raceline.app`. No contiene el backend, pero si deja expuestos los endpoints, payloads y flujos funcionales.

El cliente usa JWT Bearer desde `localStorage.access`. En `soporte-exotimer` se usa un token de servicio en backend (`EXOTIMER_API_TOKEN`) y credenciales de renovacion (`EXOTIMER_API_USER`, `EXOTIMER_API_PASSWORD`) para refrescar el JWT sin exponerlo en el navegador.

## Autenticacion

| Uso | Metodo | Endpoint | Payload |
| --- | --- | --- | --- |
| Login | POST | `/api/token/` | `{ user_firebase, password }` |
| Verificar token | POST | `/api/token/verify/` | `{ token }` |
| Refrescar token | POST | `/api/token/refresh/` | `{ refresh }` |

## Competencias

| Uso | Metodo | Endpoint | Observaciones |
| --- | --- | --- | --- |
| Listar competencias | GET | `/v2/competitions/list/` | Devuelve `past_competitions`, `future_competitions`, `all_competitions`. |
| Detalle competencia | GET | `/api/competition/one-event/{id}` | Trae datos generales y `description`. |
| Crear competencia | POST multipart | `/api/competition/create/` | `name`, `date`, `country`, `city`, `sport`, `organizer`, `banner?`. |
| Actualizar competencia | POST multipart | `/api/competition/{id}/update/` | Datos generales, `description`, `banner?`, `bases_competition?`. |
| Catalogo paises | GET | `/api/competition/paises/list/` | Usado en formularios. |
| Catalogo ciudades | GET | `/api/competition/cities/list/` | Usado en formularios. |
| Catalogo deportes | GET | `/v2/competitions/sports/list/` | Usado en competencia/organizador. |

## Eventos, distancias y configuracion tecnica

| Uso | Metodo | Endpoint | Payload |
| --- | --- | --- | --- |
| Listar eventos de competencia | GET | `/v2/competitions/events/{competitionId}/` | Incluye configs, categorias y tickets. |
| Formulario custom de eventos | GET | `/v2/competitions/events/form/{competitionId}/` | Mapa para seleccionar evento/categoria/genero/salida. |
| Crear/actualizar eventos | POST | `/api/competition/event/create/` | `{ competition, form }`, donde `form` es el arreglo completo de eventos. |
| Validacion pre-carrera | GET | `/v2/results/validate/{competitionId}/` | Duplicados de chips/dorsales, generos invalidos. |

Estructura de evento (`form`):

- `eventFormProps.nombre`: nombre de distancia/evento.
- `eventFormProps.cam_details`: camara asociada.
- `eventFormProps.tickets`: tickets del evento.
- `sharedStateProps.child1Forms`: puntos de control.
- `sharedStateProps.child2Forms`: secciones/calculos.
- `sharedStateProps.child3Forms`: salidas.
- `sharedStateProps.child4Forms`: categorias/generos.

Punto de control:

```json
{
  "nombre": "Meta",
  "localizacion": "META",
  "tiempoMinimo": "0",
  "tiempoMinimoVuelta": "0",
  "tipo": "Meta",
  "readers": [],
  "rangeInit": "",
  "rangeFinish": "",
  "distancia": "0",
  "tipoSalida": "cronometro"
}
```

Salida:

```json
{
  "nombre": "Salida 1",
  "fecha": "DD/MM/YYYY, HH:mm:ss"
}
```

Categoria:

```json
{
  "nombre": "GENERAL",
  "generos": {
    "masculino": true,
    "femenino": true,
    "mixto": false
  }
}
```

## Tickets e inscripciones

| Uso | Metodo | Endpoint | Observaciones |
| --- | --- | --- | --- |
| Listar tickets por competencia | GET | `/api/inscription/ticket/list/{competitionId}/` | Devuelve detalle de competencia y tickets. |
| Listar competencias futuras con tickets | GET | `/api/competition/events-future/list/` | Util para consultas publicas/compradores. |
| Verificar inscripcion | GET | `/api/inscription/detail-verify/` | Params: `competition`, `dorsal`. |
| Listar inscripciones | GET | `/api/inscription/list/{competitionId}/` | Uso admin/organizador. |
| Solicitar cambio de inscripcion | POST | `/api/inscription/update/` | `{ competition_id, dorsal, document }`; queda pendiente de aprobacion. |
| Actualizar inscripcion admin | POST | `/api/inscription/update-admin/` | `{ competition_id, dorsal, document }`; cambio directo. |
| Datos combinados de eventos | GET | `/api/competition/event/combine-data/{competitionId}/` | Opciones para alta de inscripcion. |
| Schema alta dashboard | GET | `/api/inscription/dashboard/form/add/{competitionId}/` | Campos dinamicos de inscripcion. |
| Crear inscripcion dashboard | POST | `/api/inscription/create/dashboard/` | `{ competition_id, document }`. |

Ticket:

```json
{
  "id": 123,
  "title": "10K General",
  "startDate": "2026-06-01",
  "endDate": "2026-06-20",
  "currency": "PEN",
  "amount": "80"
}
```

Los tickets se guardan dentro de cada evento usando `/api/competition/event/create/`, enviando el arreglo completo de eventos.

Configuracion de inscripciones vive en `competition.description` y se guarda con `/api/competition/{id}/update/`:

```json
{
  "extra": {},
  "sheet": "",
  "type_pay": "voucher",
  "payments_details": "",
  "waLink": "",
  "photoLink": "#",
  "application_fee": 15,
  "collector_id": null,
  "access_token": null,
  "public_key": null,
  "trackingInit": "",
  "trackingEnd": "",
  "gapVideo": 0
}
```

## Resultados y atletas

| Uso | Metodo | Endpoint | Payload |
| --- | --- | --- | --- |
| Listar resultados | POST | `/v2/results/list/` | `{ competition_id: number }` |
| Detalle resultado | GET | `/v2/results/detail/{ids}/` | `ids` puede ser lista serializada. |
| Crear resultado/atleta | POST | `/v2/results/create/` | Form con dorsal, chip, nombre, evento, categoria, genero, salida, competition. |
| Editar datos de atleta/resultado | POST | `/v2/results/update-participant/` | Form de edicion + `result_id`, `id_competicion`. |
| Estado de resultado | GET | `/v2/results/state/{resultId}/` | Opciones/estado. |
| Cambiar estado de resultado | POST | `/v2/results/state/{resultId}/` | `{ state }`. |
| Editar tiempo por punto | POST | `/v2/results/edit-times/` | `{ timeDateCurrent, timeCurrent, selectRaw, result_id, name_colum }`. |
| Eliminar resultado | DELETE | `/v2/results/delete/{resultId}/` | Destructivo. |
| Eliminar todos por competencia | DELETE | `/v2/results/by_competition/delete/{competitionId}/` | Muy destructivo. |
| Imagenes de llegada | GET | `/v2/results/list/images-finish/?image_path=...` | Evidencia visual. |

Campos para crear/editar resultado:

```json
{
  "dorsal": 1842,
  "chip": 1842,
  "participantName": "Carlos",
  "participantLastname": "Medina",
  "evento_distancia": "21K",
  "categoria": "GENERAL",
  "genero": "masculino",
  "salida": "Salida 1",
  "competition": "123"
}
```

## Raws y cronometraje

| Uso | Metodo | Endpoint | Payload |
| --- | --- | --- | --- |
| Listar raws | GET | `/v2/raws/{competitionId}/list/` | Agrupados por locacion/asignacion. |
| Config salidas/raws | GET | `/v2/raws/config/salidas/{competitionId}/` | Salidas por evento. |
| Actualizar hora de salida | POST | `/v2/raws/config/update/` | `{ time, name_output, event_name, competition_id }`. |
| Raws no asignados | GET | `/v2/raws/list/no_asigment/` | Params: `chip`, `competition_id`. |
| Crear raw manual | POST | `/v2/raws/create/` | Lectura manual. |
| Procesar imagen de raws | POST multipart | `/v2/ia/raws/process-image/` | `image`. |
| Subir CSV raws | POST multipart | `/v2/raws/upload-csv/` | `csv_file`. |
| Guardar mapeo CSV raws | POST | `/v2/raws/rename-save/` | `{ competition, columna: campo }`. |

Raw manual:

```json
{
  "dorsal": "1842",
  "chip": "1842",
  "hour": "08/06/2026 10:21:30",
  "zulu": "08/06/2026 10:21:30",
  "location": "META",
  "team_computer": "reader_META_123",
  "state": false,
  "competition": 123
}
```

## Dispositivos y camaras

| Uso | Metodo | Endpoint | Observaciones |
| --- | --- | --- | --- |
| Canales activos | GET | `/v2/computers/list/active-channels/` | Salud/conexion de readers. |
| Readers por competencia | GET | `/v2/computers/list/by-competition/{competitionId}/` | Diagnostico Timer. |
| Readers del organizador | GET | `/v2/computers/organizer/` | Catalogo. |
| Crear reader | POST | `/v2/computers/organizer/` | `ComputerProps`. |
| Actualizar reader | PUT | `/v2/computers/organizer/` | `ComputerProps`. |
| Camaras del organizador | GET | `/v2/cameras/organizer/` | Catalogo. |
| Crear camara | POST | `/v2/cameras/organizer/` | `CameraProps`. |
| Actualizar camara | PUT | `/v2/cameras/organizer/` | `CameraProps`. |

## Organizadores y usuarios

| Uso | Metodo | Endpoint |
| --- | --- | --- |
| Buscar usuario por Firebase ID | GET | `/api/users/?user_firebase=...` |
| Buscar usuarios | GET | `/api/users/?search=...` |
| Crear usuario organizador | POST | `/api/users/` |
| Cambiar rol usuario | PATCH | `/api/users/{id}/` |
| Listar/buscar organizadores | GET | `/v2/organizers/?search=...` |
| Crear organizador | POST | `/v2/organizers/` |
| Actualizar organizador | PATCH | `/v2/organizers/{id}/` |
| Asignar usuario a organizador | PATCH | `/v2/organizers/{id}/` |

## Notificaciones y aprobaciones

| Uso | Metodo | Endpoint | Payload |
| --- | --- | --- | --- |
| Cambios pendientes de inscripcion | GET | `/api/inscription/history/list-pending/{competitionId}/` | Para revisar solicitudes. |
| Cambios pendientes de resultados | GET | `/api/result/list/notificacitions-changes/{competitionId}/` | Reclamos/resultados. |
| Aprobar/denegar inscripcion | POST | `/api/inscription/approve-change/` | `{ history_id, state, is_user }`. |
| Aprobar/denegar resultado | POST | `/api/result/approve-change/` | `{ history_id, state, is_user }`. |

## Casuisticas por tipo de usuario

### Timer

Automatizable con validacion:

- Consultar estado de readers conectados.
- Consultar readers/camaras asociados a competencia.
- Consultar configuracion de eventos, puntos de control, salidas y categorias.
- Actualizar hora de salida con `/v2/raws/config/update/`.
- Crear raw manual con `/v2/raws/create/`.
- Editar un tiempo de resultado con `/v2/results/edit-times/` si se identifica resultado, punto y raw/tiempo.
- Ejecutar validacion pre-carrera con `/v2/results/validate/{competitionId}/`.

Requiere confirmacion humana:

- Cambiar estructura completa de competencia/eventos.
- Eliminar resultados.
- Importar CSV masivo de raws.
- Cambiar readers/camaras del organizador.

### Organizador

Automatizable con validacion:

- Consultar tickets activos de una competencia.
- Cambiar precio/moneda/fechas/titulo de un ticket, siempre que se ubique competencia, evento y ticket.
- Cambiar configuracion de inscripcion simple (`payments_details`, `type_pay`, `application_fee`, `waLink`, `photoLink`).
- Crear o actualizar inscripcion admin si el organizador esta autorizado.

Requiere confirmacion humana:

- Modificar estructura de distancias, categorias, salidas o puntos de control.
- Subir bases de competencia.
- Cambios que afecten Mercado Pago (`collector_id`, `access_token`, `public_key`).

### Atleta

Automatizable:

- Verificar inscripcion por competencia + dorsal.
- Consultar resultado por competencia + dorsal/nombre.
- Registrar solicitud de correccion en `soporte-exotimer` con datos requeridos.
- Consultar estado de una solicitud si se modela en soporte.

No ejecutar automaticamente sin revision:

- Cambiar tiempo oficial.
- Cambiar dorsal/chip/categoria/genero.
- Asociar raws.
- Aprobar reclamos de resultado.

### Comprador

`app-exotimer` no contiene cotizacion comercial de servicios. Para compradores se debe usar el flujo de ventas/cotizaciones del proyecto de ventas. Desde Exotimer solo aplica:

- Mostrar eventos futuros con tickets.
- Informar precios de tickets existentes.
- Derivar a organizador si pregunta por inscripcion a un evento especifico.

## Recomendacion de implementacion en soporte-exotimer

Crear una capa de herramientas con tres niveles:

1. Lectura segura: endpoints GET/POST de consulta sin efectos.
2. Escritura acotada: cambios pequenos y reversibles con validacion fuerte.
3. Escritura critica: solo propuesta IA + confirmacion humana.

Acciones sugeridas:

- `EXOTIMER_LIST_COMPETITIONS`
- `EXOTIMER_FIND_COMPETITION`
- `EXOTIMER_GET_COMPETITION_EVENTS`
- `EXOTIMER_GET_TICKETS`
- `EXOTIMER_UPDATE_EVENT_TICKET`
- `EXOTIMER_GET_INSCRIPTION`
- `EXOTIMER_UPDATE_INSCRIPTION_ADMIN`
- `EXOTIMER_GET_RESULTS`
- `EXOTIMER_GET_RESULT_DETAIL`
- `EXOTIMER_CREATE_RESULT_CORRECTION_CASE`
- `EXOTIMER_UPDATE_RESULT_PARTICIPANT`
- `EXOTIMER_EDIT_RESULT_TIME`
- `EXOTIMER_VALIDATE_PRE_RACE`
- `EXOTIMER_GET_RAWS`
- `EXOTIMER_CREATE_MANUAL_RAW`
- `EXOTIMER_UPDATE_START_TIME`
- `EXOTIMER_GET_CONNECTED_READERS`

Para cambios con arreglo completo (`/api/competition/event/create/`), la herramienta debe:

1. Leer eventos actuales.
2. Encontrar el evento/ticket exacto.
3. Aplicar un parche minimo.
4. Guardar el arreglo completo.
5. Registrar diff antes/despues en `SupportAction`.

## Datos que debe pedir la IA antes de actuar

- Competencia: nombre o id.
- Evento/distancia: 5K, 10K, 21K, etc.
- Identificador: dorsal, chip, ticket, salida o punto de control.
- Cambio exacto: nuevo precio, nueva hora, nuevo dato de atleta, nuevo estado.
- Confirmacion explicita cuando el cambio modifica resultados, salidas o configuracion tecnica.
