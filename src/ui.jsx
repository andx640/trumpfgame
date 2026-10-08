// Gemeinsame Bausteine der Oberfläche: Knöpfe, Auswahlschalter, Eingabefelder, Seitengerüst, Fenster und Meldungen.
// Jede Seite setzt sich aus diesen Teilen zusammen, damit überall dieselben Größen, Abstände und Farben gelten.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";

function cx(...names) {
  return names.filter(Boolean).join(" ");
}

/* ===== Knöpfe ===== */

// variant: primary (Hauptaktion, eine pro Bereich) | secondary | ghost | danger
// size: sm | md | lg
export function Button({ variant = "secondary", size = "md", block = false, icon = null, iconStart = null, className, type = "button", children, ...props }) {
  return (
    <button type={type} className={cx("btn", `btn-${variant}`, size !== "md" && `btn-${size}`, block && "btn-block", className)} {...props}>
      {iconStart}
      {children !== undefined && children !== null && <span className="btn-label">{children}</span>}
      {icon}
    </button>
  );
}

// Runder Knopf nur mit Symbol. label ist Pflicht (Screenreader und Tooltip).
export function IconButton({ label, variant = "ghost", size = "md", className, children, ...props }) {
  return (
    <button type="button" className={cx("btn", `btn-${variant}`, "btn-icon", size !== "md" && `btn-${size}`, className)} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

/* ===== Auswahlschalter (ersetzt Tabs, Radiogruppen und Optionskacheln) ===== */

// options: [{ value, label, hint? }]
export function Segmented({ label, options, value, onChange, disabled = false, className }) {
  return (
    <div className={cx("segmented", className)} role="radiogroup" aria-label={label} style={{ "--count": options.length }}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            className="segment"
            disabled={disabled}
            onClick={() => !selected && onChange?.(option.value)}
            key={String(option.value)}
          >
            <span>{option.label}</span>
            {option.hint && <small>{option.hint}</small>}
          </button>
        );
      })}
    </div>
  );
}

/* ===== Formularfelder ===== */

