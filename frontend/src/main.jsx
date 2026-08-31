import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  Bot,
  Camera,
  ClipboardCheck,
  Eye,
  Filter,
  FileText,
  Headphones,
  Image as ImageIcon,
  LockKeyhole,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  UserCog,
  UserRound,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import {
  auth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "./firebase.js";
import { apiBlobUrl, apiFetch, setAuthTokenProvider } from "./utils/api.js";
import "./styles.css";

const USER_LABELS = {
  SYSTEM_USER: "Usuario sistema",
  TIMER: "Timer",
  BUYER: "Comprador",
  ORGANIZER: "Organizador",
  ATHLETE: "Atleta",
  UNKNOWN: "Sin clasificar",
};

const USER_TYPES = ["SYSTEM_USER", "TIMER", "ORGANIZER", "ATHLETE", "BUYER", "UNKNOWN"];

const CONTACT_DIRECTORIES = {
  timers: {
    title: "Timers",
    singular: "Timer",
    endpoint: "/api/timers",
    description: "Registra los números que se identificarán automáticamente como Timer.",
    namePlaceholder: "Timer Norte",
    notesPlaceholder: "Zona, empresa o eventos que suele operar",
    activeLabel: "Timer activo",
  },
  photographers: {
    title: "Fotógrafos",
    singular: "Fotógrafo",
    endpoint: "/api/photographers",
    description: "Administra los contactos de fotógrafos autorizados.",
    namePlaceholder: "Fotografía Meta",
    notesPlaceholder: "Empresa, zona o eventos que suele cubrir",
    activeLabel: "Fotógrafo activo",
  },
  organizers: {
    title: "Organizadores",
    singular: "Organizador",
    endpoint: "/api/organizers",
    description: "Administra los contactos de organizadores autorizados.",
    namePlaceholder: "Lima Runners",
    notesPlaceholder: "Empresa y eventos que organiza",
    activeLabel: "Organizador activo",
  },
};

function isMobileLayout() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches;
}

const MOCK_CONVERSATIONS = [
  {
    id: "demo-1",
    phone: "51999911122",
    displayName: "Carlos Medina",
    userType: "ATHLETE",
    status: "OPEN",
    lastMessageAt: new Date().toISOString(),
    messages: [
      {
        id: "demo-1-last",
        content: "Necesito corregir mi tiempo del evento de ayer.",
        direction: "INBOUND",
        timestamp: new Date().toISOString(),
      },
    ],
  },
  {
    id: "demo-2",
    phone: "51988833344",
    displayName: "Lima Runners",
    userType: "ORGANIZER",
    status: "WAITING_HUMAN",
    lastMessageAt: new Date(Date.now() - 1000 * 60 * 28).toISOString(),
    messages: [
      {
        id: "demo-2-last",
        content: "Queremos cambiar el cupo del ticket 10K.",
        direction: "INBOUND",
        timestamp: new Date(Date.now() - 1000 * 60 * 28).toISOString(),
      },
    ],
  },
  {
    id: "demo-3",
    phone: "51977755566",
    displayName: "Timer Norte",
    userType: "TIMER",
    status: "OPEN",
    lastMessageAt: new Date(Date.now() - 1000 * 60 * 75).toISOString(),
    messages: [
      {
        id: "demo-3-last",
        content: "Revisa la configuracion de lectura para la meta.",
        direction: "INBOUND",
        timestamp: new Date(Date.now() - 1000 * 60 * 75).toISOString(),
      },
    ],
  },
];

const MOCK_MESSAGES = {
  "demo-1": [
    {
      id: "a1",
      direction: "INBOUND",
      content: "Hola, corri el 21K y mi tiempo aparece mal.",
      timestamp: new Date(Date.now() - 1000 * 60 * 24).toISOString(),
    },
    {
      id: "a2",
      direction: "OUTBOUND",
      content: "Hola, te ayudo. Enviame tu nombre completo, dorsal y el tiempo que registraste.",
      timestamp: new Date(Date.now() - 1000 * 60 * 22).toISOString(),
    },
    {
      id: "a3",
      direction: "INBOUND",
      content: "Carlos Medina, dorsal 1842. Mi reloj marco 1:38:20.",
      timestamp: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
    },
  ],
  "demo-2": [
    {
      id: "o1",
      direction: "INBOUND",
      content: "Necesito subir el cupo del ticket 10K a 500 inscritos.",
      timestamp: new Date(Date.now() - 1000 * 60 * 32).toISOString(),
    },
    {
      id: "o2",
      direction: "OUTBOUND",
      content: "Confirmame el nombre del evento y el ticket exacto para aplicar el cambio.",
      timestamp: new Date(Date.now() - 1000 * 60 * 28).toISOString(),
    },
  ],
  "demo-3": [
    {
      id: "t1",
      direction: "INBOUND",
      content: "Soy Timer Norte. Necesito revisar la configuracion de chips para la salida.",
      timestamp: new Date(Date.now() - 1000 * 60 * 82).toISOString(),
    },
    {
      id: "t2",
      direction: "OUTBOUND",
      content: "Timer identificado. Enviame el evento y el punto de lectura que necesitas modificar.",
      timestamp: new Date(Date.now() - 1000 * 60 * 75).toISOString(),
    },
  ],
};

