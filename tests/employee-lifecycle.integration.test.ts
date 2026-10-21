import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrate.js';
import { OrganizationRepository } from '../src/organization/organization-repository.js';
import { branchSchema } from '../src/organization/schemas.js';
import { EmployeeRegistry } from '../src/employees/employee-registry.js';
import { EmployeeLifecycle } from '../src/employees/employee-lifecycle.js';
import { EmployeeRepository } from '../src/employees/employee-repository.js';
import { EmployeeNameService } from '../src/employees/employee-name-service.js';
import { DeviceRepository } from '../src/devices/device-repository.js';
import { DeviceUserRepository } from '../src/users/device-user-repository.js';
import { buildApp } from '../src/app.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;

integration('employee lifecycle and simplified editing', () => {
  const schema = `test_lifecycle_${randomUUID().replaceAll('-', '')}`;
  let admin: Database;
  let database: Database;
  let organization: OrganizationRepository;
  let registry: EmployeeRegistry;
  let mexicoId: string;
  let cancunId: string;

  beforeAll(async () => {
    admin = new Database(connection!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(url.toString());
    await runMigrations(database);
    organization = new OrganizationRepository(database);
    registry = new EmployeeRegistry(database, organization);
    mexicoId = (await organization.saveBranch(branchSchema.parse({ name: 'México' })))!.id;
    cancunId = (await organization.saveBranch(branchSchema.parse({ name: 'Cancún', timeZone: 'America/Cancun' })))!.id;
  }, 30000);
  afterAll(async () => {
    await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });

  it('automatically records hire, termination and reactivation while preserving the original hire date', async () => {
    const id = await registry.create({ firstName: 'Persona', lastName: 'Nueva', branchId: cancunId });
    const original = await new EmployeeRepository(database).findById(id);
    expect(original?.hireDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(original?.isActive).toBe(true);
    expect((await registry.history(id)).statusEvents).toHaveLength(1);
    await database.transaction((client) => new EmployeeLifecycle(client).setActive(id, false, new Date('2030-01-02T05:30:00Z')));
    const terminated = await new EmployeeRepository(database).findById(id);
    expect(terminated).toMatchObject({ isActive: false, employmentStatus: 'inactive', terminationDate: '2030-01-02', hireDate: original?.hireDate });
    await database.transaction((client) => new EmployeeLifecycle(client).setActive(id, false, new Date('2030-01-03T05:30:00Z')));
    expect((await registry.history(id)).statusEvents).toHaveLength(2);
    await database.transaction((client) => new EmployeeLifecycle(client).setActive(id, true, new Date('2030-01-04T05:30:00Z')));
    const reactivated = await new EmployeeRepository(database).findById(id);
    expect(reactivated?.isActive).toBe(true);
    expect(reactivated?.terminationDate).toBeUndefined();
    expect(reactivated?.hireDate).toBe(original?.hireDate);
    const history = await registry.history(id);
    expect(history.statusEvents).toHaveLength(3);
    expect(history.statusEvents[0]).toMatchObject({ eventType: 'reactivated', previousTerminationDate: '2030-01-02', terminationDate: null });
    expect(history.statusEvents[1].originalData.hire_date).toBe(original?.hireDate);
  });

  it('uses the branch date at midnight boundaries instead of the server calendar', async () => {
    const mexico = await registry.create({ firstName: 'Persona', branchId: mexicoId });
    const cancun = await registry.create({ firstName: 'Persona', branchId: cancunId });
    const instant = new Date('2030-01-02T05:30:00Z');
    await database.transaction((client) => new EmployeeLifecycle(client).setActive(mexico, false, instant));
    await database.transaction((client) => new EmployeeLifecycle(client).setActive(cancun, false, instant));
    expect((await new EmployeeRepository(database).findById(mexico))?.terminationDate).toBe('2030-01-01');
    expect((await new EmployeeRepository(database).findById(cancun))?.terminationDate).toBe('2030-01-02');
  });

  it('rejects manual dates and imported codes, and rolls back an invalid edit together with its status change', async () => {
    const id = await registry.create({ firstName: 'Nombre', lastName: 'Apellido', branchId: mexicoId });
    const { app } = await buildApp({ database });
    try {
      const initial = await new EmployeeRepository(database).findById(id);
      for (const fields of [{ hireDate: '2000-01-01' }, { terminationDate: '2000-01-01' }, { managementCode: '00001' }, { scheduleTypeCode: '00002' }]) {
        expect((await app.inject({ method: 'PATCH', url: `/employees/${id}`, payload: { ...fields, isActive: false } })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: 'PATCH', url: `/employees/${id}`, payload: { firstName: null, lastName: 'Apellido', isActive: false } })).statusCode).toBe(400);
      expect((await new EmployeeRepository(database).findById(id))?.isActive).toBe(true);
      expect((await registry.history(id)).statusEvents).toHaveLength(1);
      expect((await app.inject({ method: 'PATCH', url: `/employees/${id}`, payload: { isActive: false } })).statusCode).toBe(204);
      expect((await new EmployeeRepository(database).findById(id))?.terminationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect((await app.inject({ method: 'PATCH', url: `/employees/${id}`, payload: { isActive: true } })).statusCode).toBe(204);
      const result = await new EmployeeRepository(database).findById(id);
      expect(result).toMatchObject({ isActive: true, hireDate: initial?.hireDate });
      expect(result?.terminationDate).toBeUndefined();
    } finally { await app.close(); }
  });

  it('preserves manual state and original dates through catalog and clock synchronization', async () => {
    const employees = new EmployeeRepository(database);
    const record = { employeeNumber: '00009001', normalizedEmployeeNumber: '9001', name: 'PEREZ LOPEZ JUAN', hireDate: '2010-02-03', terminationDate: '2020-01-01' };
    await employees.upsert(record);
    const imported = (await employees.list({ limit: 500 })).find((employee) => employee.employeeNumber === record.employeeNumber)!;
    expect(imported.isActive).toBe(false);
    await database.transaction((client) => new EmployeeRepository(client).update(imported.id, {}, true));
    await employees.upsert({ ...record, hireDate: '2025-01-01' });
    const retained = await employees.findById(imported.id);
    expect(retained).toMatchObject({ isActive: true, hireDate: '2010-02-03' });
    expect(retained?.terminationDate).toBeUndefined();
    await organization.assignBranch(mexicoId, { employeeIds: [imported.id], deviceUserIds: [], effectiveFrom: '1900-01-01' });
    const clock = await new DeviceRepository(database).create({ name: 'Reloj', ipAddress: '127.0.0.10', branchId: mexicoId });
    const users = new DeviceUserRepository(database);
    await users.upsert(clock.id, { userId: '9001', name: 'Juan', raw: {} });
    await database.transaction((client) => new EmployeeRepository(client).update(imported.id, {}, false));
    const inactive = await employees.findById(imported.id);
    await users.upsert(clock.id, { userId: '9001', name: 'Nombre actualizado del equipo', raw: {} });
    expect((await employees.findById(imported.id))?.isActive).toBe(false);
    expect((await employees.findById(imported.id))?.terminationDate).toBe(inactive?.terminationDate);
    expect((await registry.history(imported.id)).statusEvents.filter((event) => event.eventType === 'reactivated')).toHaveLength(1);
  });

  it('prefills names once, preserves originals and leaves manually corrected names untouched', async () => {
    await new EmployeeRepository(database).upsert({ employeeNumber: '00009002', normalizedEmployeeNumber: '9002', name: 'ACEVES GONZALEZ MARIA LUISA' });
    const employee = (await new EmployeeRepository(database).list({ limit: 500 })).find((item) => item.employeeNumber === '00009002')!;
    const names = new EmployeeNameService(database);
    await names.populateMissing();
    expect(await new EmployeeRepository(database).findById(employee.id)).toMatchObject({ firstName: 'MARIA LUISA', lastName: 'ACEVES GONZALEZ', originalName: 'ACEVES GONZALEZ MARIA LUISA' });
    await database.transaction((client) => new EmployeeRepository(client).update(employee.id, { firstName: 'María Luisa', lastName: 'Apellidos corregidos' }));
    await names.populateMissing(true);
    expect(await new EmployeeRepository(database).findById(employee.id)).toMatchObject({ firstName: 'María Luisa', lastName: 'Apellidos corregidos', originalName: 'ACEVES GONZALEZ MARIA LUISA', nameSplitMethod: 'manual' });
    expect((await names.populateMissing()).updated).toBe(0);
    await database.transaction((client) => new EmployeeRepository(client).update(employee.id, { name: 'María Nombre Completo' }));
    await new EmployeeRepository(database).upsert({ employeeNumber: '00009002', normalizedEmployeeNumber: '9002', name: 'OTROS APELLIDOS NOMBRE' });
    expect((await new EmployeeRepository(database).findById(employee.id))?.name).toBe('María Nombre Completo');
    await names.populateMissing();
    expect(await new EmployeeRepository(database).findById(employee.id)).toMatchObject({ firstName: 'María', lastName: 'Nombre Completo', nameSplitMethod: 'manual', originalName: 'ACEVES GONZALEZ MARIA LUISA' });
  });
});
