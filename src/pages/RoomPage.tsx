import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import styled from 'styled-components'
import {
  MAX_NAME_CHARS,
  MAX_ROOM_NAME_CHARS,
  normalizeName,
  waitingQueue,
  type HostMemberAction,
  type NoticeMessage,
  type RoomInfo,
  type Role,
  type WaitingEntry,
} from '../../shared/protocol.ts'
import { normalizePassword } from '../../shared/password.ts'
import { can } from '../../shared/roles.ts'
import {
  focusFirst,
  pickSpeaker,
  stageFocus,
  stageLayout,
  visibleTiles,
  type LayoutChoice,
} from '../../shared/layout.ts'
import { isRoomId } from '../../shared/room-id.ts'
import type { UsageState } from '../../shared/usage.ts'
import { getRoom } from '../api/rooms.ts'
import { fetchIceConfig } from '../api/turn.ts'
import { Button } from '../components/Button.tsx'
import { ChatPanel } from '../components/ChatPanel.tsx'
import { ChatPreview } from '../components/ChatPreview.tsx'
import { ConfirmDialog } from '../components/ConfirmDialog.tsx'
import { LeaveDialog, PasswordDialog } from '../components/HostDialogs.tsx'
import { Drawer } from '../components/Drawer.tsx'
import { LeftScreen } from '../components/LeftScreen.tsx'
import { PhoneLayoutContext, usePhoneLayoutQuery } from '../components/layoutContext.ts'
import { MemberAudio } from '../components/MemberAudio.tsx'
import type { MenuItem } from '../components/Menu.tsx'
import { NameDialog } from '../components/NameDialog.tsx'
import { ParticipantsPanel, type RoleChange } from '../components/ParticipantsPanel.tsx'
import { PreJoin, type PasswordFieldProps } from '../components/PreJoin.tsx'
import { SharingBar } from '../components/SharingBar.tsx'
import { ShareTile } from '../components/ShareTile.tsx'
import { PanelTabs, SidePanel } from '../components/SidePanel.tsx'
import { Stage } from '../components/Stage.tsx'
import { Tile, type TileProps } from '../components/Tile.tsx'
import { ToastViewport } from '../components/Toast.tsx'
import { Toolbar } from '../components/Toolbar.tsx'
import { TopBar } from '../components/TopBar.tsx'
import { TurnedAwayScreen, type TurnedAwayReason } from '../components/TurnedAwayScreen.tsx'
import { WaitingScreen } from '../components/WaitingScreen.tsx'
import { useToasts } from '../components/useToasts.ts'
import {
  canChooseSpeaker,
  canShareScreen,
  canWebShare,
  supportsWebRtc,
} from '../media/capabilities.ts'
import { activeDeviceId, type MediaProblem } from '../media/devices.ts'
import { trackKey, type MediaTransportErrorCode } from '../media/MediaTransport.ts'
import type { RoomConnectionState } from '../room/RoomConnection.ts'
import type { DeviceNotice, LocalDevicesState, LocalKind } from '../room/LocalDevices.ts'
import {
  clearSession,
  loadDevices,
  loadName,
  loadSession,
  loadView,
  saveDevice,
  saveName,
  saveView,
  type DeviceChoices,
  type ViewPrefs,
} from '../room/session.ts'
import { useHeldSpeaker } from '../room/useHeldSpeaker.ts'
import { useLocalDevices } from '../room/useLocalDevices.ts'
import { useLocalPreview } from '../room/useLocalPreview.ts'
import { useMicLevel } from '../room/useMicLevel.ts'
import { useChatNotifications } from '../room/useChatNotifications.ts'
import { useRoomConnection } from '../room/useRoomConnection.ts'
import { useRoomTelemetry } from '../room/useRoomTelemetry.ts'
import type { LocalTracks } from '../room/RoomMedia.ts'
import { useRoomMedia } from '../room/useRoomMedia.ts'
import type { ShareNotice } from '../room/ScreenShare.ts'
import { useScreenShare } from '../room/useScreenShare.ts'
import { copyRoomLink, roomUrl, shareRoomLink, type LinkOutcome } from '../room/shareLink.ts'
import {
  linkPassword,
  linkWithPassword,
  loadKnownPassword,
  saveKnownPassword,
} from '../room/roomPassword.ts'
import { useKnownPassword } from '../room/useKnownPassword.ts'
import { useSpeaking } from '../room/useSpeaking.ts'
import { useTransportFactory } from '../room/transportContext.ts'
import { telemetry } from '../telemetry.ts'
import { strings } from '../strings.ts'
import { color, font, fontSize, layer, radius, media, space } from '../styles/tokens.ts'

/** What the pre-join screen hands to the room: the room publishes with the media choices */
export interface JoinChoices {
  name: string
  mic: boolean
  cam: boolean
  /** The devices chosen (also remembered in localStorage, session.ts) */
  devices: DeviceChoices
  /** The room's password (F3), when it has one and we join as someone new */
  password: string | null
}

/**
 * Why the room did not take our password (F3, e1-t15): none was given, a wrong one, or too many
 * wrong ones (wait until `until`)
 */
export type PasswordProblem =
  { kind: 'required' | 'wrong'; until?: undefined } | { kind: 'wait'; until: number }

/**
 * A tab that joined this room before (it still holds the session token) and knows its name goes
 * straight back in: a reload lands in the room as the same member (AC-1.2).
 */
function resume(roomId: string): JoinChoices | null {
  const name = loadName()
  return loadSession(roomId) && name
    ? { name, mic: true, cam: true, devices: loadDevices(), password: null }
    : null
}

export default function RoomPage() {
  const { roomId = '' } = useParams()
  if (!isRoomId(roomId)) {
    return (
      <Page>
        <NotFound />
      </Page>
    )
  }
  return <RoomEntry key={roomId} roomId={roomId} />
}

/** Where this tab is with the room: deciding to join, in it, or out of it again (e4-t18) */
type Stage =
  | { at: 'prejoin'; problem?: PasswordProblem }
  | { at: 'room'; choices: JoinChoices }
  | { at: 'left'; reason: LeftReason | TurnedAwayReason; roomName: string }

/**
 * `left`: pressed 「離開」; `closed`: the room was gone when we came back to it; `ended`, `removed`:
 * the host ended the meeting or removed us (F1)
 */
export type LeftReason = 'left' | 'closed' | 'ended' | 'endedSelf' | 'removed'

const isLeftReason = (reason: LeftReason | TurnedAwayReason): reason is LeftReason =>
  reason === 'left' ||
  reason === 'closed' ||
  reason === 'ended' ||
  reason === 'endedSelf' ||
  reason === 'removed'

