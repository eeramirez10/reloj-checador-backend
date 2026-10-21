process.once('message', (request) => {
  if (request.device.name === 'crash') {
    setImmediate(() => {
      const reply = null;
      reply.subarray(0, 16);
    });
    return;
  }
  if (request.device.name === 'hang') {
    setInterval(() => {}, 1_000);
    return;
  }
  if (request.device.name === 'invalid') {
    process.send({ type: 'invalid' });
    setInterval(() => {}, 1_000);
    return;
  }
  const occurredAt = new Date('2025-10-22T14:30:00Z');
  const values = {
    testConnection: { raw: { connected: true } },
    getAttendance: [{ deviceLogId: 'isolated-record', userId: '1', occurredAt, raw: { recordTime: occurredAt } }],
    getUsers: [{ userId: '0015', name: 'Ana Prueba', raw: { userId: '0015' } }],
  };
  process.send({ type: 'success', value: values[request.operation] }, () => process.exit(0));
});
