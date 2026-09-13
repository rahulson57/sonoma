/**
 * Minimal ambient typings for Node's built-in `node:sqlite` (Node >= 22.13 unflagged).
 *
 * The project pins @types/node 20.x, which predates `node:sqlite`, and package.json belongs to S01, so
 * Local Storage declares only the subset of the API it uses. Remove this file when @types/node ships
 * the module (a duplicate class declaration would then fail typecheck, which is the intended signal).
 */
declare module 'node:sqlite' {
  type SQLInputValue = null | number | bigint | string | Uint8Array;
  type SQLOutputValue = null | number | bigint | string | Uint8Array;

  interface DatabaseSyncOptions {
    open?: boolean;
    enableForeignKeyConstraints?: boolean;
  }

  interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  class StatementSync {
    all(...anonymousParameters: SQLInputValue[]): Array<Record<string, SQLOutputValue>>;
    get(...anonymousParameters: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    run(...anonymousParameters: SQLInputValue[]): StatementResultingChanges;
  }

  class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
