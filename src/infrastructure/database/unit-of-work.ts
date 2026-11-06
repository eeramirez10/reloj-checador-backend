import type { TransactionRepositories, UnitOfWork } from '../../domain/repositories/unit-of-work.js';
import type { Database, Queryable } from './database.js';

export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly database: Database, private readonly repositories: (client: Queryable) => TransactionRepositories) {}

  execute<T>(operation: (repositories: TransactionRepositories) => Promise<T>): Promise<T> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('attendance-evaluation'))::text");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('employee-leave'))::text");
      return operation(this.repositories(client));
    });
  }
}
