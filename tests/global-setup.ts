import pg from "pg";
import { migrate } from "../scripts/migrate";

export default async function setup() {
  const base = process.env.TEST_PG_URL ?? "postgres://postgres:postgres@localhost:5432";
  const c = new pg.Client({ connectionString: `${base}/postgres` });
  await c.connect();
  await c.query("DROP DATABASE IF EXISTS ploot_test WITH (FORCE)");
  await c.query("CREATE DATABASE ploot_test");
  await c.end();
  await migrate(`${base}/ploot_test`, () => {});
}
