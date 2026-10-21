import { describe, expect, it, vi } from 'vitest';
import { EmployeeRegistry } from '../src/domain/use-cases/manage-employee-registry.js';
import type { EmployeeRegistryRepository, EmployeeRegistrySession } from '../src/domain/repositories/employee-registry-repository.js';

function repository(overrides: Partial<EmployeeRegistrySession>): EmployeeRegistryRepository {
  const unexpected = () => { throw new Error('Operación inesperada.'); };
  const session: EmployeeRegistrySession = {
    branchTimeZone: unexpected, create: unexpected, lockEmployee: unexpected, updateProfile: unexpected,
    confirm: unexpected, listClocks: unexpected, currentClock: unexpected, findClock: unexpected,
    archiveAndMerge: unexpected, assignClock: unexpected, finishMerge: unexpected, ...overrides,
  };
  return { transaction: (operation) => operation(session), clockEmployeeId: unexpected, history: unexpected };
}

describe('employee registry use cases without a database', () => {
  it('uses the branch local date when creating a native employee', async () => {
    const create = vi.fn(async () => 'employee-id');
    const service = new EmployeeRegistry(repository({ branchTimeZone: async () => 'America/Cancun', create }),
      () => new Date('2026-10-21T05:30:00Z'));
    const input = { firstName: 'Ana', lastName: 'Prueba', branchId: 'branch-id' };
    expect(await service.create(input)).toBe('employee-id');
    expect(create).toHaveBeenCalledWith(input, 'Ana Prueba', '2026-10-21');
  });

  it('rejects merging identities from different branches before changing records', async () => {
    const archiveAndMerge = vi.fn(async () => undefined);
    const service = new EmployeeRegistry(repository({
      lockEmployee: async (id) => ({ id, branchId: id === 'pending' ? 'cancun' : 'mexico',
        identificationStatus: id === 'pending' ? 'pending' : 'confirmed', firstName: 'Ana' }),
      archiveAndMerge,
    }));
    await expect(service.identify('pending', { targetEmployeeId: 'confirmed' })).rejects.toThrow('misma sucursal');
    expect(archiveAndMerge).not.toHaveBeenCalled();
  });

  it('does not confirm a pending identity that only has an external clock ID', async () => {
    const confirm = vi.fn(async () => undefined);
    const service = new EmployeeRegistry(repository({
      lockEmployee: async (id) => ({ id, branchId: null, identificationStatus: 'pending', firstName: null }), confirm,
    }));
    await expect(service.identify('pending', {})).rejects.toThrow('Nombre(s)');
    expect(confirm).not.toHaveBeenCalled();
  });
});
