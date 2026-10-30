import { DurableObject } from 'cloudflare:workers'

// One object per room: the room's single source of truth (ARCHITECTURE.md §2). A1 only deploys
// the class so the binding and its first migration exist; signalling arrives in A3 (e2-t02).
export class RoomDO extends DurableObject {
  async fetch(): Promise<Response> {
    return Response.json({ error: 'not_implemented' }, { status: 501 })
  }
}
