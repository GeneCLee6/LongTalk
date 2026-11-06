import { useCallback, useState } from 'react'
import { clampVolume, VOLUME_DEFAULT } from '../media/memberVolume.ts'

// Each person's receive volume in this room (e6-t08): local to this browser, for this tab's
// session (a reload keeps it, because the same tab comes back as the same member; another meeting
// starts everyone at 100%). A person's share has its own entry.

const key = (roomId: string) => `longtalk:volumes:${roomId}`

export const shareVolumeKey = (memberId: string) => `share:${memberId}`

export type MemberVolumeMap = Readonly<Record<string, number>>

export function loadMemberVolumes(roomId: string): MemberVolumeMap {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(key(roomId)) ?? 'null')
    if (typeof saved !== 'object' || saved === null) return {}
    const volumes: Record<string, number> = {}
    for (const [id, value] of Object.entries(saved)) {
      if (typeof value === 'number') volumes[id] = clampVolume(value)
    }
    return volumes
  } catch {
    return {}
  }
}

export function saveMemberVolumes(roomId: string, volumes: MemberVolumeMap): void {
  try {
    sessionStorage.setItem(key(roomId), JSON.stringify(volumes))
  } catch {
    // Full or blocked: simply not remembered
  }
}

export interface MemberVolumes {
  /** Percent, by member id or shareVolumeKey */
  volumeOf: (id: string) => number
  setVolume: (id: string, percent: number) => void
}

export function useMemberVolumes(roomId: string): MemberVolumes {
  const [volumes, setVolumes] = useState(() => loadMemberVolumes(roomId))
  const setVolume = useCallback(
    (id: string, percent: number) =>
      setVolumes((current) => {
        const next = { ...current, [id]: clampVolume(percent) }
        saveMemberVolumes(roomId, next)
        return next
      }),
    [roomId],
  )
  return { volumeOf: (id) => volumes[id] ?? VOLUME_DEFAULT, setVolume }
}
