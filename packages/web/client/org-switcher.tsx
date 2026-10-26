import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { message, type Org } from "./layout.js";
import { api, saveOrg } from "./session.js";

const MAX_ORG_NAME = 80;

/**
 * The header's org switcher: the current org's name as a button, and a menu of the user's orgs with a New org form
 * under them. Choosing an org, or making one, switches to it and reloads the page's data.
 */
export function OrgSwitcher({ orgs, current, reload }: { orgs: Org[]; current: Org; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  function close(refocus: boolean) {
    setOpen(false);
    setError(undefined);
    if (refocus) button.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const m = menu.current;
    (
      m?.querySelector<HTMLElement>('[aria-current="page"]') ?? m?.querySelector<HTMLElement>("[role=menuitem]")
    )?.focus();
  }, [open]);

  const inForm = () => !!menu.current?.querySelector("form")?.contains(document.activeElement);

  function keys(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      return close(true);
    }
    // Tab leaves the menu, except between the New org input and its button.
    if (e.key === "Tab") return inForm() ? undefined : close(false);
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    if (!items.length) return;
    if (inForm()) {
      // Home and End belong to the input's caret; Up goes back to the list.
      if (e.key !== "ArrowUp") return;
      e.preventDefault();
      return items[items.length - 1]?.focus();
    }
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" && at === items.length - 1) return menu.current?.querySelector("input")?.focus();
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? at + 1 : at - 1;
    items[(next + items.length) % items.length]?.focus();
  }

  /** Runs a switch or a create, then reloads; a failure stays in the menu. */
  async function run(action: () => Promise<string>) {
    setError(undefined);
    try {
      saveOrg(await action());
      await reload();
      setName("");
      close(true);
    } catch (err) {
      setError(message(err));
    }
  }

  const choose = (o: Org) =>
    o.id === current.id ? close(true) : run(async () => (await api("/orgs/switch", { body: { org: o.id } }), o.id));
  const create = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => (await api<{ org: { id: string } }>("/orgs", { body: { name: name.trim() } })).org.id);
  };

  return (
    <div className="org-switch" ref={root} onKeyDown={open ? keys : undefined}>
      <button
        type="button"
        ref={button}
        className="org-switch-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Org: ${current.name}. Switch org`}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <span className="org-switch-name">{current.name}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d={open ? "M2 8l4-4 4 4" : "M2 4l4 4 4-4"} />
        </svg>
      </button>
      {open && (
        <div className="org-switch-list" ref={menu}>
          <div role="menu" aria-label="Orgs">
            {orgs.map((o) => (
              <button
                key={o.id}
                type="button"
                role="menuitem"
                className="org-switch-item"
                aria-current={o.id === current.id ? "page" : undefined}
                onClick={() => void choose(o)}
              >
                <span className="org-switch-check" aria-hidden>
                  {o.id === current.id ? "✓" : ""}
                </span>
                <span className="org-switch-org">{o.name}</span>
                <span className="org-switch-role">{o.role}</span>
              </button>
            ))}
          </div>
          <form className="org-switch-new" onSubmit={(e) => void create(e)}>
            <label>
              New org
              <input
                type="text"
                value={name}
                maxLength={MAX_ORG_NAME}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            <button type="submit">Create</button>
          </form>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
