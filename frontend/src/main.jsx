import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Headphones,
  LockKeyhole,
  MessageCircle,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  UserCog,
  UserRound,
  Zap,
} from "lucide-react";
import { apiFetch } from "./utils/api.js";
import "./styles.css";

const USER_LABELS = {
  TIMER: "Timer",
  BUYER: "Comprador",
  ORGANIZER: "Organizador",
  ATHLETE: "Atleta",
  UNKNOWN: "Sin clasificar",
};

const USER_TYPES = ["TIMER", "ORGANIZER", "ATHLETE", "BUYER", "UNKNOWN"];

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
  return date.toLocaleDateString();
}

function normalizeConversation(item) {
  const last = item.messages?.[0];
  return {
    ...item,
    name: item.displayName || item.phone || "Cliente",
    lastMessage: last?.content || "Sin mensajes recientes",
    lastTimestamp: item.lastMessageAt || last?.timestamp || item.updatedAt,
  };
}

function LoginScreen({ onContinue }) {
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

        <div className="fake-form" aria-label="Login simulado">
          <label>
            Correo
            <input value="soporte@finisherdata.com" readOnly />
          </label>
          <label>
            Contrasena
            <input value="********" type="password" readOnly />
          </label>
          <button className="primary-action" onClick={onContinue}>
            <LockKeyhole size={18} />
            Continuar
          </button>
        </div>

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

const EMPTY_TIMER_FORM = {
  id: null,
  name: "",
  phone: "",
  active: true,
  notes: "",
};

function TimersModal({ open, onClose }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [timers, setTimers] = useState([]);
  const [form, setForm] = useState(EMPTY_TIMER_FORM);
  const [loadError, setLoadError] = useState("");

  const editing = Boolean(form.id);

  useEffect(() => {
    if (!open) return;
    let canceled = false;
    setLoading(true);
    setLoadError("");

    apiFetch("/api/timers", { timeoutMs: 10000 })
      .then((res) => {
        if (!res.ok) throw new Error("No se pudo cargar timers");
        return res.json();
      })
      .then((data) => {
        if (!canceled) setTimers(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!canceled) {
          setTimers([]);
          setLoadError("No se pudo cargar la lista de Timers.");
        }
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });

    return () => {
      canceled = true;
    };
  }, [open]);

  function updateForm(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function editTimer(timer) {
    setForm({
      id: timer.id,
      name: timer.name || "",
      phone: timer.phone || "",
      active: Boolean(timer.active),
      notes: timer.notes || "",
    });
  }

  function resetForm() {
    setForm(EMPTY_TIMER_FORM);
  }

  async function saveTimer(event) {
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
      const res = await apiFetch(editing ? `/api/timers/${form.id}` : "/api/timers", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify(payload),
        timeoutMs: 10000,
      });
      if (!res.ok) throw new Error("No se pudo guardar Timer");
      const saved = await res.json();
      setTimers((current) => {
        const exists = current.some((timer) => timer.id === saved.id);
        const next = exists
          ? current.map((timer) => (timer.id === saved.id ? saved : timer))
          : [...current, saved];
        return next.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      });
      resetForm();
    } catch {
      alert("No se pudo guardar el Timer.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="config-modal timers-modal">
        <header className="config-header">
          <div>
            <p className="eyebrow">Timers</p>
            <h2>Usuarios autorizados</h2>
            <p>Registra los numeros que se identificaran automaticamente como Timer.</p>
          </div>
          <button className="icon-button" onClick={onClose} title="Cerrar">
            <ArrowLeft size={18} />
          </button>
        </header>

        <div className="timers-body">
          <section className="timer-list" aria-label="Timers registrados">
            <div className="timer-list-header">
              <strong>{loading ? "Cargando..." : `${timers.length} Timers`}</strong>
              <button type="button" onClick={resetForm}>
                Nuevo
              </button>
            </div>

            {loadError ? (
              <div className="config-empty">{loadError}</div>
            ) : timers.length === 0 && !loading ? (
              <div className="config-empty">Todavia no hay Timers registrados.</div>
            ) : (
              <div className="timer-list-scroll">
                {timers.map((timer) => (
                  <button
                    key={timer.id}
                    className={`timer-item ${form.id === timer.id ? "active" : ""}`}
                    onClick={() => editTimer(timer)}
                  >
                    <span>
                      <strong>{timer.name}</strong>
                      <small>{timer.phone}</small>
                    </span>
                    <em>{timer.active ? "Activo" : "Inactivo"}</em>
                  </button>
                ))}
              </div>
            )}
          </section>

          <form className="timer-form" onSubmit={saveTimer}>
            <div>
              <p className="eyebrow">{editing ? "Editar Timer" : "Nuevo Timer"}</p>
              <h3>{editing ? form.name || "Timer" : "Agregar contacto"}</h3>
            </div>

            <label>
              Nombre
              <input
                value={form.name}
                onChange={(event) => updateForm("name", event.target.value)}
                placeholder="Timer Norte"
              />
            </label>

            <label>
              Telefono WhatsApp
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
                placeholder="Zona, empresa o eventos que suele operar"
              />
            </label>

            <label className="switch-line timer-active">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(event) => updateForm("active", event.target.checked)}
              />
              <span>Timer activo</span>
            </label>

            <div className="timer-form-actions">
              <button type="button" className="secondary-action" onClick={resetForm}>
                Limpiar
              </button>
              <button className="primary-action compact" disabled={saving || !form.name.trim() || !form.phone.trim()}>
                <ShieldCheck size={17} />
                {saving ? "Guardando..." : "Guardar"}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}

function SupportApp({ onBack }) {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [draft, setDraft] = useState("");
  const [loadingList, setLoadingList] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const [sending, setSending] = useState(false);
  const [usingDemo, setUsingDemo] = useState(true);
  const [listError, setListError] = useState("");
  const [pendingActions, setPendingActions] = useState([]);
  const [configOpen, setConfigOpen] = useState(false);
  const [timersOpen, setTimersOpen] = useState(false);
  const listLoaded = useRef(false);
  const chatRef = useRef(null);

  const loadConversations = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoadingList(true);
    setListError("");

    return apiFetch("/api/conversations", { timeoutMs: 10000 })
      .then((res) => {
        if (!res.ok) throw new Error("API no disponible");
        return res.json();
      })
      .then((data) => {
        const normalized = Array.isArray(data) ? data.map(normalizeConversation) : [];
        setConversations(normalized);
        setUsingDemo(false);
        if (!normalized.length) setMessages([]);
        setSelected((current) => {
          if (!normalized.length) return null;
          if (!current || String(current.id).startsWith("demo-")) return normalized[0];
          return normalized.find((item) => item.id === current.id) || normalized[0];
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

  const loadMessages = useCallback(async (conversation) => {
    if (!conversation) return;
    setLoadingChat(true);

    if (String(conversation.id).startsWith("demo-")) {
      setMessages(MOCK_MESSAGES[conversation.id] || []);
      setLoadingChat(false);
      return;
    }

    return apiFetch(`/api/conversations/${conversation.id}`, { timeoutMs: 10000 })
      .then((res) => {
        if (!res.ok) throw new Error("No se pudo cargar conversacion");
        return res.json();
      })
      .then((data) => {
        setMessages(Array.isArray(data.messages) ? data.messages : []);
      })
      .catch(() => {
        setMessages([]);
      })
      .finally(() => {
        setLoadingChat(false);
      });
  }, []);

  useEffect(() => {
    if (!selected) return;
    loadMessages(selected);
    const interval = window.setInterval(() => loadMessages(selected), 8000);

    return () => {
      window.clearInterval(interval);
    };
  }, [loadMessages, selected]);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, selected]);

  const stats = useMemo(() => {
    const total = conversations.length;
    const waiting = conversations.filter((item) => item.status === "WAITING_HUMAN").length;
    const ai = conversations.filter((item) => item.userType !== "UNKNOWN").length;
    return { total, waiting, ai, pending: pendingActions.length };
  }, [conversations, pendingActions]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return conversations.filter((item) => {
      const matchesType = typeFilter === "ALL" || item.userType === typeFilter;
      const text = `${item.name} ${item.phone} ${item.lastMessage}`.toLowerCase();
      return matchesType && (!term || text.includes(term));
    });
  }, [conversations, query, typeFilter]);

  const groupedMessages = useMemo(() => {
    const output = [];
    let lastDate = "";
    for (const message of messages) {
      const label = humanDate(message.timestamp);
      if (label !== lastDate) {
        output.push({ separator: true, id: `sep-${label}`, label });
        lastDate = label;
      }
      output.push(message);
    }
    return output;
  }, [messages]);

  async function handleSend() {
    const content = draft.trim();
    if (!content || !selected) return;

    setSending(true);
    setDraft("");

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
      <header className="topbar">
        <div className="topbar-title">
          <button className="icon-button mobile-only" onClick={onBack} title="Volver">
            <ArrowLeft size={19} />
          </button>
          <div className="brand-mark small">
            <Headphones size={20} />
          </div>
          <div>
            <p className="eyebrow">Finisher Data</p>
            <h1>Centro de soporte</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="status-chip config-trigger" onClick={() => setTimersOpen(true)}>
            <UserCog size={15} />
            Timers
          </button>
          <button className="status-chip config-trigger" onClick={() => setConfigOpen(true)}>
            <Settings size={15} />
            Configuracion
          </button>
          <button className="secondary-action desktop-only" onClick={onBack}>
            Salir
          </button>
        </div>
      </header>

      <section className="metrics-row" aria-label="Resumen">
        <div>
          <MessageCircle size={18} />
          <strong>{stats.total}</strong>
          <span>Conversaciones</span>
        </div>
        <div>
          <Sparkles size={18} />
          <strong>{stats.ai}</strong>
          <span>Clasificadas</span>
        </div>
        <div>
          <Clock3 size={18} />
          <strong>{stats.waiting}</strong>
          <span>Requieren humano</span>
        </div>
        <div>
          <ClipboardCheck size={18} />
          <strong>{stats.pending}</strong>
          <span>Confirmaciones</span>
        </div>
      </section>

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
          </div>

          <div className="type-tabs">
            {["ALL", "TIMER", "BUYER", "ORGANIZER", "ATHLETE"].map((type) => (
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
            {filtered.map((item) => (
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
                    {item.status === "WAITING_HUMAN" && <span>Atencion humana</span>}
                  </span>
                </span>
              </button>
            ))}
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
                  <p>{selected.phone} · {USER_LABELS[selected.userType]}</p>
                </div>
                <span className="ai-badge">
                  <CheckCircle2 size={15} />
                  IA
                </span>
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
                        {message.label}
                      </div>
                    ) : (
                      <article
                        key={message.id}
                        className={`message ${message.direction === "OUTBOUND" ? "outbound" : "inbound"}`}
                      >
                        <p>{message.content}</p>
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
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="Escribe una respuesta..."
                />
                <button className="send-button" onClick={handleSend} disabled={sending || !draft.trim()}>
                  <Send size={18} />
                </button>
              </div>
            </>
          )}
        </section>
      </section>

      <TimersModal open={timersOpen} onClose={() => setTimersOpen(false)} />
      <ConfigurationModal open={configOpen} onClose={() => setConfigOpen(false)} />
    </main>
  );
}

function App() {
  const [screen, setScreen] = useState("login");
  return screen === "login" ? (
    <LoginScreen onContinue={() => setScreen("support")} />
  ) : (
    <SupportApp onBack={() => setScreen("login")} />
  );
}

createRoot(document.getElementById("root")).render(<App />);
