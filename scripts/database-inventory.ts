import type { Queryable } from '../src/infrastructure/database/database.js';

export async function databaseInventory(database: Queryable) {
  const tables = (await database.query<{ name: string; identifier: string }>(
    `SELECT tablename AS name,format('%I.%I',schemaname,tablename) AS identifier FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows;
  const result: Record<string,{ rows: number; checksum: string }> = {};
  for (const table of tables) result[table.name] = (await database.query<{ rows: number; checksum: string }>(
    `SELECT COUNT(*)::int AS rows,md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) AS checksum FROM ${table.identifier} t`)).rows[0];
  return result;
}
