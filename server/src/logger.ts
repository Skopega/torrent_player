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
    // Санитизация управляющих символов: пользовательские строки (запросы, url, msg
    // клиента) не должны подделывать структуру лога для панели-супервизора.
    const clean = msg.replace(/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (c) =>
      c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'),
    );
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${clean}`;
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
