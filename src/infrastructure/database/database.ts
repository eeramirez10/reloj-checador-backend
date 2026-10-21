import { Pool, type QueryResultRow } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from './generated/client.js';

export interface Queryable {
  readonly prisma: Prisma.TransactionClient;
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

class PrismaQueryable implements Queryable {
  constructor(readonly prisma: Prisma.TransactionClient) {}

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    const returnsRows = /^\s*(SELECT|WITH|SHOW|EXPLAIN)\b/i.test(text) || /\bRETURNING\b/i.test(text);
    if (returnsRows) {
      const rows = await this.prisma.$queryRawUnsafe<T[]>(text, ...values);
      return { rows, rowCount: rows.length };
    }
    const rowCount = await this.prisma.$executeRawUnsafe(text, ...values);
    return { rows: [], rowCount };
  }
}

export class Database extends PrismaQueryable {
  private readonly pool: Pool;
  private readonly client: PrismaClient;

  constructor(connectionString: string) {
    const url = new URL(connectionString);
    const schema = url.searchParams.get('schema') ?? url.searchParams.get('options')?.match(/search_path=([a-zA-Z0-9_]+)/)?.[1] ?? 'public';
    url.searchParams.delete('schema');
    const pool = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 10_000, options: url.searchParams.get('options') ?? `-c search_path=${schema}` });
    const client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    super(client);
    this.pool = pool;
    this.client = client;
    pool.on('error', (error) => console.error('Error en una conexión PostgreSQL inactiva.', error));
  }

  transaction<T>(callback: (client: Queryable) => Promise<T>): Promise<T> {
    return this.client.$transaction((client) => callback(new PrismaQueryable(client)), { maxWait: 10_000, timeout: 60_000 });
  }

  async executeScript(text: string): Promise<void> {
    await this.pool.query(text);
  }

  async close(): Promise<void> {
    try { await this.client.$disconnect(); }
    finally { await this.pool.end(); }
  }
}
