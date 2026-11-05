// The bit of node:zlib the restore drill uses: the Worker's tsconfig has no @types/node
declare module 'node:zlib' {
  export function gunzipSync(data: Uint8Array): { toString(encoding: 'utf8'): string }
}
