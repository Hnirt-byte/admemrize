import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * Type de base utilisé par toutes les routes. Les tests injectent une instance
 * PGlite (Postgres compilé en WebAssembly) compatible avec cette interface, ce
 * qui permet de tester les vraies requêtes SQL sans Docker.
 */
export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  close: () => Promise<void>;
}

export function createDatabase(databaseUrl: string): DatabaseHandle {
  const client = postgres(databaseUrl, { max: 10 });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}
