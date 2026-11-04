// The little of node:sqlite and Vite's ?raw imports the D1 stand-in (d1.ts) uses: the Worker's
// tsconfig has no Node types
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): {
      get(...params: unknown[]): unknown
      all(...params: unknown[]): unknown[]
      run(...params: unknown[]): { changes: number | bigint }
    }
  }
}

declare module '*.sql?raw' {
  const sql: string
  export default sql
}
