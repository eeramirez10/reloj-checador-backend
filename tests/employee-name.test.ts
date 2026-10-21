import { describe, expect, it } from 'vitest';
import { splitEmployeeName } from '../src/employees/employee-name.js';

describe('employee name prefill', () => {
  it.each([
    ['ACEVES GONZALEZ MARIA LUISA', true, [], 'MARIA LUISA', 'ACEVES GONZALEZ'],
    ['JUAREZ MARTINEZ ELEAZAR JORGE', true, [], 'ELEAZAR JORGE', 'JUAREZ MARTINEZ'],
    ['DE LA TORRE GARCIA MARIA JOSE', true, [], 'MARIA JOSE', 'DE LA TORRE GARCIA'],
    ['FERNANDEZ DE LA CRUZ DANAEL', true, ['Danael'], 'DANAEL', 'FERNANDEZ DE LA CRUZ'],
    ['VAZQUEZ GOMEZ TERRAZAS HECTOR', true, ['Héctor'], 'HECTOR', 'VAZQUEZ GOMEZ TERRAZAS'],
    ['HUERTA ASCENCIO NARDA ISABEL', true, ['Isabel'], 'NARDA ISABEL', 'HUERTA ASCENCIO'],
    ['VAZQUEZ BRAGA JIMMY GERARDO', true, ['Gerardo'], 'JIMMY GERARDO', 'VAZQUEZ BRAGA'],
    ['AGUILAR MUÑIZ MARIA JOSE', true, ['Mariajose'], 'MARIA JOSE', 'AGUILAR MUÑIZ'],
    ['LUIS VARGAS NORA JULIETA', true, [], 'NORA JULIETA', 'LUIS VARGAS'],
    ['MIGUEL HERNANDEZ JOSE', true, [], 'JOSE', 'MIGUEL HERNANDEZ'],
    ['FRANCISCO VAZQUEZ ROSA', true, [], 'ROSA', 'FRANCISCO VAZQUEZ'],
    ['ROLANDO ALFREDO PEDROZA CASTAÑEDA', true, [], 'ROLANDO ALFREDO', 'PEDROZA CASTAÑEDA'],
    ['ABEL OVIEDO SOLIS', true, [], 'ABEL', 'OVIEDO SOLIS'],
    ['MARIA DE LA SALUD HERRERA GUTIERREZ', true, [], 'MARIA DE LA SALUD', 'HERRERA GUTIERREZ'],
    ['Hugo', false, [], 'Hugo', undefined],
    ['María José', false, [], 'María José', undefined],
    ['María del Carmen', false, [], 'María del Carmen', undefined],
    ['Registro 501', false, ['Ángélica'], 'Ángélica', undefined],
    ['PEREZ LOPEZ JUAN', false, [], 'JUAN', 'PEREZ LOPEZ'],
  ] as Array<[string, boolean, string[], string, string | undefined]>)(
    'fills the parts of %s without changing original spelling', (fullName, imported, references, firstName, lastName) => {
      const parts = splitEmployeeName(fullName, imported, references);
      expect(parts.firstName).toBe(firstName);
      expect(parts.lastName).toBe(lastName);
    });

  it.each(['Registro 1', 'Registro EMP001', 'Usuario 2', '501', 'Sin nombre', ''])('keeps %s unidentified rather than inventing a personal name', (name) => {
    expect(splitEmployeeName(name, false)).toEqual({ method: 'unknown' });
  });
});
