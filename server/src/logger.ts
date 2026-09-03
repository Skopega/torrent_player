import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

type Level = 'info' | 'warn' | 'error';

class Logger {
  private stream: fs.WriteStream;

  constructor() {
    const dir = path.join(DATA_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    this.stream = fs.createWriteStream(path.join(dir, 'app.log'), { flags: 'a' });
  }

  private write(level: Level, msg: string) {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    process.stdout.write(line + '\n');
    this.stream.write(line + '\n');
  }

  info(msg: string) {
    this.write('info', msg);
  }

  warn(msg: string) {
    this.write('warn', msg);
  }

  error(msg: string) {
    this.write('error', msg);
  }
}

export const log = new Logger();
