import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import { Rpc } from '../agent/codex';

describe('official runtime protocol', () => {
  it('correlates replies and propagates provider errors', async () => {
    const rpc = new Rpc(process.execPath, [
      '-e',
      `require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);console.log(JSON.stringify(m.method==='fail'?{id:m.id,error:{message:'Cuenta sin acceso'}}:{id:m.id,result:{ok:true}}));})`,
    ]);
    try {
      expect(await rpc.request('status')).toEqual({ ok: true });
      await expect(rpc.request('fail')).rejects.toThrow('Cuenta sin acceso');
    } finally {
      rpc.close();
    }
  });
  it('fails pending work when the runtime disconnects', async () => {
    const rpc = new Rpc(process.execPath, ['-e', `process.stdin.once('data',()=>process.exit(1))`]);
    await expect(rpc.request('status')).rejects.toThrow('cerró');
    rpc.close();
  });
  it('rejects new work immediately after cancellation', async () => {
    const rpc = new Rpc(process.execPath, ['-e', `process.stdin.resume()`]);
    const pending = rpc.request('long');
    const rejected = expect(pending).rejects.toThrow('finalizado');
    rpc.close();
    await rejected;
    const start = Date.now();
    await expect(rpc.request('status', {}, 200)).rejects.toThrow('finalizado');
    expect(Date.now() - start).toBeLessThan(100);
  });
  it('rejects malformed output and unavailable runtimes', async () => {
    const malformed = new Rpc(process.execPath, [
      '-e',
      `process.stdin.once('data',()=>console.log('not-json'))`,
    ]);
    await expect(malformed.request('status')).rejects.toThrow('inválida');
    malformed.close();
    const missing = new Rpc('/missing/lupino-runtime', []);
    await expect(missing.request('status')).rejects.toThrow('iniciar');
    missing.close();
  });
});
