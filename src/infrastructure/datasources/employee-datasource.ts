import { randomUUID } from 'node:crypto';
import type { Queryable } from '../database/database.js';
import { normalizeEmployeeNumber, type Employee, type EmployeeClockRecord, type EmployeeCatalogRecord, type EmploymentStatus } from '../../domain/entities/employee.js';
import { getUpdatedProfileName } from '../../domain/entities/personal-profile.js';
import { EmployeeLifecycle } from './employee-lifecycle.js';
import type { EmployeeDatasource } from '../../domain/datasources/persistence.js';

type EmployeeRow = {
  id: string;
  employee_number: string | null;
  normalized_employee_number: string | null;
  name: string;
  position: string | null;
  rfc: string | null;
  imss: string | null;
  management_code: string | null;
  section_code: string | null;
  company_code: string | null;
  branch_code: string | null;
  schedule_type_code: string | null;
  hire_date: string | null;
  termination_date: string | null;
  employment_status: EmploymentStatus;
  created_at: Date;
  updated_at: Date;
  branch_id: string | null;
  branch_name: string | null;
  first_name: string | null;
  last_name: string | null;
  identification_status: Employee['identificationStatus'];
  merged_into_id: string | null;
  clock_records: EmployeeClockRecord[];
  is_active: boolean;
  original_name: string | null;
  name_split_method: string | null;
  scheduling: Employee['scheduling'] | null;
};

const statusExpression = `CASE WHEN is_active THEN 'active' ELSE 'inactive' END`;

const selectColumns = `id, employee_number, normalized_employee_number, name, first_name, last_name, position, rfc, imss,
  management_code, section_code, company_code, branch_code, schedule_type_code, hire_date::text AS hire_date,
  termination_date::text AS termination_date, ${statusExpression} AS employment_status, created_at, updated_at, branch_id,
  (SELECT name FROM branches WHERE id = employees.branch_id) AS branch_name,
  identification_status, merged_into_id, is_active, original_name, name_split_method,
  (SELECT jsonb_build_object('versionId', v.id, 'effectiveFrom', v.effective_from::text, 'workHours', v.work_hours,
    'meal', v.meal, 'recognitionMarginMinutes', v.recognition_margin_minutes,
    'mealMode', COALESCE(v.meal_mode, CASE WHEN v.meal IS NULL THEN 'automatic' ELSE 'individual' END), 'recognitionMarginInherited', v.recognition_margin_inherited)
    FROM employee_schedule_versions v WHERE v.employee_id=employees.id
      AND v.effective_from <= (NOW() AT TIME ZONE COALESCE((SELECT time_zone FROM branches WHERE id=employees.branch_id),'America/Mexico_City'))::date
    ORDER BY v.effective_from DESC,v.created_at DESC,v.id DESC LIMIT 1) AS scheduling,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id', u.id, 'deviceId', u.device_id, 'userId', u.device_user_id, 'name', u.name, 'deviceName', d.name,
    'branchId', d.branch_id, 'bindingStatus', u.binding_status, 'syncedAt', u.synced_at,
    'cardNumber', u.card_number, 'role', u.role,
    'hasPhoto', EXISTS (SELECT 1 FROM device_user_photos p WHERE p.device_id = u.device_id AND p.device_user_id = u.device_user_id),
    'originalProfile', jsonb_build_object('firstName', u.first_name, 'lastName', u.last_name, 'displayName', u.display_name, 'rfc', u.rfc, 'socialSecurityNumber', u.imss, 'rawData', u.raw_data)
  ) ORDER BY (u.binding_status = 'active') DESC, u.synced_at DESC)
  FROM device_users u JOIN devices d ON d.id = u.device_id WHERE u.employee_id = employees.id), '[]'::jsonb) AS clock_records`;

const mapRow = (row: EmployeeRow): Employee => ({
  id: row.id,
  employeeNumber: row.employee_number ?? undefined,
  normalizedEmployeeNumber: row.normalized_employee_number ?? undefined,
  name: row.name,
  firstName: row.first_name ?? undefined,
  lastName: row.last_name ?? undefined,
  position: row.position ?? undefined,
  rfc: row.rfc ?? undefined,
  imss: row.imss ?? undefined,
  managementCode: row.management_code ?? undefined,
  sectionCode: row.section_code ?? undefined,
  companyCode: row.company_code ?? undefined,
  branchCode: row.branch_code ?? undefined,
  scheduleTypeCode: row.schedule_type_code ?? undefined,
  hireDate: row.hire_date ?? undefined,
  terminationDate: row.termination_date ?? undefined,
  employmentStatus: row.employment_status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  branchId: row.branch_id ?? undefined,
  branchName: row.branch_name ?? undefined,
  identificationStatus: row.identification_status,
  mergedIntoId: row.merged_into_id ?? undefined,
  clockRecords: row.clock_records ?? [],
  isActive: row.is_active,
  originalName: row.original_name ?? undefined,
  nameSplitMethod: row.name_split_method ?? undefined,
  scheduling: row.scheduling ?? undefined,
});

export class PrismaEmployeeDatasource implements EmployeeDatasource {
  constructor(private readonly database: Queryable) {}

