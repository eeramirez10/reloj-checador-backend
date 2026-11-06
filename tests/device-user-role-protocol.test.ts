import { createServer,type Socket } from 'node:net';
import { createRequire } from 'node:module';
import { createSocket } from 'node:dgram';
import { describe,expect,it } from 'vitest';
import { NodeZkLibClient } from '../src/infrastructure/integrations/zkteco/node-zklib-client.js';
import { decodeRawUsers,userRecordWithRole } from '../src/infrastructure/integrations/zkteco/user-role-codec.js';
import type { Device } from '../src/domain/entities/device.js';

const require=createRequire(import.meta.url);
const { createTCPHeader }=require('node-zklib/utils') as { createTCPHeader(command:number,session:number,reply:number,data:Buffer):Buffer };
function record(size:28|72,uid:number,userId:string,role:number) {
  const data=Buffer.alloc(size,0x31); data.writeUInt16LE(uid,0); data.writeUInt8(role,2);
  if (size===28) data.writeUInt32LE(Number(userId),24);
  else { data.fill(0,48,72); data.write(userId,48,'ascii'); }
  return data;
}
function catalog(records:Buffer[]) { const data=Buffer.concat(records); const header=Buffer.alloc(4); header.writeUInt32LE(data.length); return Buffer.concat([header,data]); }

