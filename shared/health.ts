// What GET /api/health answers: the Worker is up and which commit it runs.
export interface HealthResponse {
  ok: true
  version: string
}
