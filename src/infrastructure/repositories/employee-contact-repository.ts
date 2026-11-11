import type { EmployeeContactRepository } from '../../domain/repositories/employee-contact-repository.js';
import type { ContactInput, EmployeeContact } from '../../domain/entities/employee-contact.js';
import { ConfigurationError, ConflictError } from '../../domain/errors/app-error.js';
import type { Queryable } from '../database/database.js';
import { normalizePhoneNumber } from '../integrations/twilio/phone-number.js';
import type { CountryCode } from 'libphonenumber-js';

export class PrismaEmployeeContactRepository implements EmployeeContactRepository {
  constructor(private readonly client: Queryable, private readonly country: CountryCode = 'MX') {}

  async get(employeeId: string): Promise<EmployeeContact> {
    const row = (await this.client.query<EmployeeContact>(`SELECT e.id AS "employeeId",c.email,c.alternate_phone AS "alternatePhone",
      c.blood_type AS "bloodType",p.whatsapp_phone AS "whatsappPhone",COALESCE(c.version,0) AS version
      FROM employees e LEFT JOIN employee_contacts c ON c.employee_id=e.id
      LEFT JOIN employee_leave_profiles p ON p.employee_id=e.id WHERE e.id=$1`, [employeeId])).rows[0];
    if (!row) throw new ConfigurationError('Empleado no encontrado.');
    return row;
  }

  async save(employeeId: string, input: ContactInput) {
    await this.client.query('SELECT id FROM employees WHERE id=$1 FOR UPDATE', [employeeId]);
    const current = await this.get(employeeId);
    if (current.version !== input.expectedVersion) throw new ConflictError('Los datos de contacto cambiaron. Actualiza el perfil.');
    const whatsapp = input.whatsappPhone ? normalizePhoneNumber(input.whatsappPhone,this.country) : null;
    const alternate = input.alternatePhone ? normalizePhoneNumber(input.alternatePhone,this.country) : null;
    if (input.bloodType && !(await this.client.query('SELECT code FROM blood_types WHERE code=$1', [input.bloodType])).rows.length) throw new ConfigurationError('Selecciona un tipo de sangre del catálogo.');
    await this.client.query(`INSERT INTO employee_contacts(employee_id,email,alternate_phone,blood_type) VALUES($1,$2,$3,$4)
      ON CONFLICT(employee_id) DO UPDATE SET email=$2,alternate_phone=$3,blood_type=$4,version=employee_contacts.version+1,updated_at=NOW()`,
    [employeeId,input.email === undefined ? current.email : input.email?.toLowerCase() ?? null,alternate,input.bloodType]);
    if (whatsapp !== current.whatsappPhone) await this.client.query(`INSERT INTO employee_leave_profiles(employee_id,whatsapp_phone) VALUES($1,$2)
      ON CONFLICT(employee_id) DO UPDATE SET whatsapp_phone=$2,version=employee_leave_profiles.version+1,updated_at=NOW()`, [employeeId,whatsapp]);
    return this.get(employeeId);
  }
}
