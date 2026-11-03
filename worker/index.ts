import { handleRequest, type Env } from './app.ts'

// The Durable Object classes must be exported from the Worker's entry module
export { RoomDO } from './room.ts'
export { TelemetryDO } from './telemetry-do.ts'
export { UsageDO } from './usage-do.ts'
export { GuardDO } from './guard-do.ts'

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>
