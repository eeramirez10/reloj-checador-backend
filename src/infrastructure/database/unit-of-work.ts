import type { TransactionRepositories, UnitOfWork } from '../../domain/repositories/unit-of-work.js';
import type { Database, Queryable } from './database.js';

export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly database: Database, private readonly repositories: (client: Queryable) => TransactionRepositories) {}

  execute<T>(operation: (repositories: TransactionRepositories) => Promise<T>): Promise<T> {
    return this.database.transaction((client) => operation(this.repositories(client)));
  }
}
