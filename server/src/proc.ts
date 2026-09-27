import os from 'node:os';
import type { ChildProcess } from 'node:child_process';

// Управление приоритетами процессов: ffmpeg грузит CPU (даже с аппаратным кодеком
// остаются декод/фильтры/драйвер), из-за чего слабый сервер (i3-9100) не успевает
// отдавать HLS-сегменты, и плеер зависает. Понижаем приоритет ffmpeg и держим Node
// (HTTP/HLS) приоритетнее — тогда отдача сегментов не ждёт CPU.
//
// os.setPriority принимает nice-значение; на Linux отрицательные (выше normal)
// требуют прав (в контейнере мы root), на Windows маппится на PriorityClass.

export function lowerChildPriority(proc: ChildProcess): void {
  try {
    if (proc.pid) os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* нет прав / не поддерживается — не критично */
  }
}

export function raiseSelfPriority(): void {
  try {
    os.setPriority(process.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
  } catch {
    /* нет прав — не критично */
  }
}