  async findById(id: string): Promise<Employee | undefined> {
    const row = (await this.database.query<EmployeeRow>(`SELECT ${selectColumns} FROM employees WHERE id = $1`, [id])).rows[0];
    return row ? mapRow(row) : undefined;
  }

  async update(id: string, fields: Record<string, string | null>, isActive?: boolean): Promise<boolean> {
    const statusChanged = isActive === undefined ? false : await new EmployeeLifecycle(this.database).setActive(id, isActive);
    const changes = { ...fields };
    if (changes.employeeNumber !== undefined) changes.normalizedEmployeeNumber = changes.employeeNumber ? normalizeEmployeeNumber(changes.employeeNumber) : null;
    if (changes.firstName !== undefined || changes.lastName !== undefined) {
      const current = (await this.database.query<{ firstName: string | null; lastName: string | null }>(
        'SELECT first_name AS "firstName", last_name AS "lastName" FROM employees WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!current) return false;
      const fullName = getUpdatedProfileName(current, changes);
      if (fullName !== undefined) changes.name = fullName;
      changes.nameSplitMethod = 'manual';
    } else if (changes.name !== undefined) {
      changes.firstName = null;
      changes.lastName = null;
      changes.nameSplitMethod = 'manual_full_name';
    }
    const columns: Record<string, string> = {
      firstName: 'first_name', lastName: 'last_name',
      normalizedEmployeeNumber: 'normalized_employee_number',
      nameSplitMethod: 'name_split_method',
      name: 'name', employeeNumber: 'employee_number', position: 'position', rfc: 'rfc', imss: 'imss',
      managementCode: 'management_code', sectionCode: 'section_code', companyCode: 'company_code',
      branchCode: 'branch_code', scheduleTypeCode: 'schedule_type_code',
    };
    const entries = Object.entries(changes).filter(([key]) => columns[key]);
    if (entries.length === 0) return statusChanged || isActive !== undefined;
    const result = await this.database.query(`UPDATE employees SET ${entries.map(([key], index) => `${columns[key]} = $${index + 2}`).join(', ')}, original_name = COALESCE(original_name, name), updated_at = NOW()
      WHERE id = $1 AND identification_status <> 'merged' RETURNING id`, [id, ...entries.map(([, value]) => value)]);
    return result.rows.length > 0;
  }

  async upsert(employee: EmployeeCatalogRecord): Promise<void> {
    const result = await this.database.query<{ id: string; identification_status: string }>(
      `INSERT INTO employees (
         id, employee_number, normalized_employee_number, name, position, rfc, imss,
         management_code, section_code, company_code, branch_code, schedule_type_code, hire_date, termination_date, original_name, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $4,
         NOT ($14::date IS NOT NULL AND $14::date < CURRENT_DATE))
       ON CONFLICT (employee_number) DO UPDATE SET
         normalized_employee_number = EXCLUDED.normalized_employee_number,
          name = CASE WHEN employees.first_name IS NULL AND COALESCE(employees.name_split_method, '') NOT IN ('manual','manual_full_name') THEN EXCLUDED.name ELSE employees.name END,
          original_name = COALESCE(employees.original_name, EXCLUDED.original_name),
          position = EXCLUDED.position, rfc = EXCLUDED.rfc, imss = EXCLUDED.imss,
         management_code = EXCLUDED.management_code, section_code = EXCLUDED.section_code,
         company_code = EXCLUDED.company_code, branch_code = EXCLUDED.branch_code,
          schedule_type_code = EXCLUDED.schedule_type_code, updated_at = NOW() RETURNING id, identification_status`,
      [
        randomUUID(), employee.employeeNumber, employee.normalizedEmployeeNumber, employee.name,
        employee.position ?? null, employee.rfc ?? null, employee.imss ?? null,
        employee.managementCode ?? null, employee.sectionCode ?? null, employee.companyCode ?? null,
        employee.branchCode ?? null, employee.scheduleTypeCode ?? null,
        employee.hireDate ?? null, employee.terminationDate ?? null,
      ],
    );
    const stored = result.rows[0];
    if (stored && stored.identification_status !== 'merged') await new EmployeeLifecycle(this.database).recordInitial(stored.id);
  }

  async list(filters: {
    search?: string;
    branchCode?: string;
    employmentStatus?: EmploymentStatus;
    identificationStatus?: 'confirmed' | 'pending';
    limit: number;
  }): Promise<Employee[]> {
    const result = await this.database.query<EmployeeRow>(
      `SELECT ${selectColumns} FROM employees
       WHERE ($1::text IS NULL OR employee_number ILIKE '%' || $1 || '%'
         OR normalized_employee_number ILIKE '%' || $1 || '%'
         OR name ILIKE '%' || $1 || '%' OR position ILIKE '%' || $1 || '%'
         OR rfc ILIKE '%' || $1 || '%' OR imss ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR branch_code = $2)
          AND ($3::text IS NULL OR (${statusExpression}) = $3)
          AND identification_status <> 'merged'
          AND ($5::text IS NULL OR identification_status = $5)
       ORDER BY name, employee_number LIMIT $4`,
      [filters.search?.trim() || null, filters.branchCode ?? null, filters.employmentStatus ?? null, filters.limit, filters.identificationStatus ?? null],
    );
    return result.rows.map(mapRow);
  }
}
