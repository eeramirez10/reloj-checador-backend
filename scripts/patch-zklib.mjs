import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const libraryDirectory = dirname(require.resolve('node-zklib'));
const decoderPath = join(libraryDirectory, 'utils.js');
const source = await readFile(decoderPath, 'utf8');
const verificationTypeField = 'verificationType: recordData.readUInt8(26)';
const punchStateField = 'punchState: recordData.readUInt8(31)';

const recordTimeField = '        recordTime: parseTimeToDate(recordData.readUInt32LE(27)),';
if (!source.includes(verificationTypeField) || !source.includes(punchStateField)) {
  if (!source.includes(recordTimeField)) {
    throw new Error('La versión instalada de node-zklib cambió; revisa manualmente el decodificador de checadas.');
  }
  await writeFile(decoderPath, source.replace(
    recordTimeField,
    `        ${verificationTypeField},\n${recordTimeField}\n        ${punchStateField},`,
  ));
}

const tcpPath = join(libraryDirectory, 'zklibtcp.js');
let tcpSource = await readFile(tcpPath, 'utf8');
const newline = tcpSource.includes('\r\n') ? '\r\n' : '\n';
const responseMarker = "new Error('INVALID_TCP_BUFFER_RESPONSE')";
const sizeMarker = "new Error('INVALID_TCP_BUFFER_SIZE')";

function replaceRequired(source, before, after) {
  if (!source.includes(before)) {
    throw new Error('La versión instalada de node-zklib cambió; revisa manualmente el manejo de respuestas TCP.');
  }
  return source.replace(before, after);
}

if (!tcpSource.includes(responseMarker)) {
  // El ejecutor async de la dependencia continúa después de reject si no se retorna.
  const before = [
    '        reply = await this.requestData(buf)', '', '      } catch (err) {', '        reject(err)', '      }', '',
    '      const header = decodeTCPHeader(reply.subarray(0, 16))',
  ].join(newline);
  const after = [
    '        reply = await this.requestData(buf)', '', '      } catch (err) {', '        return reject(err)', '      }', '',
    '      if (!Buffer.isBuffer(reply) || reply.length < 16) {', `        return reject(${responseMarker})`, '      }', '',
    '      const header = decodeTCPHeader(reply.subarray(0, 16))',
  ].join(newline);
  tcpSource = replaceRequired(tcpSource, before, after);
}

if (!tcpSource.includes(sizeMarker)) {
  const before = ['          const recvData = reply.subarray(16)', '          const size = recvData.readUIntLE(1, 4)'].join(newline);
  const after = [
    '          const recvData = reply.subarray(16)', '          if (recvData.length < 5) {',
    `            return reject(${sizeMarker})`, '          }', '          const size = recvData.readUIntLE(1, 4)',
  ].join(newline);
  tcpSource = replaceRequired(tcpSource, before, after);
}

if (tcpSource !== await readFile(tcpPath, 'utf8')) await writeFile(tcpPath, tcpSource);
