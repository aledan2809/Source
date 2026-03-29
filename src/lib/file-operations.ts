import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { logger } from './logger';

/**
 * Simple file locking mechanism to prevent race conditions
 * Uses filesystem-based mutex for the MVP (production should use Redis/DB locks)
 */
class FileLock {
  private locks = new Map<string, Promise<void>>();

  async withLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
    // Wait for existing lock to release
    const existingLock = this.locks.get(lockKey);
    if (existingLock) {
      await existingLock;
    }

    // Create new lock
    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.locks.set(lockKey, lockPromise);

    try {
      const result = await operation();
      return result;
    } finally {
      // Release lock
      this.locks.delete(lockKey);
      releaseLock!();
    }
  }
}

const fileLock = new FileLock();

/**
 * Safe read operation for JSON files
 */
export async function safeReadJSON<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    if (!existsSync(filePath)) {
      return defaultValue;
    }
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    logger.warn(`Error reading JSON file`, { filePath, error: String(error) });
    return defaultValue;
  }
}

/**
 * Safe write operation for JSON files with locking
 */
export async function safeWriteJSON<T>(filePath: string, data: T): Promise<void> {
  const lockKey = filePath;

  await fileLock.withLock(lockKey, async () => {
    try {
      // Ensure directory exists
      const dir = path.dirname(filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      // Write file
      await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      logger.error(`Error writing JSON file`, { filePath, error: String(error) });
      throw error;
    }
  });
}

/**
 * Safe update operation for JSON files with locking
 */
export async function safeUpdateJSON<T>(
  filePath: string,
  defaultValue: T,
  updateFn: (current: T) => T
): Promise<void> {
  const lockKey = filePath;

  await fileLock.withLock(lockKey, async () => {
    // Read current data
    const current = await safeReadJSON(filePath, defaultValue);

    // Apply update function
    const updated = updateFn(current);

    // Write updated data
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(filePath, JSON.stringify(updated, null, 2), 'utf8');
  });
}

/**
 * Paths for data files
 */
export const DATA_PATHS = {
  SEARCH_LOG: path.join(process.cwd(), 'src', 'data', 'search-log.json'),
  RESULTS_DIR: path.join(process.cwd(), 'src', 'data', 'results'),
  AI_LEARNINGS: path.join(process.cwd(), 'src', 'data', 'ai-learnings.json'),
  UPLOADS_DIR: path.join(process.cwd(), 'uploads'),
} as const;

/**
 * Helper to get result file path
 */
export function getResultPath(id: string): string {
  return path.join(DATA_PATHS.RESULTS_DIR, `${id}.json`);
}