function RoomEntry({ roomId }: { roomId: string }) {
  const navigate = useNavigate()
  const [stage, setStage] = useState<Stage>(() => {
    const resumed = resume(roomId)
    return resumed ? { at: 'room', choices: resumed } : { at: 'prejoin' }
  })
  const [supported] = useState(supportsWebRtc)
  if (!supported) {
    return (
      <Page>
        <Unsupported />
      </Page>
    )
  }
  if (stage.at === 'room') {
    // The room is dark whatever the system scheme (DESIGN.md §1.2)
    return (
      <Shell data-theme="dark">
        <Room
          roomId={roomId}
          choices={stage.choices}
          onLeft={(reason, roomName) => setStage({ at: 'left', reason, roomName })}
          onPasswordRefused={(problem) => setStage({ at: 'prejoin', problem })}
        />
      </Shell>
    )
  }
  if (stage.at === 'left' && !isLeftReason(stage.reason)) {
    // Not let in (F2): locked, turned away, waited too long, or left the waiting room
    return (
      <Page>
        <TurnedAwayScreen
          reason={stage.reason}
          roomName={stage.roomName}
          onRetry={() => setStage({ at: 'prejoin' })}
          onHome={() => navigate('/')}
        />
      </Page>
    )
  }
  if (stage.at === 'left' && isLeftReason(stage.reason)) {
    return (
      <Page>
        <LeftScreen
          reason={stage.reason}
          roomName={stage.roomName}
          onRate={(score) => {
            // Sent at once: the next thing the person does may well be closing the tab
            telemetry.track({ type: 'rating', score })
            telemetry.flush()
          }}
          // Back through the pre-join screen, with the remembered name and devices; the session
          // was forgotten on leaving, so this is a new member
          onRejoin={() => setStage({ at: 'prejoin' })}
          onHome={() => navigate('/')}
        />
      </Page>
    )
  }
  return (
    <Page>
      <PreJoinGate
        roomId={roomId}
        problem={stage.at === 'prejoin' ? (stage.problem ?? null) : null}
        onHome={() => navigate('/')}
        onJoin={(choices) => {
          saveName(choices.name)
          setStage({ at: 'room', choices })
        }}
      />
    </Page>
  )
}

type Summary =
  | {
      status: 'loading' | 'missing' | 'error' | 'locked'
      memberCount: null
      waitingRoom: false
      password: false
    }
  | { status: 'ok'; memberCount: number; waitingRoom: boolean; password: boolean }

const NONE = { memberCount: null, waitingRoom: false, password: false } as const
const LOADING: Summary = { status: 'loading', ...NONE }

/**
 * Checks the room exists before the pre-join screen asks for the camera; a locked room (F2) says
 * so at once, with 再試一次 (the host may unlock it meanwhile)
 */
function PreJoinGate({
  roomId,
  problem,
  onJoin,
  onHome,
}: {
  roomId: string
  /** The room did not take our password last time (F3) */
  problem: PasswordProblem | null
  onJoin: (choices: JoinChoices) => void
  onHome: () => void
}) {
  const [summary, setSummary] = useState<Summary>(LOADING)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    getRoom(roomId).then(
      (room) => {
        if (cancelled) return
        setSummary(
          !room
            ? { status: 'missing', ...NONE }
            : room.locked
              ? { status: 'locked', ...NONE }
              : {
                  status: 'ok',
                  memberCount: room.memberCount,
                  waitingRoom: !!room.waitingRoom,
                  // A room from before v11 has no password time: none
                  password: room.passwordSetAt != null,
                },
        )
      },
      () => {
        if (!cancelled) setSummary({ status: 'error', ...NONE })
      },
    )
    return () => {
      cancelled = true
    }
  }, [roomId, attempt])
  switch (summary.status) {
    case 'loading':
      return <p role="status">{strings.room.connecting}</p>
    case 'missing':
      return <NotFound />
    case 'locked':
      return (
        <TurnedAwayScreen
          reason="locked"
          roomName={strings.room.title(roomId)}
          onRetry={() => {
            setSummary(LOADING)
            setAttempt((n) => n + 1)
          }}
          onHome={onHome}
        />
      )
    default:
      return <PreJoinScreen roomId={roomId} summary={summary} problem={problem} onJoin={onJoin} />
  }
}

function PreJoinScreen({
  roomId,
  summary,
  problem,
  onJoin,
}: {
  roomId: string
  summary: Summary
  problem: PasswordProblem | null
  onJoin: (choices: JoinChoices) => void
}) {
  const [name, setName] = useState(loadName)
  const [mic, setMic] = useState(true)
  const [cam, setCam] = useState(true)
  const [devices, setDevices] = useState<DeviceChoices>(loadDevices)
  const preview = useLocalPreview({ mic, cam, micId: devices.mic, camId: devices.cam })
  const level = useMicLevel(preview.stream)
  const [speakerSupported] = useState(canChooseSpeaker)
  const passwordField = usePasswordField(roomId, summary.password, problem)

  return (
    <PreJoin
      roomId={roomId}
      memberCount={summary.memberCount}
      roomNotice={
        summary.status === 'error'
          ? strings.prejoin.loadFailed
          : summary.waitingRoom
            ? strings.prejoin.waitingRoom
            : null
      }
      name={name}
      onNameChange={setName}
      mic={mic}
      cam={cam}
      onToggleMic={() => setMic((on) => !on)}
      onToggleCam={() => setCam((on) => !on)}
      stream={preview.stream}
      opening={preview.opening}
      level={level}
      devices={preview.devices}
      selected={{
        mic: devices.mic ?? activeDeviceId(preview.stream, 'audio'),
        cam: devices.cam ?? activeDeviceId(preview.stream, 'video'),
        speaker: devices.speaker,
      }}
      onSelect={(choice, deviceId) => {
        saveDevice(choice, deviceId)
        setDevices((current) => ({ ...current, [choice]: deviceId }))
      }}
      speakerSupported={speakerSupported}
      micProblem={preview.micProblem}
      camProblem={preview.camProblem}
      onRetry={preview.retry}
      password={passwordField}
      onJoin={() => {
        const normalized = normalizeName(name)
        const password = passwordField ? normalizePassword(passwordField.value) : null
        if (!normalized || (passwordField && password === null)) return
        // Kept in this tab (sessionStorage) for 「複製含密碼的連結」; the room confirms it
        if (password !== null) saveKnownPassword(roomId, { password, setAt: null })
        onJoin({ name: normalized, mic, cam, devices, password })
      }}
    />
  )
}

/**
 * The pre-join screen's password field (F3, e1-t15): shown when the room has a password or did
 * not take ours; filled from the link's ?pwd= or what this tab knew; after too many wrong tries
 * it counts down and joining waits.
 */
