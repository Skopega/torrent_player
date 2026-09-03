// Менеджер xray-core: конфиг, запуск, ожидание порта, health, pidfile.
// Поддерживает произвольный http-порт (для пинг-теста нод) и фикс-порт активной прокси.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DATA_DIR } from '../store.js';
import { log } from '../logger.js';
import { toXrayOutbound, type VlessNode } from './vless.js';

export function xrayBinPath(): string {
  if (process.env.XRAY_BIN) return path.resolve(process.env.XRAY_BIN);
  const root = path.resolve(DATA_DIR, '..');
  return path.join(root, 'runtime', 'xray', process.platform === 'win32' ? 'xray.exe' : 'xray');
}

export interface XrayConfig {
  log: { loglevel: string };
  inbounds: unknown[];
  outbounds: unknown[];
  routing: { rules: unknown[] };
}

export function buildXrayConfig(outbound: unknown, port: number): XrayConfig {
  const tag = (outbound as { tag?: string }).tag ?? 'proxy';
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'http-in',
        port,
        listen: '127.0.0.1',
        protocol: 'http',
        settings: { timeout: 30 },
      },
    ],
    outbounds: [outbound, { protocol: 'freedom', tag: 'direct' }],
    routing: { rules: [{ type: 'field', inboundTag: ['http-in'], outboundTag: tag }] },
  };
}

export class XrayManager {
  private proc: ChildProcess | null = null;
  private readonly port: number;
  private readonly configPath: string;
  private readonly pidPath: string;

  constructor(port: number) {
    this.port = port;
    this.configPath = path.join(DATA_DIR, 'vpn', `xray-${port}.json`);
    this.pidPath = path.join(DATA_DIR, 'vpn', `xray-${port}.pid`);
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }

  get httpPort(): number {
    return this.port;
  }

  async start(node: VlessNode, tag = 'proxy'): Promise<void> {
    const bin = xrayBinPath();
    if (!fs.existsSync(bin)) {
      throw new Error(`xray не найден: ${bin}. Запустите: node scripts/fetch-xray.cjs`);
    }
    // Осиротевший xray прошлого запуска на этом порту (например, после taskkill) — убить.
    await this.killStale();

    const config = buildXrayConfig(toXrayOutbound(node, tag), this.port);
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(bin, ['run', '-c', this.configPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      this.proc = proc;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        reject(err);
      };

      proc.once('error', (err) => fail(new Error(`xray запуск: ${err.message}`)));
      proc.stderr?.on('data', (d) => {
        const text = String(d).trim();
        if (text) log.warn(`[xray] ${text.slice(0, 500)}`);
      });
      const timer = setTimeout(() => fail(new Error('xray не поднялся за 8с')), 8000);
      proc.once('exit', (code) => {
        if (settled) return;
        fail(new Error(`xray завершился при старте (код ${code})`));
      });

      this.waitTcp(this.port, 8000)
        .then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            fs.writeFileSync(this.pidPath, String(proc.pid));
          } catch {
            /* ignore */
          }
          log.info(`[xray] up on 127.0.0.1:${this.port} (${node.name}) pid=${proc.pid}`);
          resolve();
        })
        .catch(() => fail(new Error(`xray не слушает порт ${this.port}`)));
    });
  }

  private waitTcp(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = () => {
        const s = net.connect({ host: '127.0.0.1', port });
        const done = (ok: boolean) => {
          s.destroy();
          if (ok) resolve();
          else if (Date.now() > deadline) reject(new Error('timeout'));
          else setTimeout(tick, 200);
        };
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
      };
      tick();
    });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) {
      const pid = proc.pid;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, 1500);
        proc.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
      if (proc.exitCode === null && pid) this.killPid(pid);
    }
    try {
      fs.rmSync(this.pidPath, { force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(this.configPath, { force: true });
    } catch {
      /* ignore */
    }
  }

  private async killStale(): Promise<void> {
    let pidStr = '';
    try {
      pidStr = fs.existsSync(this.pidPath) ? fs.readFileSync(this.pidPath, 'utf8').trim() : '';
    } catch {
      return;
    }
    const pid = Number(pidStr);
    if (Number.isInteger(pid) && pid > 0 && this.isAlive(pid)) {
      log.warn(`[xray] stale pid ${pid} on port ${this.port} — killing`);
      this.killPid(pid);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private killPid(pid: number): void {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      /* ignore */
    }
  }
}
