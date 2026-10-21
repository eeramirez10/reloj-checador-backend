import { describe, expect, it } from 'vitest';
import { normalizeEmployeeNumber, parseEmployeeCatalog } from '../src/infrastructure/imports/employee-catalog.js';

type Word = [text: string, left: number, top: number, page?: number];

const header: Word[] = [
  ['Número', 10, 70], ['Puesto', 170, 70], ['RFC', 310, 70], ['IMSS', 362, 70],
  ['Gere', 400, 70], ['Secc', 420, 70], ['Empr', 440, 70], ['Sucu', 460, 70],
  ['Tipo', 480, 70], ['Horario', 500, 70], ['Alta', 535, 70], ['Baja', 560, 70],
];

function toTsv(words: Word[]): string {
  return [
    'level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    ...words.map(([text, left, top, page = 1]) => [5, page, 0, 0, 0, 0, left, top, 10, 6, 100, text].join('\t')),
  ].join('\n');
}

function employeeWords(number: string, top: number): Word[] {
  return [
    [number, 10, top], ['-', 38, top], ['EMPLEADO', 42, top], ['PRUEBA', 82, top],
    ['AUX.', 170, top], ['ADMINISTRATIVO', 186, top], ['AAAA-710715-AB1', 292, top],
    ['01234567890', 352, top], ['00004', 405, top - 0.36], ['00001', 425, top - 0.36],
    ['00002', 445, top - 0.36], ['00003', 465, top - 0.36], ['00000', 502, top - 0.36],
    ['12/04/06', 530, top - 0.36], ['31/07/26', 560, top - 0.36],
  ];
}

describe('employee catalog import', () => {
  it('reads full RFC/IMSS and sparse codes by physical coordinates regardless of text order', () => {
    const first = employeeWords('00001008', 84);
    const second = employeeWords('00000507', 94).filter((word) => ![405, 425, 465, 560].includes(word[1]));
    const records = parseEmployeeCatalog(toTsv([...header, ...first.reverse(), ...second.reverse()]));

    expect(records).toEqual([
      {
        employeeNumber: '00001008', normalizedEmployeeNumber: '1008', name: 'EMPLEADO PRUEBA',
        position: 'AUX. ADMINISTRATIVO', rfc: 'AAAA-710715-AB1', imss: '01234567890',
        managementCode: '00004', sectionCode: '00001', companyCode: '00002', branchCode: '00003',
        scheduleTypeCode: '00000', hireDate: '2006-04-12', terminationDate: '2026-07-31',
      },
      {
        employeeNumber: '00000507', normalizedEmployeeNumber: '507', name: 'EMPLEADO PRUEBA',
        position: 'AUX. ADMINISTRATIVO', rfc: 'AAAA-710715-AB1', imss: '01234567890',
        managementCode: undefined, sectionCode: undefined, companyCode: '00002', branchCode: undefined,
        scheduleTypeCode: '00000', hireDate: '2006-04-12', terminationDate: undefined,
      },
    ]);
  });

  it('keeps pages separate and treats placeholders as empty values', () => {
    const first = employeeWords('00001008', 84).map(([text, left, top]): Word => [left === 292 || left === 352 ? '...' : text, left, top]);
    const secondPage = [...header, ...employeeWords('00001514', 84)].map(([text, left, top]): Word => [text, left, top, 2]);
    const records = parseEmployeeCatalog(toTsv([...header, ...first, ...secondPage]));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ employeeNumber: '00001008', rfc: undefined, imss: undefined });
    expect(records[1]).toMatchObject({ employeeNumber: '00001514', rfc: 'AAAA-710715-AB1' });
  });

  it('normalizes leading zeros but keeps an all-zero identifier valid', () => {
    expect(normalizeEmployeeNumber('00001514')).toBe('1514');
    expect(normalizeEmployeeNumber('00000000')).toBe('0');
  });

  it('rejects duplicate employee numbers', () => {
    expect(() => parseEmployeeCatalog(toTsv([...header, ...employeeWords('00001008', 84), ...employeeWords('00001008', 94)]))).toThrow('se repite');
  });

  it('separates names joined to a known position in the source PDF', () => {
    const overlapping = employeeWords('00003060', 94).filter((word) => word[1] !== 170);
    overlapping.push(['CASTAÑEDAAUX.', 164, 94]);
    const records = parseEmployeeCatalog(toTsv([...header, ...employeeWords('00001008', 84), ...overlapping]));
    expect(records[1]).toMatchObject({ name: 'EMPLEADO PRUEBA CASTAÑEDA', position: 'AUX. ADMINISTRATIVO' });
  });

  it('rejects invalid dates instead of importing shifted fields', () => {
    const words = employeeWords('00001008', 84).map(([text, left, top]): Word => [left === 530 ? '31/02/26' : text, left, top]);
    expect(() => parseEmployeeCatalog(toTsv([...header, ...words]))).toThrow('Fecha inválida');
  });
});
