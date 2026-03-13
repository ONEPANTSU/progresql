/**
 * Structured logger for the main process.
 *
 * Provides leveled logging (debug, info, warn, error) with component context.
 * In production (app.isPackaged), debug-level messages are suppressed.
 */

const LOG_LEVEL_PRIORITY = { debug: 0, info: 1, warn: 2, error: 3 };

function getMinLevel() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return 'info';
  } catch (_) {
    // Not in Electron context
  }
  return 'debug';
}

function shouldLog(level) {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[getMinLevel()];
}

function createLogger(component) {
  return {
    debug(message, ...args) {
      if (shouldLog('debug')) console.log(`[${component}]`, message, ...args);
    },
    info(message, ...args) {
      if (shouldLog('info')) console.log(`[${component}]`, message, ...args);
    },
    warn(message, ...args) {
      if (shouldLog('warn')) console.warn(`[${component}]`, message, ...args);
    },
    error(message, ...args) {
      if (shouldLog('error')) console.error(`[${component}]`, message, ...args);
    },
  };
}

module.exports = { createLogger };
