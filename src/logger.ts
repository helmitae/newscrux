import { config } from './config.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

function format(level: string, module: string, message: string): string {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] [${module}] ${message}`;
}

export function createLogger(module: string) {
  return {
    debug: (msg: string) => {
      if (currentLevel <= LEVELS.debug) console.log(format('debug', module, msg));
    },
    info: (msg: string) => {
      if (currentLevel <= LEVELS.info) console.log(format('info', module, msg));
    },
    warn: (msg: string) => {
      if (currentLevel <= LEVELS.warn) console.warn(format('warn', module, msg));
    },
    error: (msg: string, err?: unknown) => {
      if (currentLevel <= LEVELS.error) {
        console.error(format('error', module, msg));
        if (err) console.error(err);
      }
    },
  };
}