// Beschriftetes Feld. Bei Eingaben wird das Label mit dem Feld verknüpft, sonst beschriftet es die Gruppe.
export function Field({ label, htmlFor, hint, children }) {
  const id = useId();
  return (
    <div className="field" role={htmlFor ? undefined : "group"} aria-labelledby={htmlFor ? undefined : id}>
      {htmlFor ? <label className="field-label" htmlFor={htmlFor}>{label}</label> : <span className="field-label" id={id}>{label}</span>}
      {children}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

/* ===== Verbindungsstatus und Seitengerüst ===== */

export const ConnectionContext = createContext(true);

function ConnectionStatus() {
  const connected = useContext(ConnectionContext);
  return (
    <span className={cx("status-pill", connected ? "is-online" : "is-offline")} role="status">
      <i aria-hidden="true" />
      {connected ? "Live" : "Offline"}
    </span>
  );
}

export function Brand() {
  return (
    <span className="brand" role="img" aria-label="Andi Trumpf">
      <LogoMark />
      <span className="brand-text" aria-hidden="true">
        <b>ANDI</b>
        <span>TRUMPF</span>
      </span>
    </span>
  );
}

// Obere Leiste jeder Unterseite: links Zurück, Mitte Logo, rechts Status und seitenbezogene Aktionen.
export function TopBar({ onBack, backLabel = "Zurück", start = null, actions = null }) {
  return (
    <header className="topbar">
      <div className="topbar-start">
        {start}
        {onBack && (
          <Button variant="secondary" size="sm" onClick={onBack} iconStart={<BackIcon />}>
            {backLabel}
          </Button>
        )}
      </div>
      <Brand />
      <div className="topbar-end">
        {actions}
        <ConnectionStatus />
      </div>
    </header>
  );
}

// Einheitlicher Seitenaufbau: Leiste, Kopf (Rubrik, Titel, Einleitung), Inhalt.
// width: narrow (Formulare, Listen) | wide (Raster, Lobby). start/actions: zusätzliche Inhalte links/rechts in der Leiste.
export function Page({ eyebrow, title, lead, onBack, backLabel, start, actions, width = "narrow", className, children }) {
  return (
    <>
      <TopBar onBack={onBack} backLabel={backLabel} start={start} actions={actions} />
      <section className={cx("page", `page-${width}`, className)}>
        <header className="page-head">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1 className="page-title">{title}</h1>
          {lead && <div className="page-lead">{lead}</div>}
        </header>
        <div className="page-body">{children}</div>
      </section>
    </>
  );
}

// Inhaltskarte mit optionaler Überschrift und Zusatz rechts daneben
export function Card({ title, meta, className, children, as: Tag = "section" }) {
  return (
    <Tag className={cx("card", className)}>
      {(title || meta) && (
        <div className="card-head">
          {title && <h2 className="card-title">{title}</h2>}
          {meta && <span className="card-meta">{meta}</span>}
        </div>
      )}
      {children}
    </Tag>
  );
}

// Hinweiskasten. tone: neutral | accent | success | danger
export function Note({ tone = "neutral", icon = null, className, children, ...props }) {
  return (
    <div className={cx("note", `note-${tone}`, className)} {...props}>
      {icon}
      <div>{children}</div>
    </div>
  );
}

export function Loading({ children = "Lädt …" }) {
  return (
    <p className="loading" role="status">
      <Spinner /> {children}
    </p>
  );
}

export function EmptyState({ children }) {
  return <p className="empty-state">{children}</p>;
}

/* ===== Fenster ===== */

// Modales Fenster: Escape und Klick daneben schließen, Fokus wandert hinein und danach zurück, die Seite dahinter scrollt nicht.
export function Modal({ eyebrow, title, onClose, size = "md", footer = null, children }) {
  const panelRef = useRef(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement;
    panelRef.current?.focus();
    const onKey = (event) => event.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={cx("modal", `modal-${size}`)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2 className="modal-title" id={titleId}>{title}</h2>
          </div>
          <IconButton label="Schließen" variant="secondary" onClick={onClose}><CloseIcon /></IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/* ===== Meldungen (Toasts) ===== */
// Kurze Hinweise erscheinen oben und verschwinden nach wenigen Sekunden von selbst.
// Solange der Zeiger darauf liegt oder sie den Fokus haben, bleiben sie stehen.

const ToastContext = createContext(() => {});

export function useToast() {
  return useContext(ToastContext);
}

const TOAST_MS = { info: 4000, success: 3500, error: 5000 };
const MAX_TOASTS = 3;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((toast) => toast.id !== id)), []);

  // notify("Text") oder notify("Text", { type: "error" | "success" | "info", title, duration, actions: [{ label, onClick, variant }] })
  const notify = useCallback((message, options = {}) => {
    if (!message) return;
    const type = options.type || "info";
    const toast = { id: nextId.current++, message, type, title: options.title, actions: options.actions || [], duration: options.duration ?? TOAST_MS[type] };
    setToasts((list) => {
      // dieselbe Meldung nicht doppelt stapeln, sondern neu starten
      const rest = list.filter((entry) => entry.message !== message || entry.title !== toast.title);
      return [...rest, toast].slice(-MAX_TOASTS);
    });
    return toast.id;
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toast-region" aria-live="polite">
        {toasts.map((toast) => <Toast toast={toast} onDismiss={dismiss} key={toast.id} />)}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ toast, onDismiss }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.duration);
  const startedAt = useRef(0);

  useEffect(() => {
    if (paused) return undefined;
    startedAt.current = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(800, remaining.current - (Date.now() - startedAt.current));
    };
  }, [paused, toast.id, onDismiss]);

  const close = () => onDismiss(toast.id);

  return (
    <div
      className={cx("toast", `toast-${toast.type}`, paused && "is-paused")}
      role={toast.type === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="toast-copy">
        {toast.title && <strong>{toast.title}</strong>}
        <span>{toast.message}</span>
      </div>
      {toast.actions.map((action) => (
        <Button
          size="sm"
          variant={action.variant || "primary"}
          onClick={() => {
            action.onClick();
            close();
          }}
          key={action.label}
        >
          {action.label}
        </Button>
      ))}
      <IconButton label="Meldung schließen" size="sm" onClick={close}><CloseIcon /></IconButton>
      <i className="toast-timer" style={{ animationDuration: `${toast.duration}ms` }} aria-hidden="true" />
    </div>
  );
}

/* ===== Symbole ===== */

export function LogoMark() {
  return <svg className="logo-mark" viewBox="0 0 42 42" aria-hidden="true"><path d="M5 8h21l11 9-11 17H5l11-13L5 8Z" /><path d="M17 15h10l4 4-7 9H13l6-7-2-6Z" /></svg>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

function StrokeIcon({ children }) {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{children}</svg>;
}

export function ArrowIcon() {
  return <StrokeIcon><path d="M5 12h14M13 6l6 6-6 6" /></StrokeIcon>;
}

export function BackIcon() {
  return <StrokeIcon><path d="M19 12H5M11 6l-6 6 6 6" /></StrokeIcon>;
}

export function CloseIcon() {
  return <StrokeIcon><path d="M6 6l12 12M18 6 6 18" /></StrokeIcon>;
}

export function CheckIcon() {
  return <StrokeIcon><path d="m5 12 4.5 4.5L19 7" /></StrokeIcon>;
}

export function CopyIcon() {
  return <StrokeIcon><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></StrokeIcon>;
}

export function PlusIcon() {
  return <StrokeIcon><path d="M12 5v14M5 12h14" /></StrokeIcon>;
}

export function SendIcon() {
  return <StrokeIcon><path d="M4 12h15M13 6l6 6-6 6" /></StrokeIcon>;
}

export function FlagIcon() {
  return <StrokeIcon><path d="M5 21V4m0 1c5-3 8 3 14 0v9c-6 3-9-3-14 0" /></StrokeIcon>;
}

export function ShieldIcon() {
  return <StrokeIcon><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-5" /></StrokeIcon>;
}

export function InfoIcon() {
  return <StrokeIcon><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></StrokeIcon>;
}

export function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="icon user-icon">
      <circle cx="12" cy="8" r="4" fill="currentColor" stroke="none" />
      <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SoundIcon({ on }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" stroke="none" />
      {on ? <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" /> : <path d="m16 9 5 6m0-6-5 6" />}
    </svg>
  );
}

export function ChatIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" fill="currentColor" stroke="none" />
    </svg>
  );
}
