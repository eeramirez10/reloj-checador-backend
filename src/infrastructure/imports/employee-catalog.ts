import { normalizeEmployeeNumber, type EmployeeCatalogRecord } from '../../domain/entities/employee.js';
export { normalizeEmployeeNumber, type EmployeeCatalogRecord, type EmploymentStatus } from '../../domain/entities/employee.js';

interface CatalogPageColumns {
  position: number;
  rfc: number;
  imss: number;
  managementCode: number;
  sectionCode: number;
  companyCode: number;
  branchCode: number;
  scheduleTypeCode: number;
  hireDate: number;
  terminationDate: number;
}

interface CatalogWord {
  page: number;
  left: number;
  top: number;
  width: number;
  text: string;
}

function getColumnPosition(header: CatalogWord[], label: string): number {
  const position = header.find((word) => word.text === label)?.left;
  if (position === undefined) throw new Error(`No se encontró la columna ${label} en el catálogo.`);
  return position;
}

function getPageColumns(header: CatalogWord[]): CatalogPageColumns {
  return {
    position: getColumnPosition(header, 'Puesto'),
    // Los encabezados RFC, IMSS y Alta están desplazados respecto al inicio de sus datos.
    rfc: getColumnPosition(header, 'RFC') - 18,
    imss: getColumnPosition(header, 'IMSS') - 10,
    managementCode: getColumnPosition(header, 'Gere'),
    sectionCode: getColumnPosition(header, 'Secc'),
    companyCode: getColumnPosition(header, 'Empr'),
    branchCode: getColumnPosition(header, 'Sucu'),
    scheduleTypeCode: getColumnPosition(header, 'Horario'),
    hireDate: getColumnPosition(header, 'Alta') - 5,
    terminationDate: getColumnPosition(header, 'Baja'),
  };
}

function cleanCell(value: string): string | undefined {
  const trimmed = value.trim();
  return !trimmed || trimmed === '...' ? undefined : trimmed;
}

function readDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(value);
  if (!match) throw new Error(`Fecha inválida en el catálogo: ${value}.`);

  const day = Number(match[1]);
  const month = Number(match[2]);
  const shortYear = Number(match[3]);
  const year = shortYear >= 50 ? 1900 + shortYear : 2000 + shortYear;
  const date = new Date(Date.UTC(year, month - 1, day));

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Fecha inválida en el catálogo: ${value}.`);
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function readCell(words: CatalogWord[], start: number, end = Infinity): string | undefined {
  return cleanCell(words.filter((word) => word.left >= start && word.left < end).map((word) => word.text).join(' '));
}

function readCode(words: CatalogWord[], start: number, end: number): string | undefined {
  const value = readCell(words, start, end);
  if (value && !/^\d{5}$/.test(value)) throw new Error(`Código inválido en el catálogo: ${value}.`);
  return value;
}

function readWords(text: string): CatalogWord[] {
  if (!text.startsWith('level\tpage_num\t')) throw new Error('El catálogo debe extraerse con pdftotext -tsv.');
  return text.split('\n').flatMap((line) => {
    const fields = line.split('\t');
    if (fields[0] !== '5') return [];
    const page = Number(fields[1]);
    const left = Number(fields[6]);
    const top = Number(fields[7]);
    const width = Number(fields[8]);
    const value = fields.slice(11).join('\t').trim();
    if (![page, left, top, width].every(Number.isFinite) || !value) throw new Error('Coordenadas inválidas en el catálogo.');
    return [{ page, left, top, width, text: value }];
  });
}

function separateOverlappingPosition(row: CatalogWord[], positionColumn: number, positionStarts: Set<string>): CatalogWord[] {
  if (row.some((word) => Math.abs(word.left - positionColumn) < 1)) return row;

  // El PDF une algunos apellidos con el puesto; solo se separan inicios de puesto presentes en otras filas.
  return row.flatMap((word) => {
    if (word.left >= positionColumn || word.left + word.width <= positionColumn) return [word];
    const candidates = [...positionStarts].filter((start) => word.text.endsWith(start) && word.text !== start);
    if (candidates.length !== 1) throw new Error(`No se pudo separar el nombre y puesto: ${word.text}.`);
    const position = candidates[0];
    return [
      { ...word, text: word.text.slice(0, -position.length), width: positionColumn - word.left },
      { ...word, text: position, left: positionColumn, width: word.left + word.width - positionColumn },
    ];
  }).sort((left, right) => left.left - right.left);
}

export function parseEmployeeCatalog(text: string): EmployeeCatalogRecord[] {
  const records: EmployeeCatalogRecord[] = [];
  const normalizedIds = new Set<string>();
  const words = readWords(text);

  for (const pageNumber of new Set(words.map((word) => word.page))) {
    const page = words.filter((word) => word.page === pageNumber);
    const headerAnchor = page.find((word) => word.text === 'Puesto');
    if (!headerAnchor) continue;
    const header = page.filter((word) => Math.abs(word.top - headerAnchor.top) < 1);
    const columns = getPageColumns(header);
    const positionStarts = new Set(words.filter((word) => word.top > headerAnchor.top
      && Math.abs(word.left - columns.position) < 1).map((word) => word.text));
    const numberColumn = getColumnPosition(header, 'Número');
    const employeeAnchors = page.filter((word) => word.top > headerAnchor.top
      && Math.abs(word.left - numberColumn) < 1 && /^\d{8}$/.test(word.text));

    for (const anchor of employeeAnchors) {
      const employeeNumber = anchor.text;
      const normalizedEmployeeNumber = normalizeEmployeeNumber(employeeNumber);
      if (normalizedIds.has(normalizedEmployeeNumber)) {
        throw new Error(`El número de empleado ${employeeNumber} se repite en el catálogo.`);
      }
      normalizedIds.add(normalizedEmployeeNumber);

      const row = separateOverlappingPosition(
        page.filter((word) => Math.abs(word.top - anchor.top) < 1).sort((left, right) => left.left - right.left),
        columns.position,
        positionStarts,
      );
      const separator = row.find((word) => word.text === '-' && word.left > anchor.left && word.left < columns.position);
      if (!separator) throw new Error(`No se pudo leer el nombre del empleado ${employeeNumber}.`);
      const name = readCell(row, separator.left + 1, columns.position);
      const hireDate = readDate(readCell(row, columns.hireDate, columns.terminationDate));
      if (!name || !hireDate) throw new Error(`Faltan datos del empleado ${employeeNumber}.`);
      const record: EmployeeCatalogRecord = {
        employeeNumber,
        normalizedEmployeeNumber,
        name,
        position: readCell(row, columns.position, columns.rfc),
        rfc: readCell(row, columns.rfc, columns.imss),
        imss: readCell(row, columns.imss, columns.managementCode),
        managementCode: readCode(row, columns.managementCode, columns.sectionCode),
        sectionCode: readCode(row, columns.sectionCode, columns.companyCode),
        companyCode: readCode(row, columns.companyCode, columns.branchCode),
        branchCode: readCode(row, columns.branchCode, getColumnPosition(header, 'Tipo')),
        scheduleTypeCode: readCode(row, columns.scheduleTypeCode, columns.hireDate),
        hireDate,
        terminationDate: readDate(readCell(row, columns.terminationDate)),
      };

      records.push(record);
    }
  }

  if (records.length === 0) throw new Error('No se encontraron empleados en el documento.');
  return records;
}
