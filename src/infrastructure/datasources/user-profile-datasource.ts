import type { Database } from '../database/database.js';
import { PrismaEmployeeDatasource } from './employee-datasource.js';
import { ConfigurationError } from '../../domain/errors/app-error.js';
import type { UserProfilePatch } from '../../domain/entities/personal-profile.js';
import type { UserProfileDatasource } from '../../domain/datasources/persistence.js';

type ProfileRow = { employee_id: string | null; first_name: string | null; last_name: string | null };

export class PrismaUserProfileDatasource implements UserProfileDatasource {
  constructor(private readonly database: Database) {}

  async update(id: string, input: UserProfilePatch): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const current = (await client.query<ProfileRow>('SELECT employee_id, first_name, last_name FROM device_users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!current) return false;
      const employeeId = current.employee_id;
      if (!employeeId) throw new ConfigurationError('Actualiza la sincronización para generar la ficha de empleado.');
      if (input.employeeId !== undefined && input.employeeId !== employeeId) throw new ConfigurationError('La identificación se administra desde Empleados → Pendientes.');
      const personalFields = Object.fromEntries(Object.entries({ firstName: input.firstName, lastName: input.lastName, rfc: input.rfc, imss: input.socialSecurityNumber })
        .filter(([, value]) => value !== undefined)) as Record<string, string | null>;
      if (input.displayName && input.firstName === undefined && input.lastName === undefined) personalFields.name = input.displayName;
      if (Object.keys(personalFields).length) await new PrismaEmployeeDatasource(client).update(employeeId, personalFields);
      return true;
    });
  }
}
