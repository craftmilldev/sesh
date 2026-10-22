/**
 * Migrations live in TS (not .sql files) so they're bundled into the Vercel function.
 * Append new entries; never edit an applied one.
 *
 * Everything is in a `sesh` schema (not `public`), and RLS is enabled with no policies, so a
 * PostgREST-style Data API (e.g. Neon's, if ever turned on) can't reach it. The app connects as the table owner.
 */
export const migrations: { version: string; sql: string }[] = [
  {
    version: "001_users_and_orgs",
    sql: `
CREATE TABLE sesh.users (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_idx ON sesh.users (lower(email));

CREATE TABLE sesh.orgs (
  id                uuid PRIMARY KEY,
  name              text NOT NULL,
  personal_user_id  uuid UNIQUE REFERENCES sesh.users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sesh.org_members (
  org_id      uuid NOT NULL REFERENCES sesh.orgs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES sesh.users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX org_members_user_idx ON sesh.org_members (user_id);

CREATE TABLE sesh.login_codes (
  id          uuid PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sesh.users        ENABLE ROW LEVEL SECURITY;

ALTER TABLE sesh.orgs         ENABLE ROW LEVEL SECURITY;

ALTER TABLE sesh.org_members  ENABLE ROW LEVEL SECURITY;

ALTER TABLE sesh.login_codes  ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    version: "002_org_invites",
    sql: `
ALTER TABLE sesh.org_members DROP CONSTRAINT org_members_role_check;

ALTER TABLE sesh.org_members ADD CONSTRAINT org_members_role_check CHECK (role IN ('owner', 'member'));

CREATE TABLE sesh.org_invites (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES sesh.orgs(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  created_by  uuid NOT NULL REFERENCES sesh.users(id) ON DELETE CASCADE,
  used_by     uuid REFERENCES sesh.users(id) ON DELETE SET NULL,
  used_at     timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX org_invites_org_idx ON sesh.org_invites (org_id);

ALTER TABLE sesh.org_invites ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    version: "003_ingest_tokens",
    sql: `
CREATE TABLE sesh.ingest_tokens (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES sesh.orgs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES sesh.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ingest_tokens_user_idx ON sesh.ingest_tokens (user_id, org_id);

CREATE TABLE sesh.raw_payloads (
  id                uuid PRIMARY KEY,
  org_id            uuid NOT NULL REFERENCES sesh.orgs(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES sesh.users(id) ON DELETE CASCADE,
  signal            text NOT NULL CHECK (signal IN ('logs', 'metrics')),
  content_type      text NOT NULL,
  content_encoding  text,
  body              bytea NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX raw_payloads_org_idx ON sesh.raw_payloads (org_id, received_at);

ALTER TABLE sesh.ingest_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE sesh.raw_payloads  ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    version: "004_sessions_prompts_events",
    sql: `
CREATE TABLE sesh.sessions (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES sesh.orgs(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES sesh.users(id) ON DELETE CASCADE,
  agent        text NOT NULL,
  external_id  text NOT NULL,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz NOT NULL,
  UNIQUE (org_id, agent, external_id)
);

CREATE INDEX sessions_org_idx ON sesh.sessions (org_id, started_at);

CREATE TABLE sesh.prompts (
  id             uuid PRIMARY KEY,
  session_id     uuid NOT NULL REFERENCES sesh.sessions(id) ON DELETE CASCADE,
  external_id    text NOT NULL,
  prompt_length  integer,
  started_at     timestamptz NOT NULL,
  UNIQUE (session_id, external_id)
);

CREATE TABLE sesh.events (
  id                 uuid PRIMARY KEY,
  session_id         uuid NOT NULL REFERENCES sesh.sessions(id) ON DELETE CASCADE,
  prompt_id          uuid REFERENCES sesh.prompts(id) ON DELETE SET NULL,
  dedupe_key         text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('api_request', 'tool_call')),
  occurred_at        timestamptz NOT NULL,
  model              text,
  input_tokens       bigint,
  output_tokens      bigint,
  cache_read_tokens  bigint,
  cache_write_tokens bigint,
  cost_usd           double precision,
  duration_ms        double precision,
  tool_name          text,
  success            boolean,
  raw                jsonb NOT NULL,
  UNIQUE (session_id, dedupe_key)
);

CREATE INDEX events_prompt_idx ON sesh.events (prompt_id);

ALTER TABLE sesh.raw_payloads ADD COLUMN parsed_at timestamptz;

ALTER TABLE sesh.sessions  ENABLE ROW LEVEL SECURITY;

ALTER TABLE sesh.prompts   ENABLE ROW LEVEL SECURITY;

ALTER TABLE sesh.events    ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    version: "005_limit_snapshots",
    sql: `
CREATE TABLE sesh.limit_snapshots (
  id                   uuid PRIMARY KEY,
  org_id               uuid NOT NULL REFERENCES sesh.orgs(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES sesh.users(id) ON DELETE CASCADE,
  session_external_id  text NOT NULL,
  five_hour_pct        double precision,
  five_hour_resets_at  timestamptz,
  seven_day_pct        double precision,
  seven_day_resets_at  timestamptz,
  captured_at          timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX limit_snapshots_session_idx ON sesh.limit_snapshots (org_id, user_id, session_external_id, captured_at);

CREATE INDEX limit_snapshots_user_idx ON sesh.limit_snapshots (org_id, user_id, captured_at);

ALTER TABLE sesh.limit_snapshots ENABLE ROW LEVEL SECURITY;
`,
  },
];
