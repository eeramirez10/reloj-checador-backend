export interface NameParts {
  firstName?: string;
  lastName?: string;
  method: 'single_name' | 'clock_reference' | 'given_first' | 'surname_first' | 'unknown';
}

const particles = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'DA', 'DAS', 'DO', 'DOS', 'VAN', 'VON', 'SAN', 'SANTA']);
// Las referencias del reloj y el orden del catálogo tienen prioridad sobre estas pistas de nombres.
const givenNameHints = new Set([
  'ABEL', 'ADRIAN', 'ALFREDO', 'ALICIA', 'ANA', 'ANDREA', 'ANGELICA', 'ARIEL', 'BERENICE', 'CARLOS',
  'CARMEN', 'CLAUDIA', 'DANIEL', 'DAVID', 'DIANA', 'EDUARDO', 'ELEAZAR', 'ELIZABETH', 'ENRIQUE',
  'ERICK', 'ERNESTO', 'FERNANDO', 'FRANCISCO', 'GABRIEL', 'GABRIELA', 'GERARDO', 'HECTOR', 'JAIME',
  'JAVIER', 'JESUS', 'JOEL', 'JORGE', 'JOSE', 'JUAN', 'JULIA', 'JULIO', 'LAURA', 'LUIS', 'MANUEL',
  'MARIA', 'MARIO', 'MAYRA', 'MIGUEL', 'MIRIAM', 'NADIA', 'OSCAR', 'PABLO', 'PAOLA', 'PATRICIA',
  'PEDRO', 'RAFAEL', 'RICARDO', 'ROBERTO', 'RODOLFO', 'ROLANDO', 'ROSA', 'RUBEN', 'SANDRA',
  'SERGIO', 'SILVIA', 'TERESA', 'VERONICA', 'VICTOR', 'NARDA', 'ISABEL', 'JIMMY', 'NORA', 'JULIETA',
  'GUADALUPE', 'LORENA', 'ALINA', 'AMERICA', 'ERIKA', 'ROCIO', 'ARACELI', 'ROSAURA', 'DOLORES',
  'SOLEDAD', 'LUCIA', 'LUISA', 'MARTHA', 'ALEJANDRA', 'ALEJANDRO', 'ANDRES', 'SALVADOR', 'ALFONSO',
]);
const compoundGivenNames = new Set(['CARMEN', 'DIOS', 'JESUS', 'ANGELES', 'PILAR', 'LUZ', 'DOLORES', 'GUADALUPE', 'ROSARIO', 'SOCORRO']);

function normalize(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function isPlaceholder(value: string): boolean {
  return !value || /^\d+$/.test(value) || /^(REGISTRO|USUARIO|USER)(\s+\S+)?$/.test(value) || /^(UNKNOWN|SIN NOMBRE)$/.test(value);
}

function surnameBoundary(words: string[]): number {
  let index = 0;
  for (let group = 0; group < 2; group += 1) {
    while (index < words.length - 1 && particles.has(normalize(words[index]))) index += 1;
    index += 1;
    if (normalize(words[index] ?? '') === 'Y' && index + 1 < words.length - 1) index += 2;
  }
  return Math.min(index, words.length - 1);
}

function splitGivenFirst(words: string[]): NameParts {
  let boundary = words.length;
  for (let group = 0; group < 2 && boundary > 0; group += 1) {
    boundary -= 1;
    while (boundary > 0 && particles.has(normalize(words[boundary - 1]))) boundary -= 1;
  }
  let knownPrefix = 1;
  while (knownPrefix < words.length - 1) {
    if (givenNameHints.has(normalize(words[knownPrefix]))) { knownPrefix += 1; continue; }
    let next = knownPrefix;
    while (next < words.length - 1 && particles.has(normalize(words[next]))) next += 1;
    if (next > knownPrefix && compoundGivenNames.has(normalize(words[next] ?? '')) && next < words.length - 1) knownPrefix = next + 1;
    else break;
  }
  boundary = Math.min(words.length - 1, Math.max(boundary, knownPrefix));
  return { firstName: words.slice(0, boundary).join(' '), lastName: words.slice(boundary).join(' ') || undefined, method: 'given_first' };
}

export function splitEmployeeName(fullName: string, surnameFirst: boolean, clockNames: string[] = []): NameParts {
  let words = fullName.trim().split(/\s+/);
  if (isPlaceholder(normalize(fullName))) {
    const reference = clockNames.find((name) => !isPlaceholder(normalize(name)));
    if (!reference) return { method: 'unknown' };
    words = reference.trim().split(/\s+/);
    surnameFirst = false;
  }
  if (words.length === 1) return { firstName: words[0], method: 'single_name' };
  const boundary = surnameBoundary(words);
  const references = [...new Set(clockNames.map(normalize).filter((name) => !isPlaceholder(name)))].sort((a, b) => b.length - a.length);
  for (const reference of references) {
    const target = reference.replaceAll(' ', '');
    for (let start = 0; start < words.length; start += 1) {
      for (let end = start + 1; end <= words.length; end += 1) {
        if (start === 0 && end === words.length) continue;
        if (normalize(words.slice(start, end).join(' ')).replaceAll(' ', '') !== target) continue;
        if (start === 0 && (!surnameFirst || givenNameHints.has(normalize(words[0])))) {
          const parts = end > 1 ? { firstName: words.slice(0, end).join(' '), lastName: words.slice(end).join(' ') } : splitGivenFirst(words);
          return { ...parts, method: 'clock_reference' };
        }
        if (start > 0 && !particles.has(normalize(words[start - 1]))
          && (end === words.length || (surnameFirst && start >= boundary && givenNameHints.has(normalize(words[start]))))) {
          const givenStart = surnameFirst && boundary <= start && words.slice(boundary, start).every((word) => givenNameHints.has(normalize(word)) || particles.has(normalize(word))) ? boundary : start;
          return { firstName: words.slice(givenStart).join(' '), lastName: words.slice(0, givenStart).join(' '), method: 'clock_reference' };
        }
      }
    }
  }
  if (givenNameHints.has(normalize(words[0])) && words.every((word) => givenNameHints.has(normalize(word)) || particles.has(normalize(word)) || compoundGivenNames.has(normalize(word)))) return { firstName: words.join(' '), method: 'single_name' };
  const surnameFirstTail = words.slice(boundary).every((word) => givenNameHints.has(normalize(word)) || particles.has(normalize(word)) || compoundGivenNames.has(normalize(word)));
  if (givenNameHints.has(normalize(words[0])) && !(surnameFirst && surnameFirstTail)) {
    return splitGivenFirst(words);
  }
  if (!surnameFirst && !(words.length >= 3 && surnameFirstTail)) return { firstName: words.join(' '), method: 'single_name' };
  return { firstName: words.slice(boundary).join(' '), lastName: words.slice(0, boundary).join(' '), method: 'surname_first' };
}