function usePasswordField(
  roomId: string,
  roomHasPassword: boolean,
  problem: PasswordProblem | null,
): PasswordFieldProps | null {
  const [fromLink] = useState(() => linkPassword(roomId))
  const [value, setValue] = useState(() => fromLink ?? loadKnownPassword(roomId)?.password ?? '')
  const [edited, setEdited] = useState(false)
  const [now, setNow] = useState(Date.now)
  const waitUntil = problem?.kind === 'wait' ? problem.until : null
  useEffect(() => {
    if (waitUntil === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [waitUntil])
  if (!roomHasPassword && problem === null) return null
  const waitSeconds = waitUntil === null ? 0 : Math.max(0, Math.ceil((waitUntil - now) / 1000))
  const invalid = edited && value.trim() !== '' && normalizePassword(value) === null
  const error = invalid
    ? strings.prejoin.passwordInvalid
    : waitSeconds > 0
      ? strings.prejoin.passwordWait(waitSeconds)
      : !edited && problem?.kind === 'wrong'
        ? strings.prejoin.passwordWrong
        : null
  return {
    value,
    onChange: (next) => {
      setValue(next)
      setEdited(true)
    },
    hint:
      fromLink !== null && value === fromLink
        ? strings.prejoin.passwordFromLink
        : strings.prejoin.passwordNeeded,
    error,
    waiting: waitSeconds > 0,
  }
}

function Room({
  roomId,
  choices,
  onLeft,
  onPasswordRefused,
}: {
  roomId: string
  choices: JoinChoices
  onLeft: (reason: LeftReason | TurnedAwayReason, roomName: string) => void
  /** The room did not take our password (F3): back to the pre-join screen, which says why */
  onPasswordRefused: (problem: PasswordProblem) => void
}) {
  const {
    state,
    leave,
    send,
    retry: retryRoom,
    rename,
    onError,
    onNotice: onHostControl,
    sendChat,
  } = useRoomConnection(roomId, choices.name, choices.password)
  const toasts = useToasts()
  const { show } = toasts
  const roomInfo = state.view?.room ?? null
  // In the waiting room (F2): no view, only the lobby (kept while the socket reconnects)
  const lobby = state.lobby
  const waiting = lobby !== null
  const title = roomTitle(roomId, roomInfo ?? lobby?.room ?? null)
  const gone = state.status === 'notFound'
  // The host removed us or ended the meeting (F1), or did not let us in (F2): the after-leave
  // screen, or the turned-away one, says which
  const outcome =
    state.status === 'removed' ||
    state.status === 'ended' ||
    state.status === 'locked' ||
    state.status === 'denied' ||
    state.status === 'waitExpired'
      ? state.status
      : null
  // Whether the room ever welcomed this tab: a room that is gone after that closed while we were
  // away (asleep, offline past the grace period) and gets the after-leave screen; one that was
  // never there (a stale tab resuming) is just not found
  const welcomed = useRef(false)
  useEffect(() => {
    if (state.you) welcomed.current = true
  }, [state.you])
  const onGone = useEffectEvent(() => {
    clearSession(roomId)
    if (welcomed.current) onLeft('closed', title)
  })
  useEffect(() => {
    if (gone) onGone()
  }, [gone])
  // We ended the meeting ourselves (F3): the after-leave screen says so
  const endingSelf = useRef(false)
  const onOutcome = useEffectEvent((reason: NonNullable<typeof outcome>) => {
    clearSession(roomId)
    onLeft(reason === 'ended' && endingSelf.current ? 'endedSelf' : reason, title)
  })
  useEffect(() => {
    if (outcome) onOutcome(outcome)
  }, [outcome])
  // The room did not take our password (F3): the pre-join screen asks again
  const onPasswordProblem = useEffectEvent(() => {
    clearSession(roomId)
    onPasswordRefused(
      state.status === 'passwordWait'
        ? { kind: 'wait', until: state.passwordWaitUntil ?? Date.now() }
        : { kind: state.status === 'passwordWrong' ? 'wrong' : 'required' },
    )
  })
  const passwordRefused =
    state.status === 'passwordRequired' ||
    state.status === 'passwordWrong' ||
    state.status === 'passwordWait'
  useEffect(() => {
    if (passwordRefused) onPasswordProblem()
  }, [passwordRefused])
  const self = state.you ? state.view?.members[state.you] : undefined
  const role: Role = self?.role ?? 'participant'
  // A handover's notice says who gave us the role (F3): the generic 「你現在是主持人」 stays quiet
  const announceHost = useHostNotice(self?.role, show)
  useEffect(() => {
    document.title = `${title} · ${strings.appName}`
    return () => {
      document.title = strings.appName
    }
  }, [title])
  const [renaming, setRenaming] = useState<'room' | 'self' | null>(null)
  const phone = usePhoneLayoutQuery()
  // The chat (D3) and the participants (F1): one side panel on desktop, a full-screen drawer on
  // phones, switching between the two
  const [panel, setPanel] = useState<'chat' | 'participants' | null>(null)
  const chatOpen = panel === 'chat'
  const togglePanel = (which: 'chat' | 'participants') =>
    setPanel((open) => (open === which ? null : which))
  const chat = useChatNotifications({
    messages: state.chat,
    loaded: state.chatLoaded,
    you: state.you,
    open: chatOpen,
  })
  // The room refused a message as too fast (the browser checks first, so this is rare)
  useEffect(
    () =>
      onError((code) => {
        if (code === 'rate_limited') show(strings.chat.rateLimited, 'warn')
        // A host control the room refused (our role changed meanwhile, F1)
        if (code === 'forbidden') show(strings.participants.forbidden, 'warn')
      }),
    [onError, show],
  )
  // Whoever spoke last, for the speaker layout (phones held sideways, the desktop's 演講者)
  const [lastHeard, setLastHeard] = useState<string | null>(null)
  // What the stage shows (G2, e4-t10, e4-t11): the layout and 隱藏自己 are remembered
  // (session.ts); the pin and 隱藏沒有視訊的人 are for this meeting. The spotlight is the room's
  // (RoomDO decides who may set it, worker/roles.ts).
  const [view, setView] = useState<ViewPrefs>(loadView)
  const updateView = (changes: Partial<ViewPrefs>) => {
    const next = { ...view, ...changes }
    saveView(next)
    setView(next)
  }
  const [hideNoVideo, setHideNoVideo] = useState(false)
  const [pinned, setPinned] = useState<string | null>(null)
  const pinnedId = pinned !== null && state.view?.members[pinned] ? pinned : null
  const spotlight = roomInfo?.spotlight ?? null
  const maySpotlight = can(role, 'spotlight')
  const setSpotlight = (memberId: string | null) => send({ t: 'spotlight', memberId })
  useSpotlightNotice(spotlight, state.you, show)
  const togglePin = (memberId: string) => {
    if (pinnedId === memberId) {
      setPinned(null)
      return
    }
    setPinned(memberId)
    show(strings.view.pinnedToast(state.view?.members[memberId]?.name ?? ''))
  }
  const viewSection = strings.view.section
  const layouts: readonly LayoutChoice[] = ['grid', 'speaker']
  const viewItems: MenuItem[] = [
    // Phones follow how they are held (C3); a pin or a spotlight still makes someone big
    ...(phone === null
      ? layouts.map((layout) => ({
          id: `layout-${layout}`,
          label: strings.view[layout],
          section: viewSection,
          checked: view.layout === layout,
          onSelect: () => updateView({ layout }),
        }))
      : []),
    {
      id: 'hide-self',
      label: strings.view.hideSelf,
      section: viewSection,
      kind: 'checkbox',
      checked: view.hideSelf,
      onSelect: () => updateView({ hideSelf: !view.hideSelf }),
    },
    {
      id: 'hide-no-video',
      label: strings.view.hideNoVideo,
      section: viewSection,
      kind: 'checkbox',
      checked: hideNoVideo,
      onSelect: () => setHideNoVideo((on) => !on),
    },
    ...(pinnedId !== null
      ? [
          {
            id: 'unpin',
            label: strings.view.unpinMenu,
            section: viewSection,
            onSelect: () => setPinned(null),
          },
        ]
      : []),
    ...(spotlight !== null && maySpotlight
      ? [
          {
            id: 'unspotlight',
            label: strings.view.unspotlightMenu,
            section: viewSection,
            onSelect: () => setSpotlight(null),
          },
        ]
      : []),
  ]
  const [webShare] = useState(canWebShare)
  const [screenShareSupported] = useState(canShareScreen)
  const link = roomUrl(roomId)
  // The room's password (F3, e1-t15): what this tab knows of it, for the link with it
  const passwordSetAt = roomInfo?.passwordSetAt
  const knownPassword = useKnownPassword(roomId, state.view ? (passwordSetAt ?? null) : undefined)
  const roomHasPassword = passwordSetAt != null
  const onLinkOutcome = (outcome: LinkOutcome, url: string = link, copied?: string) => {
    if (outcome === 'copied') {
      show(copied ?? (roomHasPassword ? strings.password.copiedWithout : strings.topBar.copied))
    } else if (outcome === 'failed') show(strings.topBar.copyFailed(url), 'warn')
  }
  const passwordLink =
    knownPassword.current === null ? null : linkWithPassword(link, knownPassword.current)
  const moreItems: MenuItem[] = [
    ...(passwordLink
      ? [
          {
            id: 'copy-with-password',
            label: strings.password.copyWith,
            onSelect: () =>
              void copyRoomLink(passwordLink, title, strings.share.text).then((outcome) =>
                onLinkOutcome(outcome, passwordLink, strings.password.copiedWith),
              ),
          },
        ]
      : []),
    ...(webShare
      ? [
          {
            id: 'share',
            label: strings.share.action,
            onSelect: () => void shareRoomLink(link, title, strings.share.text).then(onLinkOutcome),
          },
        ]
      : []),
    { id: 'rename-self', label: strings.rename.self, onSelect: () => setRenaming('self') },
    // Who may rename the room: shared/roles.ts (RoomDO checks it too)
    ...(can(role, 'renameRoom')
      ? [{ id: 'rename-room', label: strings.rename.room, onSelect: () => setRenaming('room') }]
      : []),
    ...viewItems,
  ]
  const onNotice = useCallback((notice: DeviceNotice) => show(noticeText(notice), 'warn'), [show])
  // The microphone and camera chosen on the pre-join screen, opened again for the room; the
  // toolbar turns them on and off and switches them after that (e2-t05, e2-t06)
  const { state: local, devices } = useLocalDevices(
    { mic: choices.mic, cam: choices.cam },
    choices.devices,
    onNotice,
  )
  const micSending = local.mic.on ? local.mic.track : null
  const camSending = local.cam.on ? local.cam.track : null
  const sending = useMemo<LocalTracks | null>(
    () => (local.ready ? { mic: micSending, cam: camSending } : null),
    [local.ready, micSending, camSending],
  )
  const [speakerSupported] = useState(canChooseSpeaker)

  // The SFU proxy asks for the session token on every call; the transport reads the latest
  const token = useRef(state.token)
  useEffect(() => {
    token.current = state.token
  }, [state.token])
  const makeTransport = useTransportFactory()
  const createTransport = useCallback(
    () => makeTransport(roomId, () => token.current),
    [makeTransport, roomId],
  )
  // `?ice=relay` forces the media through TURN: a debugging aid for checking TURN (e2-t07)
  const [relayOnly] = useState(() => new URLSearchParams(location.search).get('ice') === 'relay')
  const iceConfig = useCallback(
    () => fetchIceConfig(roomId, token.current, relayOnly),
    [roomId, relayOnly],
  )
  // Screen sharing (D1): RoomDO says who shares; the screen is published once it names us
  const roomShare = state.view?.room.share ?? null
  const viewMembers = state.view?.members
  const memberName = useRef<(id: string) => string>(() => '')
  useEffect(() => {
    memberName.current = (id) => viewMembers?.[id]?.name ?? ''
  }, [viewMembers])
  const onShareNotice = useCallback(
    (notice: ShareNotice) => {
      switch (notice.type) {
        case 'problem':
          show(strings.screenShare.problems[notice.problem], 'warn')
          return
        case 'takenOver':
          show(strings.screenShare.takenOver(memberName.current(notice.by)))
          return
        case 'stopped':
          // The host stopped it (F1): the room's notice says so, by name (onHostNotice)
          return
        case 'audioOnly':
          show(strings.screenShare.audioOnly, 'warn')
          return
      }
    },
    [show],
  )
  const screenShare = useScreenShare({
    share: roomShare,
    you: state.you,
    send,
    onError,
    welcomes: state.welcomes,
    notify: onShareNotice,
  })
  const sharePhase = screenShare.phase
  const sharingScreen = sharePhase === 'sharing' ? screenShare.track : null
  // The share's sound (e3-t04): sent with the screen while the bar's switch is on
  const sharingAudio = sharePhase === 'sharing' && screenShare.audioOn ? screenShare.audio : null
  useShareStartedNotice(roomShare?.memberId ?? null, state.you, memberName, show)
  // The name of whoever shares, for the take-over question (kept if they stop meanwhile)
  const [sharerName, setSharerName] = useState('')
  const currentSharerName =
    roomShare && roomShare.memberId !== state.you
      ? (viewMembers?.[roomShare.memberId]?.name ?? null)
      : null
  // Adjusted while rendering (React's pattern for state that follows a value), not in an effect
  if (currentSharerName !== null && currentSharerName !== sharerName) {
    setSharerName(currentSharerName)
  }

  // The room view stays on screen while the socket reconnects; so does the media connection. Not
  // in the waiting room: the SFU proxy would refuse us (F2)
  const inRoom = (state.status === 'open' || state.status === 'reconnecting') && !waiting
  const media = useRoomMedia({
    enabled: inRoom && state.token !== null,
    createTransport,
    iceConfig,
    local: sending,
    screen: sharingScreen,
    screenAudio: sharingAudio,
    send,
    you: state.you,
    view: state.view,
    welcomes: state.welcomes,
  })
  const usage = state.view?.usage ?? 'normal'
  useUsageNotices(usage, media.videoRefused, show)
  // What a host did to us (F1, AC-1.4): the room already lists the track muted; our browser
  // turns the device off itself and says who did it. Only we can turn it back on.
  const onHostNotice = useEffectEvent((notice: NoticeMessage) => {
    const actor = viewMembers?.[notice.by]
    const who = strings.hostNotice.actor(
      actor?.role === 'cohost' ? strings.participants.cohost : strings.participants.host,
      actor?.name ?? '',
    )
    switch (notice.notice) {
      case 'muted':
        void devices?.setOn('mic', false)
        show(notice.all ? strings.hostNotice.mutedAll(who) : strings.hostNotice.muted(who), 'warn')
        return
      case 'camOff':
        void devices?.setOn('cam', false)
        show(strings.hostNotice.camOff(who), 'warn')
        return
      case 'shareStopped':
        show(strings.hostNotice.shareStopped(who), 'warn')
        return
      // F3 (e1-t16)
      case 'madeCohost':
        show(strings.hostNotice.madeCohost(who))
        return
      case 'cohostRevoked':
        show(strings.hostNotice.cohostRevoked(who))
        return
      case 'madeHost':
        announceHost()
        show(strings.hostNotice.madeHost(who))
        return
    }
  })
  useEffect(() => onHostControl((notice) => onHostNotice(notice)), [onHostControl])
  // Host controls from the participants panel (e1-t07); RoomDO decides (worker/roles.ts)
  const onMemberAction = (action: HostMemberAction, memberId: string) => {
    send({ t: 'host', action, memberId })
    if (action === 'remove') {
      show(strings.participants.removed(viewMembers?.[memberId]?.name ?? ''))
    }
  }
  const onMuteAll = () => {
    send({ t: 'host', action: 'muteAll' })
    show(strings.participants.mutedAll)
  }
  const onEndMeeting = () => {
    endingSelf.current = true
    send({ t: 'host', action: 'endMeeting' })
  }
  // Co-hosts and handing over (F3, e1-t16): RoomDO decides (worker/roles.ts)
  const onRole = (change: RoleChange, memberId: string) => {
    const name = viewMembers?.[memberId]?.name ?? ''
    if (change === 'makeHost') {
      send({ t: 'host', action: 'makeHost', memberId })
      show(strings.participants.madeHost(name))
      return
    }
    const on = change === 'makeCohost'
    send({ t: 'host', action: 'setCohost', memberId, on })
    show(on ? strings.participants.madeCohost(name) : strings.participants.revokedCohost(name))
  }
  // The room's password (F3, e1-t15): only the host; RoomDO keeps a digest
  const [passwordDialog, setPasswordDialog] = useState(false)
  const onSavePassword = (password: string | null) => {
    send({ t: 'host', action: 'setPassword', password })
    knownPassword.remember(password)
    setPasswordDialog(false)
    show(
      password === null
        ? strings.participants.passwordClearedNow
        : strings.participants.passwordSetNow,
    )
  }
  // A host pressing 離開 (F3, e1-t17): only me (and who takes over), or end for everyone
  const [leaving, setLeaving] = useState(false)
  // The lock and the waiting room (F2): RoomDO decides (worker/roles.ts)
  const waitingList = waitingQueue(state.view?.waiting)
  const canAdmit = can(role, 'admit')
  useWaitingNotice(canAdmit ? waitingList : null, show)
  const onLock = (on: boolean) => {
    send({ t: 'host', action: 'lock', on })
    show(on ? strings.participants.lockedNow : strings.participants.unlockedNow)
  }
  const onWaitingRoom = (on: boolean) => {
    send({ t: 'host', action: 'waitingRoom', on })
    show(on ? strings.participants.waitingOnNow : strings.participants.waitingOffNow)
  }
  const onAdmit = (memberId: string) => send({ t: 'host', action: 'admit', memberId })
  const onDeny = (memberId: string) => {
    send({ t: 'host', action: 'deny', memberId })
    show(strings.participants.denied(state.view?.waiting?.[memberId]?.name ?? ''))
  }
  const onAdmitAll = () => send({ t: 'host', action: 'admitAll' })
  useRoomTelemetry({
    status: state.status,
    mediaStatus: media.status,
    usingRelay: media.usingRelay,
    rebuilds: media.rebuilds,
  })
  // The month turned audio-only while we share: the screen is not sent, so stop sharing
  const { stop: stopShare } = screenShare
  useEffect(() => {
    if (!media.screenRefused) return
    show(strings.screenShare.audioOnly, 'warn')
    stopShare()
  }, [media.screenRefused, show, stopShare])
  const onToggleShare = () => {
    if (sharePhase === 'sharing' || sharePhase === 'claiming') {
      screenShare.stop()
      return
    }
    // Once the month is audio-only the room refuses a share (e11-t13): say so without asking
    if (usage === 'audioOnly') {
      show(strings.screenShare.audioOnly, 'warn')
      return
    }
    screenShare.request()
  }

  const toggleCam = () => {
    // Once the month is audio-only a camera that is off stays off (e11-t13): say so without
    // opening it
    if (!local.cam.on && usage === 'audioOnly') {
      show(strings.usage.videoRefused, 'warn')
      return
    }
    void devices?.setOn('cam', !local.cam.on)
  }

  const members = Object.values(state.view?.members ?? {})
  // Each member's camera as their tile shows it: ours while it sends, theirs while it is on
  const videoOf = (member: (typeof members)[number]): MediaStreamTrack | null => {
    if (member.id === state.you) return media.videoRefused ? null : camSending
    const cam = member.tracks.find((t) => t.kind === 'cam')
    return (cam && !cam.muted && media.received[trackKey(cam)]?.track) || null
  }
  const shown = visibleTiles({
    tiles: members.map((member) => ({ id: member.id, video: videoOf(member) !== null })),
    you: state.you,
    hideSelf: view.hideSelf,
    hideNoVideo,
    keep: [pinnedId, spotlight],
  })
  const speaker = useHeldSpeaker(pickSpeaker(shown.ids, state.you, lastHeard), shown.ids)
  const focus = stageFocus(shown.ids, pinnedId, spotlight, speaker)

  if (gone || outcome) {
    return (
      <Centered>
        <NotFound />
      </Centered>
    )
  }
  if (waiting) {
    // The waiting room (F2, e1-t11): admitted, the room takes its place with the same devices
    return (
      <Centered>
        <WaitingScreen
          roomName={title}
          lobby={lobby}
          connection={
            state.status === 'lost' ? 'lost' : state.status === 'waiting' ? 'ok' : 'reconnecting'
          }
          camera={camSending}
          micOn={local.mic.on}
          camOn={local.cam.on}
          micBusy={!local.ready || local.mic.opening}
          camBusy={!local.ready || local.cam.opening}
          onToggleMic={() => void devices?.setOn('mic', !local.mic.on)}
          onToggleCam={toggleCam}
          onLeave={() => {
            leave()
            onLeft('leftWaiting', title)
          }}
          onRetry={retryRoom}
        />
        <ToastViewport toasts={toasts.toasts} onDismiss={toasts.dismiss} />
      </Centered>
    )
  }
  // Gave up rebuilding the media session (e2-t08): say so, with a retry
  const mediaLost =
    media.status === 'failed' &&
    media.error !== 'sfu_not_configured' &&
    media.error !== 'unauthorized'
  const mediaProblem = mediaLost ? null : mediaErrorText(media.error)
  const selfReconnecting = state.status === 'reconnecting' || media.status === 'reconnecting'
  // Who could take over from us: connected members in the meeting, the room's own pick first
  const successors = members
    .filter((member) => member.id !== state.you && !member.reconnecting)
    .sort((a, b) => successorOrder(a) - successorOrder(b) || a.joinedAt - b.joinedAt)
  const onLeave = () => {
    if (role === 'host' && successors.length > 0) {
      setLeaving(true)
      return
    }
    leave()
    onLeft('left', title)
  }
  const leaveAs = (host?: string) => {
    setLeaving(false)
    leave(host)
    onLeft('left', title)
  }
  const remoteAudio = (member: (typeof members)[number]) => {
    const mic = member.tracks.find((t) => t.kind === 'mic')
    return (mic && media.received[trackKey(mic)]?.track) || null
  }
  // Someone else shares: their screen takes the main area (e3-t05, e4-t08). Our own share is not
  // shown back to us (it would mirror endlessly; the presenter view is e3-t08): the bar says it.
  const sharer = roomShare ? state.view?.members[roomShare.memberId] : undefined
  const sharerScreen = sharer?.tracks.find((t) => t.kind === 'screen')
  // Its sound (e3-t04) plays apart from the share tile, like everyone's microphone
  const sharerAudioTrack =
    sharer && sharer.id !== state.you ? sharer.tracks.find((t) => t.kind === 'screenAudio') : null
  const sharerAudio =
    (sharerAudioTrack && media.received[trackKey(sharerAudioTrack)]?.track) || null
  const panelTabs = (
    <PanelTabs
      label={strings.participants.tabs}
      tabs={[
        { id: 'chat', label: strings.toolbar.chatUnread(chat.unread) },
        { id: 'participants', label: strings.participants.tabParticipants(members.length) },
      ]}
      selected={panel ?? 'chat'}
      onSelect={(id) => setPanel(id === 'participants' ? 'participants' : 'chat')}
    />
  )
  const participantsPanel = (
    <ParticipantsPanel
      members={members}
      you={state.you}
      sharerId={roomShare?.memberId ?? null}
      onAction={onMemberAction}
      onMuteAll={onMuteAll}
      onEndMeeting={onEndMeeting}
      waiting={waitingList}
      locked={roomInfo?.locked ?? false}
      waitingRoom={roomInfo?.waitingRoom ?? false}
      onLock={onLock}
      onWaitingRoom={onWaitingRoom}
      onAdmit={onAdmit}
      onDeny={onDeny}
      onAdmitAll={onAdmitAll}
      passwordSet={roomHasPassword}
      onPassword={() => setPasswordDialog(true)}
      onRole={onRole}
    />
  )
  const shareTile =
    sharer && sharer.id !== state.you ? (
      <ShareTile
        name={sharer.name}
        video={(sharerScreen && media.received[trackKey(sharerScreen)]?.track) || null}
      />
    ) : undefined
  // The tiles in the stage's order; in the share's strip the pinned or spotlighted one first
  // (the share keeps the main area: choosing between shares and people is H5's)
  const byId = new Map(members.map((member) => [member.id, member]))
  const stageMembers = (shareTile ? focusFirst(shown.ids, focus) : shown.ids).flatMap(
    (id) => byId.get(id) ?? [],
  )
  return (
    <PhoneLayoutContext.Provider value={phone}>
      <TopBar
        title={title}
        startedAt={roomInfo?.startedAt ?? null}
        status={statusText(state)}
        warn={state.status !== 'open'}
        locked={roomInfo?.locked ?? false}
        onCopyLink={() => void copyRoomLink(link, title, strings.share.text).then(onLinkOutcome)}
        onLeave={onLeave}
      />
      <Middle>
        <StageArea>
          {sharePhase === 'sharing' && (
            <SharingBar
              onStop={screenShare.stop}
              audio={
                screenShare.audio
                  ? { on: screenShare.audioOn, onToggle: screenShare.toggleAudio }
                  : null
              }
            />
          )}
          <StageBox>
            {inRoom && (
              <Stage
                share={shareTile}
                mode={stageLayout(view.layout, phone, focus)}
                // A desktop's strip is a row under the speaker (PRD e4); phones keep C3's
                stripSide={phone === null ? 'bottom' : 'auto'}
                speaker={Math.max(
                  0,
                  stageMembers.findIndex((member) => member.id === focus?.id),
                )}
              >
                {stageMembers.map((member) => {
                  const you = member.id === state.you
                  const mic = member.tracks.find((t) => t.kind === 'mic')
                  const audio = you ? null : remoteAudio(member)
                  return (
                    <MemberTile
                      key={member.id}
                      name={member.name}
                      you={you}
                      reconnecting={you ? selfReconnecting : member.reconnecting}
                      relayed={you && media.usingRelay}
                      video={videoOf(member)}
                      pinned={member.id === pinnedId}
                      spotlighted={member.id === spotlight}
                      // Pinning is for others (we know what we look like). The room decides who
                      // may spotlight (worker/roles.ts); the button only shows for them.
                      onTogglePin={you ? undefined : () => togglePin(member.id)}
                      onToggleSpotlight={
                        maySpotlight
                          ? () => setSpotlight(spotlight === member.id ? null : member.id)
                          : undefined
                      }
                      // The speaking outline follows our own microphone while it sends, theirs
                      // while it is on
                      level={you ? micSending : mic && !mic.muted ? audio : null}
                      micMuted={you ? micSending === null : (mic?.muted ?? true)}
                      onHeard={you ? undefined : () => setLastHeard(member.id)}
                    />
                  )
                })}
              </Stage>
            )}
            <Notices>
              {state.status === 'lost' && (
                <Button variant="secondary" onClick={retryRoom}>
                  {strings.common.retry}
                </Button>
              )}
              {inRoom && media.status === 'connecting' && (
                <Note>{strings.room.mediaConnecting}</Note>
              )}
              {inRoom && state.status === 'open' && media.status === 'reconnecting' && (
                <Note role="status">{strings.room.mediaReconnecting}</Note>
              )}
              {mediaLost && (
                <Alert role="alert">
                  <span>{strings.room.mediaLost}</span>
                  <Button variant="secondary" onClick={media.retry}>
                    {strings.common.retry}
                  </Button>
                </Alert>
              )}
              {mediaProblem && <Alert role="alert">{mediaProblem}</Alert>}
              {inRoom && shown.hiddenNoVideo > 0 && (
                <Note role="status">
                  {strings.view.hiddenNoVideo(shown.hiddenNoVideo)}
                  <InlineButton type="button" onClick={() => setHideNoVideo(false)}>
                    {strings.view.showAll}
                  </InlineButton>
                </Note>
              )}
              <DeviceProblems local={local} onRetry={(kind) => void devices?.retry(kind)} />
            </Notices>
          </StageBox>
        </StageArea>
        {panel !== null && phone === null && (
          <SidePanel
            title={panel === 'chat' ? strings.chat.title : strings.participants.title}
            closeLabel={panel === 'chat' ? strings.chat.close : strings.participants.close}
            onClose={() => setPanel(null)}
          >
            {panelTabs}
            {panel === 'chat' ? (
              <ChatPanel messages={state.chat} you={state.you} onSend={sendChat} autoFocus />
            ) : (
              participantsPanel
            )}
          </SidePanel>
        )}
      </Middle>
      <ToolbarArea>
        <Toolbar
          memberCount={members.length}
          waitingCount={canAdmit ? waitingList.length : 0}
          canShareScreen={screenShareSupported}
          sharing={sharePhase === 'sharing' || sharePhase === 'claiming'}
          onToggleShare={onToggleShare}
          chatOpen={chatOpen}
          chatUnread={chat.unread}
          onToggleChat={() => togglePanel('chat')}
          participantsOpen={panel === 'participants'}
          onToggleParticipants={() => togglePanel('participants')}
          moreItems={moreItems}
          onLeave={onLeave}
          micOn={local.mic.on}
          camOn={local.cam.on}
          micBusy={!local.ready || local.mic.opening}
          camBusy={!local.ready || local.cam.opening}
          onToggleMic={() => void devices?.setOn('mic', !local.mic.on)}
          onToggleCam={toggleCam}
          devices={local.devices}
          selected={{
            mic: trackDevice(local.mic.track) ?? local.chosen.mic,
            cam: trackDevice(local.cam.track) ?? local.chosen.cam,
            speaker: local.chosen.speaker,
          }}
          onSelect={(choice, deviceId) => void devices?.select(choice, deviceId)}
          speakerSupported={speakerSupported}
        />
      </ToolbarArea>
      {panel !== null && phone !== null && (
        <Drawer
          variant="full"
          title={panel === 'chat' ? strings.chat.title : strings.participants.title}
          onClose={() => setPanel(null)}
        >
          {panelTabs}
          {panel === 'chat' ? (
            <ChatPanel messages={state.chat} you={state.you} onSend={sendChat} />
          ) : (
            participantsPanel
          )}
        </Drawer>
      )}
      {!chatOpen && (
        <ChatPreview
          message={chat.preview}
          onOpen={() => setPanel('chat')}
          onDismiss={chat.dismissPreview}
        />
      )}
      {sharePhase === 'confirm' && (
        <ConfirmDialog
          title={strings.screenShare.takeOverTitle}
          body={strings.screenShare.takeOverBody(sharerName)}
          confirmLabel={strings.screenShare.takeOver}
          onConfirm={screenShare.confirm}
          onCancel={screenShare.cancel}
        />
      )}
      {passwordDialog && (
        <PasswordDialog
          hasPassword={roomHasPassword}
          current={knownPassword.current}
          onSave={onSavePassword}
          onClear={() => onSavePassword(null)}
          onCancel={() => setPasswordDialog(false)}
        />
      )}
      {leaving && successors.length > 0 && (
        <LeaveDialog
          candidates={successors}
          automatic={successors[0].id}
          onLeave={(host) => leaveAs(host === successors[0].id ? undefined : host)}
          onEnd={() => {
            setLeaving(false)
            onEndMeeting()
          }}
          onCancel={() => setLeaving(false)}
        />
      )}
      {renaming === 'room' && (
        <NameDialog
          title={strings.rename.room}
          label={strings.rename.roomLabel}
          initial={title}
          maxChars={MAX_ROOM_NAME_CHARS}
          onSave={(name) => {
            send({ t: 'renameRoom', name })
            setRenaming(null)
          }}
          onCancel={() => setRenaming(null)}
        />
      )}
      {renaming === 'self' && (
        <NameDialog
          title={strings.rename.self}
          label={strings.rename.selfLabel}
          initial={self?.name ?? choices.name}
          maxChars={MAX_NAME_CHARS}
          onSave={(name) => {
            rename(name)
            // Remembered for the next room too, like the pre-join screen's name
            saveName(name)
            setRenaming(null)
          }}
          onCancel={() => setRenaming(null)}
        />
      )}
      {/* Everyone's sound, apart from the tiles: layouts move tiles, never the sound (e4-t07) */}
      <div hidden>
        {members.map((member) =>
          member.id === state.you ? null : (
            <MemberAudio
              key={member.id}
              name={member.name}
              track={remoteAudio(member)}
              speaker={local.chosen.speaker}
            />
          ),
        )}
        {sharer && (
          <MemberAudio
            key={`${sharer.id}-share`}
            name={sharer.name}
            track={sharerAudio}
            speaker={local.chosen.speaker}
            source="share"
          />
        )}
      </div>
      <ToastViewport toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </PhoneLayoutContext.Provider>
  )
}

/**
 * Tells the member spotlighted (G2, e4-t11) that everyone now sees them big, and when it ends:
 * nobody is shown to the whole room without knowing it
 */
function useSpotlightNotice(
  spotlight: string | null,
  you: string | null,
  show: (text: string) => void,
) {
  const previous = useRef(spotlight)
  useEffect(() => {
    const was = previous.current
    previous.current = spotlight
    if (you === null || was === spotlight) return
    if (spotlight === you) show(strings.view.spotlightOnYou)
    else if (was === you) show(strings.view.spotlightOffYou)
  }, [spotlight, you, show])
}

/**
 * The room's name as shown (e1-t05): what the host named it, else "<first member>'s room", else
 * (before anyone joined, or a room from before v6) its code
 */
function roomTitle(roomId: string, info: Pick<RoomInfo, 'name' | 'createdBy'> | null): string {
  if (info?.name) return info.name
  if (info?.createdBy) return strings.room.defaultName(info.createdBy)
  return strings.room.title(roomId)
}

/** Who the room hands the host role to first (AC-1.3, F3): a co-host, then anyone */
const successorOrder = (member: { role: Role }) => (member.role === 'cohost' ? 0 : 1)

/**
 * "You are the host now" when the role comes to us from someone else (AC-1.3's handoff); not
 * when a handover's notice already said who gave it (F3): call the returned function then
 */
function useHostNotice(role: Role | undefined, show: (text: string) => void): () => void {
  const previous = useRef(role)
  const announced = useRef(false)
  useEffect(() => {
    const before = previous.current
    previous.current = role
    if (role !== 'host' || (before !== 'participant' && before !== 'cohost')) return
    if (announced.current) announced.current = false
    else show(strings.room.youAreHost)
  }, [role, show])
  return useCallback(() => {
    announced.current = true
  }, [])
}

/**
 * For a host or co-host (F2, e1-t11): a toast, without a sound, whenever someone starts waiting
 * (the participants button's badge keeps counting them). `waiting` is null for everyone else.
 */
function useWaitingNotice(waiting: WaitingEntry[] | null, show: (text: string) => void) {
  const seen = useRef(new Set<string>())
  const ids = waiting?.map((entry) => entry.id).join(' ') ?? null
  const names = useRef(waiting)
  useEffect(() => {
    names.current = waiting
  })
  useEffect(() => {
    if (ids === null) return
    const now = names.current ?? []
    const arrived = now.filter((entry) => !seen.current.has(entry.id))
    seen.current = new Set(now.map((entry) => entry.id))
    if (arrived.length === 1) show(strings.participants.waitingArrived(arrived[0].name))
    else if (arrived.length > 1) show(strings.participants.waitingArrivedMany(arrived.length))
  }, [ids, show])
}

/** 「<名字> 開始分享畫面」 when someone else starts sharing (not when we do) */
function useShareStartedNotice(
  sharerId: string | null,
  you: string | null,
  name: { current: (id: string) => string },
  show: (text: string) => void,
) {
  const previous = useRef(sharerId)
  useEffect(() => {
    if (sharerId !== null && sharerId !== previous.current && sharerId !== you) {
      show(strings.screenShare.started(name.current(sharerId)))
    }
    previous.current = sharerId
  }, [sharerId, you, name, show])
}

/** How long someone speaks before the speaker layout gives them the big tile */
const SPEAKER_HOLD_MS = 1000

/**
 * One member's tile, with the speaking outline from their microphone's level (e4-t05); tells the
 * room when they start speaking (the speaker layout shows the last one heard, e4-t07)
 */
function MemberTile({
  level,
  onHeard,
  ...tile
}: TileProps & { level: MediaStreamTrack | null; onHeard?: () => void }) {
  const speaking = useSpeaking(level)
  const heard = useRef(onHeard)
  useEffect(() => {
    heard.current = onHeard
  })
  // Only after a second of speech: a cough or a beep does not take the big tile
  useEffect(() => {
    if (!speaking) return
    const timer = setTimeout(() => heard.current?.(), SPEAKER_HOLD_MS)
    return () => clearTimeout(timer)
  }, [speaking])
  return <Tile {...tile} speaking={speaking} />
}

const trackDevice = (track: MediaStreamTrack | null): string | null =>
  track?.getSettings?.().deviceId ?? null

const kindName = (kind: LocalKind) => (kind === 'mic' ? strings.devices.mic : strings.devices.cam)

function noticeText(notice: DeviceNotice): string {
  const kind = kindName(notice.kind)
  switch (notice.type) {
    case 'switched':
      return strings.devices.switched(kind, notice.label)
    case 'recovered':
      return strings.devices.recovered(kind, notice.label)
    case 'switchFailed':
      return strings.devices.switchFailed(kind)
  }
}

function problemText(kind: LocalKind, problem: MediaProblem): string {
  const { problems } = strings.devices
  const name = kindName(kind)
  switch (problem) {
    case 'denied':
      return problems.denied(name)
    case 'inUse':
      return problems.inUse(name)
    case 'notFound':
      return problems.notFound(name)
    case 'lost':
      return problems.lost(name)
    case 'unsupported':
      return problems.unsupported
    case 'unknown':
      return problems.unknown(name)
  }
}

/**
 * Why the microphone or camera is off against the person's wish (e2-t09), with what to do and a
 * retry. Without device support at all there is one notice and nothing to retry.
 */
function DeviceProblems({
  local,
  onRetry,
}: {
  local: LocalDevicesState
  onRetry: (kind: LocalKind) => void
}) {
  const kinds = (['mic', 'cam'] as const).filter((kind) => local[kind].problem !== null)
  if (kinds.length === 0) return null
  if (kinds.some((kind) => local[kind].problem === 'unsupported')) {
    return <Alert role="alert">{strings.devices.problems.unsupported}</Alert>
  }
  // The same refusal for both: one message, one retry
  const both = kinds.length === 2 && local.mic.problem === local.cam.problem
  const shown = both ? (['mic'] as const) : kinds
  return (
    <>
      {shown.map((kind) => (
        <Alert key={kind} role="alert">
          <span>
            {both && local.mic.problem === 'denied'
              ? strings.prejoin.problems.denied
              : problemText(kind, local[kind].problem!)}
          </span>
          <Button
            variant="secondary"
            onClick={() => (both ? kinds.forEach(onRetry) : onRetry(kind))}
          >
            {strings.common.retry}
          </Button>
        </Alert>
      ))}
    </>
  )
}

/** No WebRTC at all: nothing in the room would work (e2-t09) */
function Unsupported() {
  return (
    <Panel>
      <h1>{strings.unsupported.title}</h1>
      <p role="alert">{strings.unsupported.body}</p>
      <Link to="/">{strings.room.backHome}</Link>
    </Panel>
  )
}

function mediaErrorText(error: MediaTransportErrorCode | null): string | null {
  switch (error) {
    case null:
    case 'closed':
      return null
    case 'sfu_not_configured':
      return strings.errors.sfuNotConfigured
    case 'unauthorized':
      return strings.errors.sfuUnauthorized
    default:
      return strings.errors.sfu
  }
}

/**
 * The free-tier notices (e11-t13): a toast whenever the month's state gets worse while we are in
 * the room (or is already bad when we arrive), and one when our own camera was not sent
 */
function useUsageNotices(
  usage: UsageState,
  videoRefused: boolean,
  show: (text: string, tone: 'warn') => void,
) {
  useEffect(() => {
    if (usage === 'low') show(strings.usage.low, 'warn')
    if (usage === 'audioOnly') show(strings.usage.audioOnly, 'warn')
  }, [usage, show])
  useEffect(() => {
    if (videoRefused) show(strings.usage.videoRefused, 'warn')
  }, [videoRefused, show])
}

function statusText({ status, view }: RoomConnectionState): string {
  switch (status) {
    case 'connecting':
    case 'notFound':
    // The after-leave screen replaces the room at once (F1), the turned-away one (F2)
    case 'removed':
    case 'ended':
    case 'locked':
    case 'denied':
    case 'waitExpired':
    case 'waiting':
    // Back to the pre-join screen at once (F3)
    case 'passwordRequired':
    case 'passwordWrong':
    case 'passwordWait':
      return strings.room.connecting
    case 'open':
      return strings.room.memberCount(Object.keys(view?.members ?? {}).length)
    case 'reconnecting':
      return strings.room.reconnectingSelf
    case 'lost':
      return strings.room.lost
    case 'full':
      return strings.room.full
    case 'outdated':
      return strings.room.outdated
    case 'replaced':
      return strings.room.replaced
  }
}

function NotFound() {
  return (
    <Panel>
      <p role="alert">{strings.room.notFound}</p>
      <Link to="/">{strings.room.backHome}</Link>
    </Panel>
  )
}

const Page = styled.main`
  min-height: 100dvh;
  display: grid;
  place-items: center;
  font-family: ${font.ui};
  background: ${color.bg};
  color: ${color.fg};

  a {
    color: ${color.primary};
  }
`

const Panel = styled.section`
  display: grid;
  justify-items: center;
  gap: ${space(3)};
  padding: ${space(6)};
  text-align: center;

  h1 {
    margin: 0;
    font-size: 22px;
  }
  p {
    margin: 0;
  }
`

const Alert = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: ${space(2)};
  max-width: 640px;
  padding: ${space(2)} ${space(3)};
  border: 1px solid ${color.warn};
  border-radius: ${radius.button};
  background: ${color.surface};
  font-size: ${fontSize.small};
  text-align: left;
`

/**
 * The room (DESIGN.md §4.3): the top bar, the stage (with the side panel beside it on desktop:
 * chat from D3, participants from F1), the toolbar
 */
const Shell = styled.main`
  /*
   * The visible viewport, nothing more (e4-t07): the room never scrolls, so a phone's URL bar
   * neither hides nor shows under a swipe, and nothing jumps. 100vh first for browsers without
   * dvh.
   */
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  overscroll-behavior: none;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  font-family: ${font.ui};
  background: ${color.bg};
  color: ${color.fg};

  a {
    color: ${color.primary};
  }
`

const Centered = styled.div`
  grid-row: 1 / -1;
  display: grid;
  place-items: center;
`

/** The stage and, on desktop, the side panel to its right: the stage shrinks to make room */
const Middle = styled.div`
  display: flex;
  min-width: 0;
  min-height: 0;
`

const StageArea = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: ${space(2)};
  min-width: 0;
  min-height: 0;
  margin: ${space(3)};

  /* Phones: the stage gets every pixel, and stays clear of a sideways notch */
  @media ${media.phone} {
    margin: ${space(2)} max(${space(2)}, env(safe-area-inset-right)) ${space(2)}
      max(${space(2)}, env(safe-area-inset-left));
  }
`

/** The stage's own box under the sharing bar: the stage fills it, the notices float over it */
const StageBox = styled.div`
  position: relative;
  flex: 1;
  min-height: 0;
`

/** Above the stage, centred at the top: what is wrong and how to fix it */
const Notices = styled.div`
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  z-index: ${layer.overlay};
  display: grid;
  justify-items: center;
  gap: ${space(2)};
  width: min(100%, 640px);

  &:empty {
    display: none;
  }
`

const Note = styled.p`
  margin: 0;
  padding: ${space(1)} ${space(3)};
  border-radius: ${radius.pill};
  background: ${color.overlay};
  font-size: ${fontSize.small};
`

/** A text button inside a Note (「全部顯示」) */
const InlineButton = styled.button`
  margin-left: ${space(2)};
  padding: 0;
  border: none;
  background: none;
  color: ${color.primary};
  font: inherit;
  font-weight: 700;
  text-decoration: underline;
  cursor: pointer;
`

const ToolbarArea = styled.footer`
  display: flex;
  justify-content: center;
  padding: ${space(1)} ${space(3)};
  border-top: 1px solid ${color.line};
  background: ${color.surface};

  /* Phones: edge to edge, above the home indicator */
  @media ${media.phone} {
    padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
`
