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
];
