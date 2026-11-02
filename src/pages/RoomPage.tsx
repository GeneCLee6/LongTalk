import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import styled from 'styled-components'
import {
  MAX_NAME_CHARS,
  MAX_ROOM_NAME_CHARS,
  normalizeName,
  type RoomInfo,
  type Role,
} from '../../shared/protocol.ts'
import { pickSpeaker } from '../../shared/layout.ts'
import { isRoomId } from '../../shared/room-id.ts'
import type { UsageState } from '../../shared/usage.ts'
import { getRoom } from '../api/rooms.ts'
import { fetchIceConfig } from '../api/turn.ts'
import { Button } from '../components/Button.tsx'
import { ChatPanel } from '../components/ChatPanel.tsx'
import { ChatPreview } from '../components/ChatPreview.tsx'
import { ConfirmDialog } from '../components/ConfirmDialog.tsx'
import { Drawer } from '../components/Drawer.tsx'
import { LeftScreen } from '../components/LeftScreen.tsx'
import {
  PhoneLayoutContext,
  usePhoneLayoutQuery,
  type PhoneLayout,
} from '../components/layoutContext.ts'
import { MemberAudio } from '../components/MemberAudio.tsx'
import type { MenuItem } from '../components/Menu.tsx'
import { NameDialog } from '../components/NameDialog.tsx'
import { PreJoin } from '../components/PreJoin.tsx'
import { SharingBar } from '../components/SharingBar.tsx'
import { ShareTile } from '../components/ShareTile.tsx'
import { SidePanel } from '../components/SidePanel.tsx'
import { Stage, type StageMode } from '../components/Stage.tsx'
import { Tile, type TileProps } from '../components/Tile.tsx'
import { ToastViewport } from '../components/Toast.tsx'
import { Toolbar } from '../components/Toolbar.tsx'
import { TopBar } from '../components/TopBar.tsx'
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
  saveDevice,
  saveName,
  type DeviceChoices,
} from '../room/session.ts'
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
}

/**
 * A tab that joined this room before (it still holds the session token) and knows its name goes
 * straight back in: a reload lands in the room as the same member (AC-1.2).
 */
function resume(roomId: string): JoinChoices | null {
  const name = loadName()
  return loadSession(roomId) && name ? { name, mic: true, cam: true, devices: loadDevices() } : null
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
  | { at: 'prejoin' }
  | { at: 'room'; choices: JoinChoices }
  | { at: 'left'; reason: LeftReason; roomName: string }

/** `left`: pressed 「離開」; `closed`: the room was gone when we came back to it */
export type LeftReason = 'left' | 'closed'

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
        />
      </Shell>
    )
  }
  if (stage.at === 'left') {
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
        onJoin={(choices) => {
          saveName(choices.name)
          setStage({ at: 'room', choices })
        }}
      />
    </Page>
  )
}

type Summary =
  | { status: 'loading' | 'missing' | 'error'; memberCount: null }
  | { status: 'ok'; memberCount: number }