function initials(name = "") {
  const clean = name || "Cliente";
  return clean
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function humanTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function humanDate(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(date, today)) return "Hoy";
  if (sameDay(date, yesterday)) return "Ayer";
  return date.toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function dateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "sin-fecha";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatJson(value) {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeConversation(item) {
  const last = item.messages?.[0];
  const lastMessage =
    last?.contentType === "IMAGE"
      ? last.content && last.content !== "[Imagen recibida]"
        ? `Imagen: ${last.content}`
        : "Imagen recibida"
      : last?.contentType === "DOCUMENT"
        ? last.mediaFilename
          ? `Documento: ${last.mediaFilename}`
          : "Documento recibido"
        : last?.content || "Sin mensajes recientes";
  return {
    ...item,
    name: item.displayName || item.phone || "Cliente",
    lastMessage,
    lastTimestamp: item.lastMessageAt || last?.timestamp || item.updatedAt,
  };
}

function parseExotimerPhone(phone = "") {
  const match = String(phone).match(/^exotimer:(\d+):(.+)$/);
  if (!match) return null;
  return { competitionId: match[1], userId: match[2] };
}

function groupInboxConversations(items) {
  const grouped = new Map();
  const output = [];

  for (const item of items) {
    const parsed = item.channel === "EXOTIMER" ? parseExotimerPhone(item.phone) : null;
    if (!parsed) {
      output.push(item);
      continue;
    }

    const key = `exotimer-user:${parsed.userId}`;
    const current = grouped.get(key);
    const competitionIds = current?.competitionIds || [];
    const nextCompetitionIds = competitionIds.includes(parsed.competitionId)
      ? competitionIds
      : [...competitionIds, parsed.competitionId];
    const conversationIds = current?.conversationIds || [];
    const nextConversationIds = conversationIds.includes(item.id)
      ? conversationIds
      : [...conversationIds, item.id];
    const latest = !current || new Date(item.lastTimestamp || 0) > new Date(current.lastTimestamp || 0)
      ? item
      : current.latestConversation;

    grouped.set(key, {
      ...(latest || item),
      id: key,
      sourceId: latest?.id || item.id,
      isAggregate: true,
      channel: "EXOTIMER",
      userType: "SYSTEM_USER",
      name: item.name || current?.name || `Usuario ${parsed.userId}`,
      phone: `ExoTimer · Usuario ${parsed.userId}`,
      lastMessage: latest?.lastMessage || item.lastMessage,
      lastTimestamp: latest?.lastTimestamp || item.lastTimestamp,
      status: latest?.status || item.status,
      conversationIds: nextConversationIds,
      competitionIds: nextCompetitionIds.sort((a, b) => Number(a) - Number(b)),
      latestConversation: latest || item,
    });
  }

  return [
    ...output,
    ...Array.from(grouped.values()).map(({ latestConversation, ...item }) => item),
  ].sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0));
}

function actionStatusLabel(status) {
  const labels = {
    EXECUTED: "Ejecutada",
    FAILED: "Fallida",
    PROPOSED: "Pendiente",
    SKIPPED: "Omitida",
  };
  return labels[status] || status || "Sin estado";
}

function summarizeAction(action) {
  if (action.error) return action.error;
  const changed = action.output?.changed;
  if (changed?.after) {
    const target = changed.after.participantName || changed.after.dorsal || changed.after.evento_distancia;
    return target ? `Resultado ${changed.resultId || changed.after.result_id || ""}: ${target}` : "Cambio aplicado en Exotimer.";
  }
  if (action.output?.type) return action.output.type;
  if (action.input?.requestedValue) return `Valor solicitado: ${action.input.requestedValue}`;
  return "Accion registrada por la IA.";
}

