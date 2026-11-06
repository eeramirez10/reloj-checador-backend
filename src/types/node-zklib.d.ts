declare module 'node-zklib' {
  class ZKLib {
    connectionType: 'tcp' | 'udp' | null;
    zklibTcp: { socket: import('node:events').EventEmitter; readWithBuffer(request: Buffer): Promise<{ data: Buffer; err?: unknown }> };
    zklibUdp: { socket: import('node:events').EventEmitter; readWithBuffer(request: Buffer): Promise<{ data: Buffer; err?: unknown }> };
    constructor(ip: string, port: number, timeout: number, inPort: number);
    createSocket(): Promise<void>;
    disconnect(): Promise<void>;
    getInfo(): Promise<unknown>;
    getAttendances(): Promise<{ data?: Record<string, unknown>[]; err?: unknown }>;
    getUsers(): Promise<{ data?: Record<string, unknown>[]; err?: unknown }>;
    executeCmd(command: number, data?: Buffer | string): Promise<Buffer>;
    freeData(): Promise<unknown>;
  }
  export = ZKLib;
}
