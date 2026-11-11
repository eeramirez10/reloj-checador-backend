import type { Queryable } from '../database/database.js';
import { ConfigurationError } from '../../domain/errors/app-error.js';

export async function validateCompanyAssignment(client: Queryable, companyId: string | null, currentId?: string | null) {
  if (!companyId) return;
  const company = (await client.query<{ active: boolean }>('SELECT active FROM companies WHERE id=$1 FOR SHARE',[companyId])).rows[0];
  if (!company) throw new ConfigurationError('La empresa seleccionada no existe.');
  if (!company.active && companyId !== currentId) throw new ConfigurationError('Selecciona una empresa activa para asignar al empleado.');
}
