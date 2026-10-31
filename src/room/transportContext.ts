import { createContext, useContext } from 'react'
import { sfuApiBase } from '../../shared/sfu.ts'
import { CloudflareRealtimeTransport } from '../media/CloudflareRealtimeTransport.ts'
import type { MediaTransport } from '../media/MediaTransport.ts'

/** Makes the room's MediaTransport: the room id and a getter for the member's session token */
export type TransportFactory = (roomId: string, token: () => string | null) => MediaTransport

export const realtimeTransport: TransportFactory = (roomId, token) =>
  new CloudflareRealtimeTransport({ apiBase: sfuApiBase(roomId), token })

/** Cloudflare Realtime in the app; tests provide a FakeSfu's transports instead */
export const TransportContext = createContext<TransportFactory>(realtimeTransport)

export const useTransportFactory = (): TransportFactory => useContext(TransportContext)
