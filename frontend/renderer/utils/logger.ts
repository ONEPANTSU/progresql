/**
 * Structured logger for the renderer process.
 *
 * Provides leveled logging (debug, info, warn, error) with component context.
 * In production builds, debug-level messages are suppressed.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getMinLevel(): LogLevel {
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') {
    return 'info';
  }
  return 'debug';
}

class Logger {
  private component: string;

  constructor(component: string) {
    this.component = component;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[getMinLevel()];
  }

  debug(message: string, ...args: any[]): void {
    if (this.shouldLog('debug')) {
      console.log(`[${this.component}]`, message, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.shouldLog('info')) {
      console.log(`[${this.component}]`, message, ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.shouldLog('warn')) {
      console.warn(`[${this.component}]`, message, ...args);
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.shouldLog('error')) {
      console.error(`[${this.component}]`, message, ...args);
    }
  }
}

/**
 * Create a logger instance scoped to a component or module.
 *
 * @param component - Name of the component/module (e.g., 'SQLEditor', 'AgentService')
 */
export function createLogger(component: string): Logger {
  return new Logger(component);
}
