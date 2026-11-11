import { randomUUID } from 'node:crypto';
import type { Company,CompanyInput } from '../../domain/entities/company.js';
import type { CompanyRepository } from '../../domain/repositories/company-repository.js';
import { ConflictError } from '../../domain/errors/app-error.js';
import type { Database } from '../database/database.js';

const columns = 'id,name,code,active,notes,version';
export class PrismaCompanyRepository implements CompanyRepository {
  constructor(private readonly database: Database) {}
  async list() { return (await this.database.query<Company>(`SELECT ${columns} FROM companies ORDER BY lower(name),id`)).rows; }
  async save(input: CompanyInput,id?: string,expectedVersion?: number) {
    if (id) {
      const row = (await this.database.query<Company>(`UPDATE companies SET name=$2,code=$3,active=$4,notes=$5,version=version+1,updated_at=NOW()
        WHERE id=$1 AND version=$6 RETURNING ${columns}`, [id,input.name,input.code,input.active,input.notes,expectedVersion])).rows[0];
      if (!row) throw new ConflictError('La empresa cambió. Actualiza el catálogo antes de guardar.');
      return row;
    }
    return (await this.database.query<Company>(`INSERT INTO companies(id,name,code,active,notes) VALUES($1,$2,$3,$4,$5) RETURNING ${columns}`,
      [randomUUID(),input.name,input.code,input.active,input.notes])).rows[0];
  }
}
