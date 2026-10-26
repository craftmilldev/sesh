import { useCallback, useEffect, useState, type FormEvent } from "react";
import { message, type Me } from "./layout.js";
import { api } from "./session.js";

interface Member {
  name: string;
  role: "owner" | "member";
  counts_toward_team: boolean;
  you: boolean;
}

function Field(props: {
  label: string;
  button: string;
  type: "text" | "email";
  max?: number;
  primary?: boolean;
  placeholder?: string;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    await props.onSubmit(value);
    setValue("");
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <label>
        {props.label}
        <input
          type={props.type}
          value={value}
          maxLength={props.max}
          placeholder={props.placeholder}
          onChange={(e) => setValue(e.target.value)}
          required
        />
      </label>
      <button type="submit" className={props.primary ? "primary" : undefined}>
        {props.button}
      </button>
    </form>
  );
}

/** Members: who is in the org, and the invite. */
export function Members({ me, reload }: { me: Me; reload: () => Promise<void> }) {
  const { org } = me;
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [members, setMembers] = useState<Member[]>([]);

  const loadMembers = useCallback(async () => setMembers((await api<{ members: Member[] }>("/members")).members), []);
  useEffect(() => {
    loadMembers().catch((err) => setNotice({ text: message(err), error: true }));
  }, [loadMembers]);

  /** Runs an action, then reloads; a failure is shown instead. */
  async function act(run: () => Promise<string | void>) {
    setNotice(undefined);
    try {
      const text = await run();
      await reload();
      if (text) setNotice({ text });
    } catch (err) {
      setNotice({ text: message(err), error: true });
    }
  }

  return (
    <>
      <section className="section">
        <p className="eyebrow">
          {org.name} · {org.role === "owner" ? "You own this org" : "Member"}
        </p>
        <h1>Members</h1>
        <p className="muted" style={{ marginTop: 12 }}>
          Who is in {org.name}, and who counts toward its team plan.
        </p>
        {notice && <p className={notice.error ? "notice error" : "notice"}>{notice.text}</p>}
      </section>

      <section className="section">
        <div className="table-scroll" style={{ marginTop: 16 }}>
          <table className="ledger">
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th className="num">Counts toward team</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m, i) => (
                <tr key={i}>
                  <td className="person">
                    {m.name}
                    {m.you && <em> you</em>}
                  </td>
                  <td>
                    <span className={`role ${m.role}`}>{m.role}</span>
                  </td>
                  <td className="num">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={m.counts_toward_team}
                        disabled={!m.you}
                        aria-label={`${m.name} ${m.counts_toward_team ? "counts" : "does not count"} toward the team`}
                        onChange={(e) => {
                          const counts = e.target.checked; // read now: a controlled box is reset by the time the save returns
                          void act(async () => {
                            const r = await api<{ tokens_revoked: number }>("/membership", {
                              body: { counts_toward_team: counts },
                            });
                            await loadMembers();
                            return counts
                              ? `You now count toward ${org.name}'s team.`
                              : `You're an observer in ${org.name}. ${r.tokens_revoked} token(s) revoked.`;
                          });
                        }}
                      />
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">
          You can change only your own. Untick it to only look: you leave the plan pool, your tokens for {org.name} are
          revoked, and you can't make new ones.
        </p>
        {org.role === "owner" && (
          <div className="invite">
            <Field
              label="Invite by email"
              button="Send invite"
              type="email"
              primary
              onSubmit={(email) =>
                act(async () => {
                  const r = await api<{ email: string; ttl_days: number }>("/orgs/invite", { body: { email } });
                  return `Invite sent to ${r.email}. The link works once and expires in ${r.ttl_days} days.`;
                })
              }
            />
            <p className="muted">The link works once and lasts seven days.</p>
          </div>
        )}
      </section>
    </>
  );
}
