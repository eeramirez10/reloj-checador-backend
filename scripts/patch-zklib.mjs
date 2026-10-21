import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const decoderPath = join(dirname(require.resolve('node-zklib')), 'utils.js');
const source = await readFile(decoderPath, 'utf8');
const verificationTypeField = 'verificationType: recordData.readUInt8(26)';
const punchStateField = 'punchState: recordData.readUInt8(31)';

if (source.includes(verificationTypeField) && source.includes(punchStateField)) process.exit(0);

const recordTimeField = '        recordTime: parseTimeToDate(recordData.readUInt32LE(27)),';
if (!source.includes(recordTimeField)) {
  throw new Error('La versión instalada de node-zklib cambió; revisa manualmente el decodificador de checadas.');
}

const patchedSource = source.replace(
  recordTimeField,
  `        ${verificationTypeField},\n${recordTimeField}\n        ${punchStateField},`,
);

await writeFile(decoderPath, patchedSource);