describe('individual device role protocol and lossless record updates',()=>{
  it('changes only the role byte in both supported record formats and rejects partial, duplicate or unsupported catalogs',()=>{
    for(const size of [28,72] as const) {
      const original=record(size,2,'1527',14); const [user]=decodeRawUsers(catalog([original]),1);
      const updated=userRecordWithRole(user,0);
      expect(updated[2]).toBe(0); expect(original[2]).toBe(14);
      for(let index=0;index<size;index++) if(index!==2) expect(updated[index]).toBe(original[index]);
      expect(()=>decodeRawUsers(catalog([original]).subarray(0,-1),1)).toThrow('incompleto');
      expect(()=>decodeRawUsers(catalog([original,original]),2)).toThrow('duplicadas');
    }
    expect(()=>decodeRawUsers(catalog([Buffer.alloc(120)]),1)).toThrow('formato');
    const bad=record(72,2,'1527',0); bad[48]=0xb1;
    expect(()=>decodeRawUsers(catalog([bad]),1)).toThrow('inválidas');
  });

  it('round-trips the real isolated TCP worker, permits multiple admins, blocks the last, and preserves all other bytes and users',async()=>{
    const sockets=new Set<Socket>(); const commands:number[]=[];
    let users=[record(72,2,'1527',14),record(72,3,'3040',14),record(72,4,'1517',0)];
    let rejectWrite=false; let ignoreWrite=false; let alterOtherField=false; let truncate=false; let wrongCount=false;
    const server=createServer((socket)=>{
      sockets.add(socket); socket.once('close',()=>sockets.delete(socket)); let pending=Buffer.alloc(0);
      socket.on('data',(data)=>{
        pending=Buffer.concat([pending,data]);
        while(pending.length>=16) {
          const length=8+pending.readUInt16LE(4); if(pending.length<length)return;
          const packet=pending.subarray(0,length); pending=pending.subarray(length);
          const command=packet.readUInt16LE(8); commands.push(command); let code=2000; let payload=Buffer.alloc(0);
          if(command===50) {payload=Buffer.alloc(72);payload.writeUInt32LE(users.length+(wrongCount?1:0),16);}
          if(command===1503) {code=1501;payload=catalog(users);if(truncate)payload=payload.subarray(0,-1);}
          if(command===8) {
            if(rejectWrite)code=2001;
            else if(!ignoreWrite) { const changed=Buffer.from(packet.subarray(16));users=users.map((user)=>user.readUInt16LE(0)===changed.readUInt16LE(0)?changed:user);if(alterOtherField)users[0][3]^=1; }
          }
          socket.write(createTCPHeader(code,1,0,payload));
        }
      });
    });
    await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
    try {
      const address=server.address();if(!address||typeof address==='string')throw new Error('Missing test clock');
      const device:Device={id:'clock',name:'Test clock',ipAddress:'127.0.0.1',tcpPort:address.port,driver:'node',enabled:true,syncIntervalSeconds:60,createdAt:new Date(),updatedAt:new Date()};
      const client=new NodeZkLibClient(2000,5200,{operationTimeoutMs:10000});const target={userId:'1527',uid:2};
      const before=users.map((user)=>Buffer.from(user));
      expect(await client.getUserRole(device,target)).toMatchObject({...target,role:14,administratorCount:2,totalUsers:3});
      const demoted=await client.setUserRole(device,{...target,expectedRole:14,role:0});expect(demoted.status).toBe('succeeded');
      const expected=Buffer.from(before[0]);expected[2]=0;expect(users[0]).toEqual(expected);expect(users.slice(1)).toEqual(before.slice(1));
      const promoted=await client.setUserRole(device,{...target,expectedRole:0,role:14});expect(promoted.after?.administratorCount).toBe(2);
      const writes=()=>commands.filter((command)=>command===8).length;
      const currentWrites=writes();
      expect((await client.setUserRole(device,{...target,expectedRole:0,role:14})).code).toBe('STALE_ROLE');expect(writes()).toBe(currentWrites);
      users[1][2]=0;
      expect((await client.setUserRole(device,{...target,expectedRole:14,role:0})).code).toBe('LAST_ADMIN');expect(writes()).toBe(currentWrites);
      users[1][2]=14;
      rejectWrite=true;expect((await client.setUserRole(device,{...target,expectedRole:14,role:0})).code).toBe('WRITE_REJECTED');rejectWrite=false;
      ignoreWrite=true;expect((await client.setUserRole(device,{...target,expectedRole:14,role:0})).status).toBe('unconfirmed');ignoreWrite=false;
      alterOtherField=true;expect((await client.setUserRole(device,{...target,expectedRole:14,role:0})).status).toBe('unconfirmed');alterOtherField=false;
      users=before.map((user)=>Buffer.from(user));
      const safeWrites=writes();
      expect((await client.setUserRole(device,{...target,uid:99,expectedRole:14,role:0})).status).toBe('failed');
      truncate=true;expect((await client.setUserRole(device,{...target,expectedRole:14,role:0})).status).toBe('failed');truncate=false;
      wrongCount=true;expect((await client.setUserRole(device,{...target,expectedRole:14,role:0})).status).toBe('failed');wrongCount=false;
      expect(writes()).toBe(safeWrites);
      expect(commands.every((command)=>[1000,1001,50,1502,1503,8,1013].includes(command))).toBe(true);
      expect(JSON.stringify(demoted)).not.toContain('record');expect(JSON.stringify(demoted)).not.toContain('password');
    } finally {for(const socket of sockets)socket.destroy();await new Promise<void>((resolve)=>server.close(()=>resolve()));}
  },30000);

  it('preserves a 28-byte user record through the isolated UDP fallback',async()=>{
    const {createUDPHeader}=require('node-zklib/utils') as {createUDPHeader(command:number,session:number,reply:number,data:Buffer):Buffer};
    const socket=createSocket('udp4');let users=[record(28,2,'1527',14),record(28,3,'3040',14)];const original=users.map((item)=>Buffer.from(item));
    const commands:number[]=[];
    socket.on('message',(packet,remote)=>{
      const command=packet.readUInt16LE(0);commands.push(command);let code=2000;let payload=Buffer.alloc(0);
      if(command===50){payload=Buffer.alloc(72);payload.writeUInt32LE(users.length,16);}
      if(command===1503){code=1501;payload=catalog(users);}
      if(command===8){const changed=Buffer.from(packet.subarray(8));users=users.map((item)=>item.readUInt16LE(0)===changed.readUInt16LE(0)?changed:item);}
      socket.send(createUDPHeader(code,1,0,payload),remote.port,remote.address);
    });
    await new Promise<void>((resolve)=>socket.bind(0,'127.0.0.1',resolve));
    try{
      const address=socket.address();const device:Device={id:'udp',name:'UDP clock',ipAddress:'127.0.0.1',tcpPort:address.port,driver:'node',enabled:true,syncIntervalSeconds:60,createdAt:new Date(),updatedAt:new Date()};
      const client=new NodeZkLibClient(2000,0,{operationTimeoutMs:10000});
      const changed=await client.setUserRole(device,{userId:'1527',uid:2,expectedRole:14,role:0});expect(changed.status).toBe('succeeded');
      const expected=Buffer.from(original[0]);expected[2]=0;expect(users[0]).toEqual(expected);expect(users[1]).toEqual(original[1]);
      expect((await client.getUserRole(device,{userId:'1527',uid:2})).role).toBe(0);
      expect(commands.every((command)=>[1000,1001,50,1502,1503,8,1013].includes(command))).toBe(true);
    }finally{await new Promise<void>((resolve)=>socket.close(resolve));}
  },20000);
});