/** Checks the room exists before the pre-join screen asks for the camera */
function PreJoinGate({
  roomId,
  onJoin,
}: {
  roomId: string
  onJoin: (choices: JoinChoices) => void
}) {
  const [summary, setSummary] = useState<Summary>({ status: 'loading', memberCount: null })
  useEffect(() => {
    let cancelled = false
    getRoom(roomId).then(
      (room) => {
        if (cancelled) return
        setSummary(
          room
            ? { status: 'ok', memberCount: room.memberCount }
            : { status: 'missing', memberCount: null },
        )
      },
      () => {
        if (!cancelled) setSummary({ status: 'error', memberCount: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [roomId])
  switch (summary.status) {
    case 'loading':
      return <p role="status">{strings.room.connecting}</p>
    case 'missing':
      return <NotFound />
    default:
      return <PreJoinScreen roomId={roomId} summary={summary} onJoin={onJoin} />
  }
}

function PreJoinScreen({
  roomId,
  summary,
  onJoin,
}: {
  roomId: string
  summary: Summary
  onJoin: (choices: JoinChoices) => void
}) {
  const [name, setName] = useState(loadName)
  const [mic, setMic] = useState(true)
  const [cam, setCam] = useState(true)
  const [devices, setDevices] = useState<DeviceChoices>(loadDevices)
  const preview = useLocalPreview({ mic, cam, micId: devices.mic, camId: devices.cam })
  const level = useMicLevel(preview.stream)
  const [speakerSupported] = useState(canChooseSpeaker)

  return (
    <PreJoin
      roomId={roomId}
      memberCount={summary.memberCount}
      roomNotice={summary.status === 'error' ? strings.prejoin.loadFailed : null}
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
      onJoin={() => {
        const normalized = normalizeName(name)
        if (normalized) onJoin({ name: normalized, mic, cam, devices })
      }}
    />
  )
}

function Room({
  roomId,
  choices,
  onLeft,
}: {
  roomId: string
  choices: JoinChoices
  onLeft: (reason: LeftReason, roomName: string) => void
}) {
  const {
    state,
    leave,
    send,
    retry: retryRoom,
    rename,
    onError,
    sendChat,
  } = useRoomConnection(roomId, choices.name)
  const toasts = useToasts()
  const { show } = toasts
  const roomInfo = state.view?.room ?? null
  const title = roomTitle(roomId, roomInfo)
  const gone = state.status === 'notFound'
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
  const self = state.you ? state.view?.members[state.you] : undefined
  const isHost = self?.role === 'host'
  useHostNotice(self?.role, show)
  useEffect(() => {
    document.title = `${title} · ${strings.appName}`
    return () => {
      document.title = strings.appName
    }
  }, [title])
  const [renaming, setRenaming] = useState<'room' | 'self' | null>(null)
  const phone = usePhoneLayoutQuery()
  // The chat (D3): a side panel on desktop, a full-screen drawer on phones
  const [chatOpen, setChatOpen] = useState(false)
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
      }),
    [onError, show],
  )
  // Whoever spoke last, for the speaker layout (phones held sideways)
  const [lastHeard, setLastHeard] = useState<string | null>(null)
  const [webShare] = useState(canWebShare)
  const [screenShareSupported] = useState(canShareScreen)
  const link = roomUrl(roomId)
  const onLinkOutcome = (outcome: LinkOutcome) => {
    if (outcome === 'copied') show(strings.topBar.copied)
    else if (outcome === 'failed') show(strings.topBar.copyFailed(link), 'warn')
  }
  const moreItems: MenuItem[] = [
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
    // Only the host may rename the room (RoomDO checks it too)
    ...(isHost
      ? [{ id: 'rename-room', label: strings.rename.room, onSelect: () => setRenaming('room') }]
      : []),
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
          show(strings.screenShare.stopped)
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

  // The room view stays on screen while the socket reconnects; so does the media connection
  const inRoom = state.status === 'open' || state.status === 'reconnecting'
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

  if (gone) {
    return (
      <Centered>
        <NotFound />
      </Centered>
    )
  }
  const members = Object.values(state.view?.members ?? {})
  // Gave up rebuilding the media session (e2-t08): say so, with a retry
  const mediaLost =
    media.status === 'failed' &&
    media.error !== 'sfu_not_configured' &&
    media.error !== 'unauthorized'
  const mediaProblem = mediaLost ? null : mediaErrorText(media.error)
  const selfReconnecting = state.status === 'reconnecting' || media.status === 'reconnecting'
  const onLeave = () => {
    leave()
    onLeft('left', title)
  }
  const remoteAudio = (member: (typeof members)[number]) => {
    const mic = member.tracks.find((t) => t.kind === 'mic')
    return (mic && media.received[trackKey(mic)]?.track) || null
  }
  const speaker = pickSpeaker(
    members.map((member) => member.id),
    state.you,
    lastHeard,
  )
  // Someone else shares: their screen takes the main area (e3-t05, e4-t08). Our own share is not
  // shown back to us (it would mirror endlessly; the presenter view is e3-t08): the bar says it.
  const sharer = roomShare ? state.view?.members[roomShare.memberId] : undefined
  const sharerScreen = sharer?.tracks.find((t) => t.kind === 'screen')
  // Its sound (e3-t04) plays apart from the share tile, like everyone's microphone
  const sharerAudioTrack =
    sharer && sharer.id !== state.you ? sharer.tracks.find((t) => t.kind === 'screenAudio') : null
  const sharerAudio =
    (sharerAudioTrack && media.received[trackKey(sharerAudioTrack)]?.track) || null
  const shareTile =
    sharer && sharer.id !== state.you ? (
      <ShareTile
        name={sharer.name}
        video={(sharerScreen && media.received[trackKey(sharerScreen)]?.track) || null}
      />
    ) : undefined
  return (
    <PhoneLayoutContext.Provider value={phone}>
      <TopBar
        title={title}
        startedAt={roomInfo?.startedAt ?? null}
        status={statusText(state)}
        warn={state.status !== 'open'}
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
                mode={stageMode(phone)}
                speaker={Math.max(
                  0,
                  members.findIndex((member) => member.id === speaker),
                )}
              >
                {members.map((member) => {
                  const you = member.id === state.you
                  const listed = (kind: 'mic' | 'cam') => member.tracks.find((t) => t.kind === kind)
                  const received = (kind: 'mic' | 'cam') => {
                    const track = listed(kind)
                    return (track && media.received[trackKey(track)]?.track) || null
                  }
                  const cam = listed('cam')
                  const mic = listed('mic')
                  const audio = you ? null : remoteAudio(member)
                  return (
                    <MemberTile
                      key={member.id}
                      name={member.name}
                      you={you}
                      reconnecting={you ? selfReconnecting : member.reconnecting}
                      relayed={you && media.usingRelay}
                      video={
                        you
                          ? media.videoRefused
                            ? null
                            : camSending
                          : cam && !cam.muted
                            ? received('cam')
                            : null
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
              <DeviceProblems local={local} onRetry={(kind) => void devices?.retry(kind)} />
            </Notices>
          </StageBox>
        </StageArea>
        {chatOpen && phone === null && (
          <SidePanel
            title={strings.chat.title}
            closeLabel={strings.chat.close}
            onClose={() => setChatOpen(false)}
          >
            <ChatPanel messages={state.chat} you={state.you} onSend={sendChat} autoFocus />
          </SidePanel>
        )}
      </Middle>
      <ToolbarArea>
        <Toolbar
          memberCount={members.length}
          canShareScreen={screenShareSupported}
          sharing={sharePhase === 'sharing' || sharePhase === 'claiming'}
          onToggleShare={onToggleShare}
          chatOpen={chatOpen}
          chatUnread={chat.unread}
          onToggleChat={() => setChatOpen((open) => !open)}
          onComingSoon={(feature) => show(strings.toolbar.comingSoon(feature))}
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
      {chatOpen && phone !== null && (
        <Drawer variant="full" title={strings.chat.title} onClose={() => setChatOpen(false)}>
          <ChatPanel messages={state.chat} you={state.you} onSend={sendChat} />
        </Drawer>
      )}
      {!chatOpen && (
        <ChatPreview
          message={chat.preview}
          onOpen={() => setChatOpen(true)}
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

/** Phones (e4-t07): held upright the gallery pages, held sideways the speaker is big */
function stageMode(phone: PhoneLayout): StageMode {
  if (phone === 'portrait') return 'paged'
  if (phone === 'landscape') return 'speaker'
  return 'grid'
}

/**
 * The room's name as shown (e1-t05): what the host named it, else "<first member>'s room", else
 * (before anyone joined, or a room from before v6) its code
 */
function roomTitle(roomId: string, info: RoomInfo | null): string {
  if (info?.name) return info.name
  if (info?.createdBy) return strings.room.defaultName(info.createdBy)
  return strings.room.title(roomId)
}

/** "You are the host now" when the role comes to us from someone else (AC-1.3's handoff) */
function useHostNotice(role: Role | undefined, show: (text: string) => void) {
  const previous = useRef(role)
  useEffect(() => {
    if (role === 'host' && previous.current === 'participant') show(strings.room.youAreHost)
    previous.current = role
  }, [role, show])
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
