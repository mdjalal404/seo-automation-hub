import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * Runs the real Supabase migrations inside an in-process Postgres (PGlite) with a
 * minimal emulation of the Supabase auth schema and roles, so RLS policies and
 * workflow RPCs can be tested without Docker or a hosted project.
 */
const BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`;

export type TestDb = PGlite;

export async function createTestDb(): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(BOOTSTRAP);
  const dir = path.join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(dir, file), "utf8"));
  }
  return db;
}

export async function createUser(db: TestDb, email: string): Promise<string> {
  const res = await db.query<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  return res.rows[0].id;
}

/** Run statements as an authenticated end user (RLS + column grants apply). */
export async function asUser<T>(db: TestDb, userId: string, fn: (tx: TestDb) => Promise<T>): Promise<T> {
  return runAs(db, "authenticated", userId, fn);
}

/** Run statements as the service role (used by the server-side worker). */
export async function asService<T>(db: TestDb, fn: (tx: TestDb) => Promise<T>): Promise<T> {
  return runAs(db, "service_role", null, fn);
}

async function runAs<T>(db: TestDb, role: string, userId: string | null, fn: (tx: TestDb) => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.exec(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(userId ? { sub: userId, role } : { role }),
    ]);
    const out = await fn(db);
    await db.exec("commit");
    return out;
  } catch (err) {
    await db.exec("rollback");
    throw err;
  }
}