function MessageMedia({ message, onPreview }) {
  const [mediaUrl, setMediaUrl] = useState("");

  useEffect(() => {
    if (!["IMAGE", "DOCUMENT"].includes(message.contentType) || !message.mediaId) {
      return undefined;
    }
    let active = true;
    let objectUrl = "";

    apiBlobUrl(`/api/conversations/messages/${message.id}/media`)
      .then((url) => {
        objectUrl = url;
        if (active) setMediaUrl(url);
      })
      .catch(() => {
        if (active) setMediaUrl("");
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [message.id, message.contentType, message.mediaId]);

  if (!["IMAGE", "DOCUMENT"].includes(message.contentType) || !message.mediaId) {
    return null;
  }

  if (message.contentType === "DOCUMENT") {
    return (
      <div className="message-document">
        <a
          href={mediaUrl || undefined}
          download={message.mediaFilename || "documento.pdf"}
          aria-disabled={!mediaUrl}
          title="Descargar documento"
        >
          <FileText size={20} />
          <span>{message.mediaFilename || "Documento PDF"}</span>
        </a>
        {message.mediaAnalysis?.summary && (
          <small>{message.mediaAnalysis.summary}</small>
        )}
      </div>
    );
  }

  return (
    <figure className="message-media">
      <button
        className="message-media-preview"
        type="button"
        onClick={() => onPreview?.({ message, imageUrl: mediaUrl })}
        title="Abrir imagen"
      >
        {mediaUrl ? (
          <img src={mediaUrl} alt={message.content || "Imagen enviada por WhatsApp"} loading="lazy" />
        ) : (
          <span className="message-media-placeholder">Cargando imagen...</span>
        )}
      </button>
      {message.mediaAnalysis?.summary && (
        <figcaption>
          <ImageIcon size={14} />
          {message.mediaAnalysis.summary}
        </figcaption>
      )}
    </figure>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleEmailLogin(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch {
      setError("No se pudo iniciar sesion. Revisa el correo y la contrasena.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark">
          <Zap size={26} />
        </div>
        <div>
          <p className="eyebrow">Finisher Data</p>
          <h1>Atencion y soporte</h1>
          <p className="login-copy">
            Panel interno para atender WhatsApp, clasificar clientes y coordinar acciones de Exotimer.
          </p>
        </div>

        <form className="fake-form" aria-label="Login" onSubmit={handleEmailLogin}>
          <label>
            Correo
            <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
          </label>
          <label>
            Contrasena
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" />
          </label>
          {error && <div className="inline-alert login-error">{error}</div>}
          <button className="primary-action" disabled={loading || !email.trim() || !password}>
            <LockKeyhole size={18} />
            {loading ? "Ingresando..." : "Ingresar"}
          </button>
        </form>

        <div className="login-meta">
          <span>
            <ShieldCheck size={16} />
            Meta Cloud API
          </span>
          <span>
            <Bot size={16} />
            IA activa
          </span>
        </div>
      </section>
    </main>
  );
}

function ConfigurationModal({ open, onClose }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actions, setActions] = useState({});
  const [policies, setPolicies] = useState([]);
  const [filter, setFilter] = useState("TIMER");
  const [loadError, setLoadError] = useState("");
  const [canSave, setCanSave] = useState(false);

  useEffect(() => {
    if (!open) return;
    let canceled = false;
    setLoading(true);
    setLoadError("");

    apiFetch("/api/settings/policies")
      .then((res) => {
        if (!res.ok) throw new Error("No se pudo cargar configuracion");
        return res.json();
      })
      .then((data) => {
        if (canceled) return;
        setActions(data.actions || {});
        setPolicies(Array.isArray(data.policies) ? data.policies : []);
        setCanSave(Boolean(data.canSave));
      })
      .catch(() => {
        if (!canceled) {
          setActions({});
          setPolicies([]);
          setCanSave(false);
          setLoadError("No se pudo cargar la configuracion. Revisa que el backend y la base de datos esten activos.");
        }
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });

    return () => {
      canceled = true;
    };
  }, [open]);

  const visiblePolicies = useMemo(
    () => policies.filter((policy) => policy.userType === filter),
    [policies, filter]
  );

  function updatePolicy(actionName, field, value) {
    setPolicies((current) =>
      current.map((policy) =>
        policy.userType === filter && policy.actionName === actionName
          ? { ...policy, [field]: value }
          : policy
      )
    );
  }

  async function savePolicies() {
    setSaving(true);
    try {
      const res = await apiFetch("/api/settings/policies", {
        method: "PUT",
        body: JSON.stringify({
          policies: policies.map(({ userType, actionName, enabled, requiresHuman, notes }) => ({
            userType,
            actionName,
            enabled,
            requiresHuman,
            notes,
          })),
        }),
      });
      if (!res.ok) throw new Error("No se pudo guardar");
      const data = await res.json();
      setPolicies(data.policies || policies);
      onClose();
    } catch {
      alert("No se pudo guardar la configuracion.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="config-modal">
        <header className="config-header">
          <div>
            <p className="eyebrow">Configuracion</p>
            <h2>Permisos de atencion</h2>
            <p>Define que puede hacer cada tipo de contacto y que requiere intervencion humana.</p>
          </div>
          <button className="icon-button" onClick={onClose} title="Cerrar">
            <ArrowLeft size={18} />
          </button>
        </header>

        <div className="config-body">
          <nav className="config-tabs" aria-label="Tipos de usuario">
            {USER_TYPES.map((type) => (
              <button
                key={type}
                className={filter === type ? "active" : ""}
                onClick={() => setFilter(type)}
              >
                {USER_LABELS[type]}
              </button>
            ))}
          </nav>

          {loading ? (
            <div className="config-empty">Cargando configuracion...</div>
          ) : loadError ? (
            <div className="config-empty">{loadError}</div>
          ) : visiblePolicies.length === 0 ? (
            <div className="config-empty">No hay politicas disponibles para este tipo de usuario.</div>
          ) : (
            <div className="policy-list">
              {visiblePolicies.map((policy) => {
                const action = actions[policy.actionName] || {};
                return (
                  <article key={`${policy.userType}-${policy.actionName}`} className="policy-row">
                    <div className="policy-copy">
                      <strong>{policy.actionName}</strong>
                      <span>{action.description || "Accion de soporte"}</span>
                    </div>
                    <label className="switch-line">
                      <input
                        type="checkbox"
                        checked={Boolean(policy.enabled)}
                        onChange={(event) =>
                          updatePolicy(policy.actionName, "enabled", event.target.checked)
                        }
                      />
                      <span>Habilitada</span>
                    </label>
                    <label className="switch-line">
                      <input
                        type="checkbox"
                        checked={Boolean(policy.requiresHuman)}
                        onChange={(event) =>
                          updatePolicy(policy.actionName, "requiresHuman", event.target.checked)
                        }
                      />
                      <span>Humano</span>
                    </label>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <footer className="config-footer">
          {!canSave && !loadError && (
            <span className="config-note">Modo solo lectura: conecta PostgreSQL para guardar cambios.</span>
          )}
          <button className="secondary-action" onClick={onClose}>Cancelar</button>
          <button className="primary-action compact" onClick={savePolicies} disabled={saving || loading || policies.length === 0 || !canSave}>
            <ShieldCheck size={17} />
            {saving ? "Guardando..." : "Guardar"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function AiActionsModal({ open, onClose, conversation, actions = [] }) {
  const [expandedId, setExpandedId] = useState(null);
  const previousOpenRef = useRef(false);
  const previousConversationIdRef = useRef(null);

  useEffect(() => {
    if (!open) {
      previousOpenRef.current = false;
      return;
    }

    const conversationChanged = previousConversationIdRef.current !== conversation?.id;
    const justOpened = !previousOpenRef.current;
    setExpandedId((current) => {
      if (!actions.length) return null;
      if (!justOpened && !conversationChanged && actions.some((action) => action.id === current)) {
        return current;
      }
      return actions[0].id;
    });

    previousOpenRef.current = true;
    previousConversationIdRef.current = conversation?.id || null;
  }, [open, conversation?.id, actions]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="config-modal actions-modal">
        <header className="config-header">
          <div>
            <p className="eyebrow">Auditoria IA</p>
            <h2>Acciones IA</h2>
            <p>{conversation?.name || "Conversacion"} · {actions.length} acciones registradas</p>
          </div>
          <button className="icon-button" onClick={onClose} title="Cerrar">
            <ArrowLeft size={18} />
          </button>
        </header>

        <div className="actions-modal-body">
          {actions.length === 0 ? (
            <div className="config-empty">Esta conversacion todavia no tiene acciones registradas.</div>
          ) : (
            <div className="action-accordion-list">
              {actions.map((action) => {
                const expanded = expandedId === action.id;
                return (
                  <article key={action.id} className={`action-accordion ${String(action.status || "").toLowerCase()}`}>
                    <button
                      type="button"
                      className="action-accordion-summary"
                      onClick={() => setExpandedId(expanded ? null : action.id)}
                    >
                      <span>
                        <strong>#{action.id} · {action.name}</strong>
                        <small>{summarizeAction(action)}</small>
                      </span>
                      <span className={`action-status ${String(action.status || "").toLowerCase()}`}>
                        {actionStatusLabel(action.status)}
                      </span>
                    </button>

                    {expanded && (
                      <div className="action-accordion-detail">
                        <div className="action-detail-grid">
                          <span>
                            <strong>Usuario</strong>
                            {USER_LABELS[action.userType] || action.userType || "Cliente"}
                          </span>
                          <span>
                            <strong>Fecha</strong>
                            {action.createdAt ? `${humanDate(action.createdAt)} ${humanTime(action.createdAt)}` : "Sin fecha"}
                          </span>
                          <span>
                            <strong>Mensaje</strong>
                            {action.messageId ? `#${action.messageId}` : "No asociado"}
                          </span>
                        </div>

                        {action.error && <div className="action-error">{action.error}</div>}

                        <details open>
                          <summary>Input</summary>
                          <pre>{formatJson(action.input)}</pre>
                        </details>
                        {action.output && (
                          <details>
                            <summary>Output</summary>
                            <pre>{formatJson(action.output)}</pre>
                          </details>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

const EMPTY_CONTACT_FORM = {
  id: null,
  name: "",
  phone: "",
  active: true,
  notes: "",
};

function TopNavigation({ title, activeSection, onOpenMessages, onOpenDirectory, onOpenConfig, onSignOut, compact = false }) {
  return (
    <header className={`topbar ${compact ? "directory-topbar" : ""}`}>
      <div className="topbar-title">
        <div className="brand-mark small">
          <Headphones size={20} />
        </div>
        <div>
          <p className="eyebrow">Finisher Data</p>
          <h1>{title}</h1>
        </div>
      </div>
      <nav className="topbar-actions" aria-label="Navegación principal">
        <button
          className={`status-chip config-trigger nav-trigger ${activeSection === "messages" ? "active" : ""}`}
          type="button"
          onClick={onOpenMessages}
        >
          <MessageCircle size={15} />
          Mensajes
        </button>
        <button
          className={`status-chip config-trigger nav-trigger ${activeSection === "timers" ? "active" : ""}`}
          type="button"
          onClick={() => onOpenDirectory("timers")}
        >
          <UserCog size={15} />
          Timers
        </button>
        <button
          className={`status-chip config-trigger nav-trigger ${activeSection === "photographers" ? "active" : ""}`}
          type="button"
          onClick={() => onOpenDirectory("photographers")}
        >
          <Camera size={15} />
          Fotógrafos
        </button>
        <button
          className={`status-chip config-trigger nav-trigger ${activeSection === "organizers" ? "active" : ""}`}
          type="button"
          onClick={() => onOpenDirectory("organizers")}
        >
          <UsersRound size={15} />
          Organizadores
        </button>
        <button
          className={`status-chip config-trigger nav-trigger ${activeSection === "configuration" ? "active" : ""}`}
          type="button"
          onClick={onOpenConfig}
        >
          <Settings size={15} />
          Configuracion
        </button>
        <button className="secondary-action" type="button" onClick={onSignOut}>
          Salir
        </button>
      </nav>
    </header>
  );
}

function ContactDirectoryPage({ directory, directoryKey, onOpenMessages, onOpenDirectory, onOpenConfig, onSignOut }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [contacts, setContacts] = useState([]);
  const [form, setForm] = useState(EMPTY_CONTACT_FORM);
  const [loadError, setLoadError] = useState("");
  const [formModalOpen, setFormModalOpen] = useState(false);

  const editing = Boolean(form.id);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setLoadError("");
    setForm(EMPTY_CONTACT_FORM);
    setFormModalOpen(false);

    apiFetch(directory.endpoint, { timeoutMs: 10000 })
      .then((res) => {
        if (!res.ok) throw new Error(`No se pudo cargar ${directory.title}`);
        return res.json();
      })
      .then((data) => {
        if (!canceled) setContacts(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!canceled) {
          setContacts([]);
          setLoadError(`No se pudo cargar la lista de ${directory.title}.`);
        }
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });

    return () => {
      canceled = true;
    };
  }, [directory]);

  function updateForm(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function editContact(contact) {
    setForm({
      id: contact.id,
      name: contact.name || "",
      phone: contact.phone || "",
      active: Boolean(contact.active),
      notes: contact.notes || "",
    });
    setFormModalOpen(true);
  }

  function openNewContactModal() {
    setForm(EMPTY_CONTACT_FORM);
    setFormModalOpen(true);
  }

  function closeFormModal() {
    if (saving) return;
    setFormModalOpen(false);
    setForm(EMPTY_CONTACT_FORM);
  }

  async function saveContact(event) {
    event.preventDefault();
    if (!form.name.trim() || !form.phone.trim()) return;

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        active: Boolean(form.active),
        notes: form.notes.trim() || null,
      };
      const res = await apiFetch(editing ? `${directory.endpoint}/${form.id}` : directory.endpoint, {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify(payload),
        timeoutMs: 10000,
      });
      if (!res.ok) throw new Error(`No se pudo guardar ${directory.singular}`);
      const saved = await res.json();
      setContacts((current) => {
        const exists = current.some((contact) => contact.id === saved.id);
        const next = exists
          ? current.map((contact) => (contact.id === saved.id ? saved : contact))
          : [...current, saved];
        return next.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      });
      setFormModalOpen(false);
      setForm(EMPTY_CONTACT_FORM);
    } catch {
      alert(`No se pudo guardar el ${directory.singular}.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="directory-page-shell">
      <TopNavigation
        title={directory.title}
        activeSection={directoryKey}
        onOpenMessages={onOpenMessages}
        onOpenDirectory={onOpenDirectory}
        onOpenConfig={onOpenConfig}
        onSignOut={onSignOut}
        compact
      />

      <section className="directory-panel">
        <header className="config-header">
          <div>
            <p className="eyebrow">{directory.title}</p>
            <h2>Usuarios autorizados</h2>
            <p>{directory.description}</p>
          </div>
        </header>

        <section className="directory-table-section" aria-label={`${directory.title} registrados`}>
          <div className="directory-table-toolbar">
            <strong>{loading ? "Cargando..." : `${contacts.length} ${directory.title}`}</strong>
            <button className="primary-action compact" type="button" onClick={openNewContactModal}>
              <Plus size={17} />
              Agregar nuevo
            </button>
          </div>

          {loadError ? (
            <div className="config-empty">{loadError}</div>
          ) : contacts.length === 0 && !loading ? (
            <div className="config-empty">Todavía no hay {directory.title.toLowerCase()} registrados.</div>
          ) : (
            <div className="directory-table-scroll">
              <table className="directory-table">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Teléfono WhatsApp</th>
                    <th>Notas</th>
                    <th>Estado</th>
                    <th aria-label="Acciones" />
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((contact) => (
                    <tr key={contact.id}>
                      <td><strong>{contact.name}</strong></td>
                      <td>{contact.phone}</td>
                      <td className="directory-notes" title={contact.notes || ""}>{contact.notes || "—"}</td>
                      <td>
                        <span className={`directory-status ${contact.active ? "active" : "inactive"}`}>
                          {contact.active ? "Activo" : "Inactivo"}
                        </span>
                      </td>
                      <td className="directory-row-actions">
                        <button type="button" onClick={() => editContact(contact)} aria-label={`Editar ${contact.name}`}>
                          <Pencil size={15} />
                          Editar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </section>

      {formModalOpen && (
        <div className="modal-backdrop" onClick={closeFormModal}>
          <section
            className="contact-form-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="contact-form-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="config-header">
              <div>
                <p className="eyebrow">{editing ? `Editar ${directory.singular}` : `Nuevo ${directory.singular}`}</p>
                <h2 id="contact-form-title">{editing ? form.name || directory.singular : "Agregar contacto"}</h2>
                <p>Completa los datos del contacto autorizado.</p>
              </div>
              <button className="icon-button" type="button" onClick={closeFormModal} aria-label="Cerrar">
                <X size={18} />
              </button>
            </header>

            <form className="timer-form" onSubmit={saveContact}>
              <label>
                Nombre
                <input
                  autoFocus
                  value={form.name}
                  onChange={(event) => updateForm("name", event.target.value)}
                  placeholder={directory.namePlaceholder}
                />
              </label>

              <label>
                Teléfono WhatsApp
                <input
                  value={form.phone}
                  onChange={(event) => updateForm("phone", event.target.value)}
                  placeholder="+51999999999"
                />
              </label>

              <label>
                Notas
                <textarea
                  value={form.notes}
                  onChange={(event) => updateForm("notes", event.target.value)}
                  placeholder={directory.notesPlaceholder}
                />
              </label>

              <label className="switch-line timer-active">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(event) => updateForm("active", event.target.checked)}
                />
                <span>{directory.activeLabel}</span>
              </label>

              <div className="timer-form-actions">
                <button type="button" className="secondary-action" onClick={closeFormModal}>
                  Cancelar
                </button>
                <button className="primary-action compact" disabled={saving || !form.name.trim() || !form.phone.trim()}>
                  <ShieldCheck size={17} />
                  {saving ? "Guardando..." : "Guardar"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}

function SupportApp({ onOpenMessages, onOpenDirectory, onOpenConfig, onSignOut }) {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [conversationActions, setConversationActions] = useState([]);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [draft, setDraft] = useState("");
  const [loadingList, setLoadingList] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const [sending, setSending] = useState(false);
  const [usingDemo, setUsingDemo] = useState(true);
  const [listError, setListError] = useState("");
  const [pendingActions, setPendingActions] = useState([]);
  const [actionsModalOpen, setActionsModalOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState(null);
  const listLoaded = useRef(false);
  const chatRef = useRef(null);
  const scrollModeRef = useRef("bottom");
  const lastConversationIdRef = useRef(null);
  const lastMessageKeyRef = useRef("");

  function isNearChatBottom() {
    const node = chatRef.current;
    if (!node) return true;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }

  function markScrollIntent(mode = "preserve") {
    scrollModeRef.current = mode === "bottom" || isNearChatBottom() ? "bottom" : "preserve";
  }

  const loadConversations = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoadingList(true);
    setListError("");

    return apiFetch("/api/conversations", { timeoutMs: 10000 })
      .then((res) => {
        if (!res.ok) throw new Error("API no disponible");
        return res.json();
      })
      .then((data) => {
        const normalized = Array.isArray(data) ? groupInboxConversations(data.map(normalizeConversation)) : [];
        setConversations(normalized);
        setUsingDemo(false);
        if (!normalized.length) setMessages([]);
        setSelected((current) => {
          if (!normalized.length) return null;
          if (!current) return isMobileLayout() || listLoaded.current ? null : normalized[0];
          if (String(current.id).startsWith("demo-")) return normalized[0];
          return normalized.find((item) => {
            if (item.id === current.id) return true;
            return item.conversationIds?.includes(current.id) || item.sourceId === current.id;
          }) || normalized[0];
        });
        listLoaded.current = true;
      })
      .catch(() => {
        setConversations(MOCK_CONVERSATIONS.map(normalizeConversation));
        setSelected((current) => current || normalizeConversation(MOCK_CONVERSATIONS[0]));
        setUsingDemo(true);
        setListError("No se pudo conectar con la API. Mostrando datos demo.");
      })
      .finally(() => {
        if (!silent) setLoadingList(false);
      });
  }, []);

  useEffect(() => {
    if ("clearAppBadge" in navigator) {
      navigator.clearAppBadge().catch(() => {});
    }
  }, []);

  useEffect(() => {
    loadConversations();
    const interval = window.setInterval(() => loadConversations({ silent: true }), 15000);

    return () => {
      window.clearInterval(interval);
    };
  }, [loadConversations]);

  useEffect(() => {
    let canceled = false;

    apiFetch("/api/actions?status=PROPOSED")
      .then((res) => {
        if (!res.ok) throw new Error("API no disponible");
        return res.json();
      })
      .then((data) => {
        if (!canceled) setPendingActions(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!canceled) setPendingActions([]);
      });

    return () => {
      canceled = true;
    };
  }, []);

  const loadMessages = useCallback(async (conversation, { silent = false } = {}) => {
    if (!conversation) return;
    if (!silent) setLoadingChat(true);
    markScrollIntent(silent ? "preserve" : "bottom");

    if (String(conversation.id).startsWith("demo-")) {
      setMessages(MOCK_MESSAGES[conversation.id] || []);
      if (!silent) setLoadingChat(false);
      return;
    }

    if (conversation.isAggregate && Array.isArray(conversation.conversationIds)) {
      return Promise.all(
        conversation.conversationIds.map((id) =>
          apiFetch(`/api/conversations/${id}`, { timeoutMs: 10000 }).then((res) => {
            if (!res.ok) throw new Error("No se pudo cargar conversacion");
            return res.json();
          })
        )
      )
        .then((details) => {
          const mergedMessages = details
            .flatMap((detail) => Array.isArray(detail.messages) ? detail.messages : [])
            .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
          const mergedActions = details
            .flatMap((detail) => Array.isArray(detail.actions) ? detail.actions : [])
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
          setMessages(mergedMessages);
          setConversationActions(mergedActions);
        })
        .catch(() => {
          if (!silent) {
            setMessages([]);
            setConversationActions([]);
          }
        })
        .finally(() => {
          if (!silent) setLoadingChat(false);
        });
    }

    return apiFetch(`/api/conversations/${conversation.id}`, { timeoutMs: 10000 })
      .then((res) => {
        if (!res.ok) throw new Error("No se pudo cargar conversacion");
        return res.json();
      })
      .then((data) => {
        setMessages(Array.isArray(data.messages) ? data.messages : []);
        setConversationActions(Array.isArray(data.actions) ? data.actions : []);
      })
      .catch(() => {
        if (!silent) {
          setMessages([]);
          setConversationActions([]);
        }
      })
      .finally(() => {
        if (!silent) setLoadingChat(false);
      });
  }, []);

  useEffect(() => {
    if (!selected) return;
    setConversationActions([]);
    loadMessages(selected);
    const interval = window.setInterval(() => loadMessages(selected, { silent: true }), 8000);

    return () => {
      window.clearInterval(interval);
    };
  }, [loadMessages, selected?.id, selected?.conversationIds?.join(",")]);

  useEffect(() => {
    const node = chatRef.current;
    if (!node) return;

    const conversationChanged = selected?.id !== lastConversationIdRef.current;
    const lastMessage = messages[messages.length - 1];
    const messageKey = lastMessage ? `${lastMessage.id}-${lastMessage.timestamp}` : "";
    const hasNewTailMessage = messageKey && messageKey !== lastMessageKeyRef.current;

    if (conversationChanged || (hasNewTailMessage && scrollModeRef.current === "bottom")) {
      node.scrollTop = node.scrollHeight;
    }

    lastConversationIdRef.current = selected?.id || null;
    lastMessageKeyRef.current = messageKey;
  }, [messages, selected?.id]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return conversations.filter((item) => {
      const matchesType = typeFilter === "ALL" || item.userType === typeFilter;
      const text = `${item.name} ${item.phone} ${item.lastMessage}`.toLowerCase();
      return matchesType && (!term || text.includes(term));
    });
  }, [conversations, query, typeFilter]);

  const groupedConversations = useMemo(() => {
    const output = [];
    let lastDateKey = "";
    for (const conversation of filtered) {
      const key = dateKey(conversation.lastTimestamp);
      const label = humanDate(conversation.lastTimestamp);
      if (key !== lastDateKey) {
        output.push({ separator: true, id: `conversation-sep-${key}-${output.length}`, label });
        lastDateKey = key;
      }
      output.push(conversation);
    }
    return output;
  }, [filtered]);

  const groupedMessages = useMemo(() => {
    const output = [];
    let lastDateKey = "";
    for (const message of messages) {
      const key = dateKey(message.timestamp);
      const label = humanDate(message.timestamp);
      if (key !== lastDateKey) {
        output.push({ separator: true, id: `sep-${key}-${output.length}`, label });
        lastDateKey = key;
      }
      output.push(message);
    }
    return output;
  }, [messages]);

  async function handleSend() {
    const content = draft.trim();
    if (!content || !selected) return;
    if (selected.isAggregate) return;

    setSending(true);
    setDraft("");
    markScrollIntent("bottom");

    const optimistic = {
      id: `local-${Date.now()}`,
      direction: "OUTBOUND",
      content,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    if (String(selected.id).startsWith("demo-")) {
      setSending(false);
      return;
    }

    try {
      const res = await apiFetch(`/api/conversations/${selected.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error("No se pudo enviar");
    } catch {
      setMessages((prev) =>
        prev.map((item) =>
          item.id === optimistic.id ? { ...item, failed: true } : item
        )
      );
    } finally {
      setSending(false);
    }
  }

  async function handleActionDecision(actionId, decision) {
    const endpoint = decision === "execute" ? "execute" : "skip";
    try {
      const res = await apiFetch(`/api/actions/${actionId}/${endpoint}`, {
        method: "POST",
        body: JSON.stringify({
          confirmedBy: "support-panel",
          reason: decision === "skip" ? "Omitido desde panel de soporte" : undefined,
        }),
      });
      if (!res.ok) throw new Error("No se pudo procesar la accion");
      setPendingActions((current) => current.filter((item) => item.id !== actionId));
    } catch {
      alert("No se pudo procesar la accion.");
    }
  }

  return (
    <main className="app-shell">
      <TopNavigation
        title="Centro de soporte"
        activeSection="messages"
        onOpenMessages={onOpenMessages}
        onOpenDirectory={onOpenDirectory}
        onOpenConfig={onOpenConfig}
        onSignOut={onSignOut}
      />

      {pendingActions.length > 0 && (
        <section className="actions-strip" aria-label="Acciones pendientes">
          <div className="actions-strip-header">
            <ClipboardCheck size={18} />
            <strong>Confirmaciones pendientes</strong>
          </div>
          <div className="actions-strip-list">
            {pendingActions.slice(0, 3).map((action) => (
              <article key={action.id} className="pending-action">
                <div>
                  <strong>{action.name}</strong>
                  <span>
                    {action.conversation?.displayName || action.conversation?.phone || "Cliente"} · {USER_LABELS[action.userType]}
                  </span>
                </div>
                <div className="pending-action-buttons">
                  <button onClick={() => handleActionDecision(action.id, "skip")}>Omitir</button>
                  <button onClick={() => handleActionDecision(action.id, "execute")}>Ejecutar</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="inbox">
        <aside className={`conversation-pane ${selected ? "hide-mobile" : ""}`}>
          <div className="pane-header">
            <div>
              <h2>Mensajes</h2>
              <p>
                {loadingList
                  ? "Cargando..."
                  : usingDemo
                    ? "Datos demo"
                    : `${filtered.length} reales`}
              </p>
            </div>
          </div>

          {listError && <div className="inline-alert">{listError}</div>}

          <div className="search-box">
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar cliente o telefono"
            />
            <button
              className="filter-button mobile-only"
              type="button"
              onClick={() => setFiltersOpen(true)}
              title="Filtros"
            >
              <Filter size={18} />
            </button>
          </div>

          <div className="type-tabs">
            {["ALL", "SYSTEM_USER", "TIMER", "BUYER", "ORGANIZER", "ATHLETE"].map((type) => (
              <button
                key={type}
                className={typeFilter === type ? "active" : ""}
                onClick={() => setTypeFilter(type)}
              >
                {type === "ALL" ? "Todos" : USER_LABELS[type]}
              </button>
            ))}
          </div>

          <div className="conversation-list">
            {groupedConversations.map((item) =>
              item.separator ? (
                <div className="conversation-date-separator" key={item.id}>
                  <span>{item.label}</span>
                </div>
              ) : (
                <button
                  key={item.id}
                  className={`conversation-item ${selected?.id === item.id ? "selected" : ""}`}
                  onClick={() => setSelected(item)}
                >
                  <span className={`avatar ${item.userType.toLowerCase()}`}>
                    {initials(item.name)}
                  </span>
                  <span className="conversation-copy">
                    <span className="conversation-title">
                      <strong>{item.name}</strong>
                      <time>{item.lastTimestamp ? humanTime(item.lastTimestamp) : ""}</time>
                    </span>
                    <span className="conversation-subtitle">{item.lastMessage}</span>
                    <span className="conversation-meta">
                      <span>{USER_LABELS[item.userType] || "Cliente"}</span>
                      {item.isAggregate && <span>{item.competitionIds.length} competencias</span>}
                      {item.status === "WAITING_HUMAN" && <span>Atencion humana</span>}
                    </span>
                  </span>
                </button>
              )
            )}
          </div>
        </aside>

        <section className={`chat-pane ${selected ? "" : "empty"} ${!selected ? "hide-mobile" : ""}`}>
          {!selected ? (
            <div className="empty-state">
              <MessageCircle size={36} />
              <h2>Selecciona una conversacion</h2>
              <p>El historial, la clasificacion IA y la respuesta manual apareceran aqui.</p>
            </div>
          ) : (
            <>
              <div className="chat-header">
                <button className="icon-button mobile-only" onClick={() => setSelected(null)} title="Volver">
                  <ArrowLeft size={19} />
                </button>
                <span className={`avatar ${selected.userType.toLowerCase()}`}>
                  {initials(selected.name)}
                </span>
                <div>
                  <h2>{selected.name}</h2>
                  <p>
                    {selected.phone} - {USER_LABELS[selected.userType]}
                    {selected.isAggregate && selected.competitionIds?.length
                      ? ` - Competencias ${selected.competitionIds.join(", ")}`
                      : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className="ai-badge action-audit-trigger"
                  onClick={() => setActionsModalOpen(true)}
                  title="Ver acciones IA"
                >
                  <Eye size={15} />
                  Acciones IA
                  {conversationActions.length > 0 && <strong>{conversationActions.length}</strong>}
                </button>
              </div>

              <div className="messages" ref={chatRef}>
                {loadingChat ? (
                  <div className="loading-lines">
                    <span />
                    <span />
                    <span />
                  </div>
                ) : (
                  groupedMessages.map((message) =>
                    message.separator ? (
                      <div className="date-separator" key={message.id}>
                        <span>{message.label}</span>
                      </div>
                    ) : (
                      <article
                        key={message.id}
                        className={`message ${message.direction === "OUTBOUND" ? "outbound" : "inbound"} ${["IMAGE", "DOCUMENT"].includes(message.contentType) ? "has-media" : ""}`}
                      >
                        <MessageMedia message={message} onPreview={setPreviewImage} />
                        {message.content &&
                          message.content !== "[Imagen recibida]" &&
                          !message.content.startsWith("[Documento recibido") && (
                            <p>{message.content}</p>
                          )}
                        <time>
                          {humanTime(message.timestamp)}
                          {message.failed ? " · no enviado" : ""}
                        </time>
                      </article>
                    )
                  )
                )}
              </div>

              <div className="composer">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={selected.isAggregate}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={selected.isAggregate ? "Vista agrupada: responde desde la conversación de ExoTimer." : "Escribe una respuesta..."}
                />
                <button className="send-button" onClick={handleSend} disabled={sending || selected.isAggregate || !draft.trim()}>
                  <Send size={18} />
                </button>
              </div>
            </>
          )}
        </section>
      </section>

      <AiActionsModal
        open={actionsModalOpen}
        onClose={() => setActionsModalOpen(false)}
        conversation={selected}
        actions={conversationActions}
      />
      {filtersOpen && (
        <div className="filter-drawer-backdrop mobile-only" role="dialog" aria-modal="true" onClick={() => setFiltersOpen(false)}>
          <section className="filter-drawer" onClick={(event) => event.stopPropagation()}>
            <div className="filter-drawer-handle" />
            <header>
              <div>
                <p className="eyebrow">Filtros</p>
                <h2>Conversaciones</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setFiltersOpen(false)} title="Cerrar">
                <ArrowLeft size={18} />
              </button>
            </header>
            <div className="filter-options">
              {["ALL", "SYSTEM_USER", "TIMER", "BUYER", "ORGANIZER", "ATHLETE"].map((type) => (
                <button
                  key={type}
                  className={typeFilter === type ? "active" : ""}
                  onClick={() => {
                    setTypeFilter(type);
                    setFiltersOpen(false);
                  }}
                >
                  {type === "ALL" ? "Todos" : USER_LABELS[type]}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
      {previewImage && (
        <div className="image-preview-backdrop" role="dialog" aria-modal="true" onClick={() => setPreviewImage(null)}>
          <figure className="image-preview" onClick={(event) => event.stopPropagation()}>
            <img src={previewImage.imageUrl} alt={previewImage.message.content || "Imagen enviada por WhatsApp"} />
            <figcaption>
              <span>{previewImage.message.mediaAnalysis?.summary || "Imagen enviada por WhatsApp"}</span>
              <button type="button" onClick={() => setPreviewImage(null)}>Cerrar</button>
            </figcaption>
          </figure>
        </div>
      )}
    </main>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [directoryKey, setDirectoryKey] = useState(
    () => new URLSearchParams(window.location.search).get("directory")
  );
  const [configOpen, setConfigOpen] = useState(false);
  const directory = CONTACT_DIRECTORIES[directoryKey];

  useEffect(() => {
    setAuthTokenProvider(async () => {
      if (!auth.currentUser) return null;
      return auth.currentUser.getIdToken();
    });

    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setCheckingAuth(false);
    });
  }, []);

  useEffect(() => {
    function handlePopState() {
      setDirectoryKey(new URLSearchParams(window.location.search).get("directory"));
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function navigateToDirectory(nextDirectoryKey) {
    const url = new URL(window.location.href);
    if (nextDirectoryKey) {
      url.searchParams.set("directory", nextDirectoryKey);
    } else {
      url.searchParams.delete("directory");
    }
    window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
    setDirectoryKey(nextDirectoryKey || null);
  }

  if (checkingAuth) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="brand-mark">
            <Zap size={26} />
          </div>
          <p className="login-copy">Validando sesion...</p>
        </section>
      </main>
    );
  }

  return user ? (
    <>
      {directory ? (
        <ContactDirectoryPage
          directory={directory}
          directoryKey={directoryKey}
          onOpenMessages={() => navigateToDirectory(null)}
          onOpenDirectory={navigateToDirectory}
          onOpenConfig={() => setConfigOpen(true)}
          onSignOut={() => signOut(auth)}
        />
      ) : (
        <SupportApp
          onOpenMessages={() => navigateToDirectory(null)}
          onOpenDirectory={navigateToDirectory}
          onOpenConfig={() => setConfigOpen(true)}
          onSignOut={() => signOut(auth)}
        />
      )}
      <ConfigurationModal open={configOpen} onClose={() => setConfigOpen(false)} />
    </>
  ) : (
    <LoginScreen />
  );
}

createRoot(document.getElementById("root")).render(<App />);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("No se pudo registrar el service worker:", error);
    });
  });
}
