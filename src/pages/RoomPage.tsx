import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import styled from 'styled-components'
import {
  MAX_NAME_CHARS,
  MAX_ROOM_NAME_CHARS,
  normalizeName,
  waitingQueue,
  type HostMemberAction,
  type Member,
  type NoticeMessage,
  type RecordingInfo,
  type RoomInfo,
  type Role,
  type WaitingEntry,
  MAX_SHARES,
  recordingOrder,
  shareOrder,
} from '../../shared/protocol.ts'
import { normalizePassword } from '../../shared/password.ts'
import { handQueue, type Reaction } from '../../shared/reactions.ts'
import { can } from '../../shared/roles.ts'
import {
  focusFirst,
  pickSpeaker,
  shareSlots,
  stageSources,
  stageFocus,
  stageLayout,
  visibleTiles,
  type LayoutChoice,
} from '../../shared/layout.ts'
import { isRoomKey } from '../../shared/slug.ts'
import type { UsageState } from '../../shared/usage.ts'
import { BlockedError, getRoom } from '../api/rooms.ts'
import { fetchIceConfig } from '../api/turn.ts'
import { Button } from '../components/Button.tsx'
import { ChatPanel } from '../components/ChatPanel.tsx'
import { ChatPreview } from '../components/ChatPreview.tsx'
import { ConfirmDialog } from '../components/ConfirmDialog.tsx'
import { LeaveDialog, PasswordDialog } from '../components/HostDialogs.tsx'
import { Drawer } from '../components/Drawer.tsx'
import { LeftScreen } from '../components/LeftScreen.tsx'
import {
  MotionOffContext,
  PhoneLayoutContext,
  type PhoneLayout,
  usePhoneLayoutQuery,
  useReducedMotion,
} from '../components/layoutContext.ts'
import { MemberAudio } from '../components/MemberAudio.tsx'
import type { MenuItem } from '../components/Menu.tsx'
import { NameDialog } from '../components/NameDialog.tsx'
import { OfflineScreen } from '../components/OfflineScreen.tsx'
import {
  ParticipantsPanel,
  type RecordAction,
  type RoleChange,
} from '../components/ParticipantsPanel.tsx'
import { RecordingConsentDialog } from '../components/RecordingConsentDialog.tsx'
import { RecordingRecovery } from '../components/RecordingRecovery.tsx'
import { PreJoin, type PasswordFieldProps } from '../components/PreJoin.tsx'
import type { PermissionGuideProps } from '../components/PermissionGuide.tsx'
import { SharingBar } from '../components/SharingBar.tsx'
import { ShortcutsDialog } from '../components/ShortcutsDialog.tsx'
import { ShareTile } from '../components/ShareTile.tsx'
import { WHITEBOARD_LAYER } from '../../shared/annotation.ts'
import {
  DEFAULT_ANNOTATION_POLICY,
  mayClearLayer,
  mayCloseBoard,
  mayDraw,
  mayOpenBoard,
  type AnnotationPolicy,
} from '../../shared/roles.ts'
import { useAnnotationStore } from '../room/useAnnotationStore.ts'
import { SharePicker } from '../components/SharePicker.tsx'
import { BoardStripTile } from '../components/BoardStripTile.tsx'
import { SettingsDialog } from '../components/SettingsDialog.tsx'
import { PanelTabs, SidePanel } from '../components/SidePanel.tsx'
import type { DeviceChoice } from '../components/DeviceSelect.tsx'
import { Stage } from '../components/Stage.tsx'
import { TileSeat } from '../components/TileSeat.tsx'
import { Tile, type TileProps } from '../components/Tile.tsx'
import type { StatsPanelProps } from '../components/StatsPanel.tsx'
import type { DownlinkStage, UplinkState } from '../media/adaptation.ts'
import { OffStageReactions } from '../components/TileReactions.tsx'
import { ToastViewport } from '../components/Toast.tsx'
import { Toolbar } from '../components/Toolbar.tsx'
import { TopBar } from '../components/TopBar.tsx'
import { TurnedAwayScreen, type TurnedAwayReason } from '../components/TurnedAwayScreen.tsx'
import { WaitingScreen } from '../components/WaitingScreen.tsx'
import { useToasts } from '../components/useToasts.ts'
import { VideoDemandContext } from '../components/useVideoDemand.ts'
import {
  audioProcessingSupport,
  canChooseSpeaker,
  canRecordLocally,
  canShareScreen,
  canSuppressNoise,
  canWebShare,
  shareStopsCamera,
  supportsWebRtc,
} from '../media/capabilities.ts'
import type { AudioProcessing } from '../media/audioProcessing.ts'
import { activeDeviceId, type MediaProblem } from '../media/devices.ts'
import { trackKey, type MediaTransportErrorCode } from '../media/MediaTransport.ts'
import type { RoomConnectionState } from '../room/RoomConnection.ts'
import type { DeviceNotice, LocalDevicesState, LocalKind } from '../room/LocalDevices.ts'
import {
  clearSession,
  loadDeviceLabels,
  loadDevices,
  resolveDevice,
  loadName,
  loadPrefs,
  loadSession,
  loadView,
  saveDevice,
  saveName,
  savePrefs,
  saveView,
  type DeviceChoices,
  type RoomPrefs,
  type ViewPrefs,
} from '../room/session.ts'
import { memberChanges, type MemberChanges } from '../room/roomEvents.ts'
import { Sounds, crowdAllowsSound } from '../room/sounds.ts'
import { useReactions } from '../room/useReactions.ts'
import { useHeldSpeaker } from '../room/useHeldSpeaker.ts'
import { useLocalDevices } from '../room/useLocalDevices.ts'
import { useLocalPreview } from '../room/useLocalPreview.ts'
import { useMediaSettings } from '../room/useMediaSettings.ts'
import { useBatteryHint } from '../room/useBatteryHint.ts'
import { useNoiseSuppression, type NoiseStatus } from '../room/useNoiseSuppression.ts'
import { useMutedSpeechHint } from '../room/useMutedSpeechHint.ts'
import { useMicSilence } from '../room/useMicSilence.ts'
import { useMediaPermissions } from '../room/usePermissions.ts'
import { useSpeakerTest } from '../room/useSpeakerTest.ts'
import { browserHints, detectGuide, detectSystem } from '../room/permissionGuide.ts'
import { useMicLevel } from '../room/useMicLevel.ts'
import { useChatNotifications } from '../room/useChatNotifications.ts'
import { useFileSharing } from '../room/useFileSharing.ts'
import { useRoomConnection } from '../room/useRoomConnection.ts'
import { useRoomTelemetry } from '../room/useRoomTelemetry.ts'
import type { LocalTracks } from '../room/RoomMedia.ts'
import { useRoomMedia } from '../room/useRoomMedia.ts'
import type { VideoDemandStore } from '../room/videoDemand.ts'
import { useRoomShortcuts } from '../room/useRoomShortcuts.ts'
import { useOnline } from '../pwa/online.ts'
import type { ShareNotice } from '../room/ScreenShare.ts'
import { ShareCameraGuard } from '../room/ShareCameraGuard.ts'
import { useScreenShare } from '../room/useScreenShare.ts'
import { useSelfCapture, useSharePreview } from '../room/useSharePreview.ts'
import { loadMainShare, saveMainShare } from '../room/mainShare.ts'
import { announceMeetingTab } from '../media/share.ts'
import { copyRoomLink, roomUrl, shareRoomLink, type LinkOutcome } from '../room/shareLink.ts'
import {
  linkPassword,
  linkWithPassword,
  loadKnownPassword,
  saveKnownPassword,
} from '../room/roomPassword.ts'
import { useKnownPassword } from '../room/useKnownPassword.ts'
import { useSpeaking } from '../room/useSpeaking.ts'
import {
  loadRecordingSettings,
  saveRecordingSettings,
  useLocalRecording,
  type RecordingEvent,
} from '../room/useLocalRecording.ts'
import { pickMimeType, type RecordingSettings } from '../record/format.ts'
import { EMPTY_SCENE, type Scene } from '../record/scene.ts'
import { useTransportFactory } from '../room/transportContext.ts'
import { telemetry } from '../telemetry.ts'
import { useAnnouncer } from '../components/LiveAnnouncer.tsx'
import { LOCALES, getLocale, setLocale, strings } from '../strings.ts'
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
  /** 純音訊模式 from the start (H3, e6-t04): chosen in the pre-join screen's 設定 */
  audioOnly?: boolean
  /**
   * The recordings (by recorder id) the pre-join screen asked about and we agreed to (I4,
   * CLAUDE.md rule 4): the room sends our `consent` for them at once instead of asking again
   */
  recordingAgreed?: string[]
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
  if (!isRoomKey(roomId)) {
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
  | { at: 'left'; reason: LeftReason | TurnedAwayReason; roomName: string; persistent?: boolean }

/**
 * `left`: pressed 「離開」; `closed`: the room was gone when we came back to it; `ended`, `removed`:
 * the host ended the meeting or removed us (F1)
 */
export type LeftReason = 'left' | 'closed' | 'ended' | 'endedSelf' | 'removed' | 'declined'

const isLeftReason = (reason: LeftReason | TurnedAwayReason): reason is LeftReason =>
  reason === 'left' ||
  reason === 'closed' ||
  reason === 'ended' ||
  reason === 'endedSelf' ||
  reason === 'removed' ||
  reason === 'declined'

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
          onLeft={(reason, roomName, persistent) =>
            setStage({ at: 'left', reason, roomName, persistent })
          }
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
          persistent={stage.persistent}
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
      status: 'loading' | 'missing' | 'error' | 'locked' | 'blocked'
      memberCount: null
      waitingRoom: false
      password: false
      recorders: readonly string[]
      accountName: null
    }
  | {
      status: 'ok'
      memberCount: number
      waitingRoom: boolean
      password: boolean
      /** Who records the meeting (I4): the pre-join screen says so and asks */
      recorders: readonly string[]
      /** The signed-in account's name (I2): the name field starts with it */
      accountName: string | null
    }

const NONE = {
  memberCount: null,
  waitingRoom: false,
  password: false,
  recorders: [],
  accountName: null,
} as const
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
  const retry = () => {
    setSummary(LOADING)
    setAttempt((n) => n + 1)
  }
  // Opened offline (the app shell, e4-t12): try again as soon as the network is back
  const online = useOnline()
  const offlineError = summary.status === 'error' && !online
  const [waitedOffline, setWaitedOffline] = useState(false)
  if (offlineError && !waitedOffline) setWaitedOffline(true)
  if (online && waitedOffline) {
    setWaitedOffline(false)
    retry()
  }
  useEffect(() => {
    let cancelled = false
    getRoom(roomId).then(
      (room) => {
        if (cancelled) return
        // The owner of a persistent room (I2) is let in past the lock, the waiting room and
        // the password: the room checks again, this only spares the screens
        const owner = room?.viewer?.owner === true
        setSummary(
          !room
            ? { status: 'missing', ...NONE }
            : room.locked && !owner
              ? { status: 'locked', ...NONE }
              : {
                  status: 'ok',
                  memberCount: room.memberCount,
                  waitingRoom: !!room.waitingRoom && !owner,
                  // A room from before v11 has no password time: none
                  password: room.passwordSetAt != null && !owner,
                  accountName: room.viewer?.name ?? null,
                  // ... before v17 no recordings
                  recorders: Object.values(room.recordings ?? {}).map(recordingKey),
                },
        )
      },
      (error: unknown) => {
        if (cancelled) return
        // This network is on the owner's blocklist (I1): no point in the pre-join screen
        setSummary({ status: error instanceof BlockedError ? 'blocked' : 'error', ...NONE })
      },
    )
    return () => {
      cancelled = true
    }
  }, [roomId, attempt])
  if (offlineError) return <OfflineScreen onRetry={retry} />
  switch (summary.status) {
    case 'loading':
      return <p role="status">{strings.room.connecting}</p>
    case 'missing':
      return <NotFound />
    case 'blocked':
      return <NotFound text={strings.room.blocked} />
    case 'locked':
      return (
        <TurnedAwayScreen
          reason="locked"
          roomName={strings.room.title(roomId)}
          onRetry={retry}
          onHome={onHome}
        />
      )
    default:
      return (
        <PreJoinScreen
          roomId={roomId}
          summary={summary}
          problem={problem}
          onJoin={onJoin}
          onHome={onHome}
        />
      )
  }
}

function PreJoinScreen({
  roomId,
  summary,
  problem,
  onJoin,
  onHome,
}: {
  roomId: string
  summary: Summary
  problem: PasswordProblem | null
  onJoin: (choices: JoinChoices) => void
  onHome: () => void
}) {
  // A signed-in account's name first (I2), else the one this browser remembers
  const [name, setName] = useState(() => summary.accountName ?? loadName())
  const [mic, setMic] = useState(true)
  const [cam, setCam] = useState(true)
  // The recording question (I4): asked here when the room is being recorded
  const recorders = summary.status === 'ok' ? summary.recorders : []
  const [recordingAgreed, setRecordingAgreed] = useState(false)
  // What was picked (remembered in localStorage) and where those devices are now (G1): a
  // remembered device with a new id is found by its label; an unplugged one falls back to the
  // browser's default meanwhile, and stays remembered
  const [picked, setPicked] = useState<DeviceChoices>(loadDevices)
  const [labels, setLabels] = useState<DeviceChoices>(loadDeviceLabels)
  // 設定 (H3): the processing switches and HD are remembered; 純音訊模式 is for this meeting
  const mediaSettings = useMediaSettings()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [audioOnly, setAudioOnly] = useState(false)
  const [processingSupported] = useState(audioProcessingSupport)
  const [noiseSupported] = useState(canSuppressNoise)
  const advancedNoise = noiseSupported && mediaSettings.advancedNoise && !mediaSettings.powerSaving
  const previewProcessing = useMemo(
    () => micProcessing(mediaSettings.processing, advancedNoise),
    [mediaSettings.processing, advancedNoise],
  )
  const phone = usePhoneLayoutQuery()
  const preview = useLocalPreview({
    mic,
    cam,
    micId: picked.mic,
    camId: picked.cam,
    micLabel: labels.mic,
    camLabel: labels.cam,
    processing: previewProcessing,
  })
  const lists = preview.devices
  const resolved: DeviceChoices = {
    ...preview.resolved,
    speaker: resolveDevice(picked.speaker, labels.speaker, lists.audiooutput),
  }
  const level = useMicLevel(preview.stream)
  const micListening = mic && (preview.stream?.getAudioTracks().length ?? 0) > 0
  const micSilent = useMicSilence(level, micListening)
  const [speakerSupported] = useState(canChooseSpeaker)
  const speakerTest = useSpeakerTest(resolved.speaker)
  const passwordField = usePasswordField(roomId, summary.password, problem)
  const permissionGuide = usePermissionGuide(preview.micProblem, preview.camProblem, preview.retry)
  const selected = {
    mic: resolved.mic ?? activeDeviceId(preview.stream, 'audio'),
    cam: resolved.cam ?? activeDeviceId(preview.stream, 'video'),
    speaker: resolved.speaker,
  }
  const onSelect = (choice: DeviceChoice, deviceId: string) => {
    const list =
      choice === 'mic' ? lists.audioinput : choice === 'cam' ? lists.videoinput : lists.audiooutput
    const label = list.find((option) => option.deviceId === deviceId)?.label ?? ''
    saveDevice(choice, deviceId, label)
    setPicked((current) => ({ ...current, [choice]: deviceId }))
    setLabels((current) => ({ ...current, [choice]: label || null }))
  }

  return (
    <>
      {settingsOpen && (
        <SettingsDialog
          phone={phone !== null}
          onClose={() => setSettingsOpen(false)}
          devices={preview.devices}
          selected={selected}
          onSelect={onSelect}
          speakerSupported={speakerSupported}
          processing={mediaSettings.processing}
          processingSupported={processingSupported}
          onProcessing={mediaSettings.setProcessing}
          hd={mediaSettings.hd}
          onHd={mediaSettings.setHd}
          audioOnly={audioOnly}
          onAudioOnly={setAudioOnly}
          advancedNoiseSupported={noiseSupported}
          advancedNoise={mediaSettings.advancedNoise}
          onAdvancedNoise={mediaSettings.setAdvancedNoise}
          powerSaving={mediaSettings.powerSaving}
          onPowerSaving={mediaSettings.setPowerSaving}
        />
      )}
      <PreJoin
        onSettings={() => setSettingsOpen(true)}
        audioOnly={audioOnly}
        roomId={roomId}
        memberCount={summary.memberCount}
        roomNotice={summary.status === 'error' ? strings.prejoin.loadFailed : null}
        waitingRoom={summary.waitingRoom}
        recording={recorders.length > 0}
        recordingAgreed={recordingAgreed}
        onRecordingAgreed={setRecordingAgreed}
        onHome={onHome}
        speakerTest={
          speakerSupported ? { playing: speakerTest.playing, onToggle: speakerTest.toggle } : null
        }
        micSilent={micSilent}
        permissionGuide={permissionGuide}
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
        selected={selected}
        onSelect={onSelect}
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
          // Devices found under a new id are remembered by it from now on
          const devices = { ...picked }
          for (const kind of ['mic', 'cam', 'speaker'] as const) {
            const now = resolved[kind]
            if (now === null || now === picked[kind]) continue
            saveDevice(kind, now, labels[kind] ?? '')
            devices[kind] = now
          }
          onJoin({
            name: normalized,
            mic,
            cam,
            devices,
            password,
            audioOnly,
            recordingAgreed: recordingAgreed ? [...recorders] : [],
          })
        }}
      />
    </>
  )
}

/**
 * The permission tutorial (G1, e4-t09): shown when the browser refused the microphone or camera.
 * The Permissions API (where there is one) tells a system block (the browser allows it, the
 * system does not) from a browser one, and retries by itself once the person allows it.
 */
function usePermissionGuide(
  micProblem: MediaProblem | null,
  camProblem: MediaProblem | null,
  retry: () => void,
): PermissionGuideProps | null {
  const permissions = useMediaPermissions()
  const [hints] = useState(browserHints)
  const micDenied = micProblem === 'denied'
  const camDenied = camProblem === 'denied'
  // A permission that goes from denied to allowed (or "ask") while the guide is up: try again
  // without a click. One that says granted from the start is a system block: no retry loop.
  const previous = useRef(permissions)
  useEffect(() => {
    const before = previous.current
    previous.current = permissions
    const lifted = (kind: 'mic' | 'cam') =>
      before[kind] === 'denied' && permissions[kind] !== 'denied' && permissions[kind] !== 'unknown'
    if ((micDenied && lifted('mic')) || (camDenied && lifted('cam'))) retry()
  }, [permissions, micDenied, camDenied, retry])
  if (!micDenied && !camDenied) return null
  return {
    blocked: micDenied && camDenied ? 'both' : micDenied ? 'mic' : 'cam',
    system:
      (micDenied && permissions.mic === 'granted') || (camDenied && permissions.cam === 'granted'),
    guide: detectGuide(hints),
    systemId: detectSystem(hints),
    watching: permissions.watching,
    onRetry: retry,
  }
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
  /** `persistent` (I2): the room outlives this meeting */
  onLeft: (reason: LeftReason | TurnedAwayReason, roomName: string, persistent?: boolean) => void
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
    onReaction,
    sendReaction,
    onAnnotation,
    isOpen,
  } = useRoomConnection(roomId, choices.name, choices.password)
  const annotationStore = useAnnotationStore(send, onAnnotation, isOpen)
  const toasts = useToasts()
  const { show } = toasts
  const fileSharing = useFileSharing(roomId, state.token)
  const roomInfo = state.view?.room ?? null
  // In the waiting room (F2): no view, only the lobby (kept while the socket reconnects)
  const lobby = state.lobby
  const waiting = lobby !== null
  const title = roomTitle(roomId, roomInfo ?? lobby?.room ?? null)
  // Whether this is a persistent room (I2), as last seen: the view may be gone once it ends
  const persistent = useRef(false)
  useEffect(() => {
    if (roomInfo) persistent.current = roomInfo.persistent === true
  }, [roomInfo])
  const gone = state.status === 'notFound'
  // The host removed us or ended the meeting (F1), or did not let us in (F2): the after-leave
  // screen, or the turned-away one, says which
  const outcome =
    state.status === 'removed' ||
    state.status === 'ended' ||
    state.status === 'locked' ||
    state.status === 'denied' ||
    state.status === 'waitExpired' ||
    state.status === 'recordingDeclined'
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
    onLeft(
      reason === 'ended' && endingSelf.current
        ? 'endedSelf'
        : reason === 'recordingDeclined'
          ? 'declined'
          : reason,
      title,
      persistent.current,
    )
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
  // Our raised hand (e5-t04): RoomDO keeps it (worker/roles.ts `raiseHand`)
  const handUp = self?.hand != null
  const onToggleHand = () => {
    send({ t: 'hand', up: !handUp })
    if (!handUp) show(strings.reactions.raised)
  }
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
  // 連線統計 (H2, e2-t14) opens in the same place as chat and participants
  const [panel, setPanel] = useState<'chat' | 'participants' | 'stats' | null>(null)
  const chatOpen = panel === 'chat'
  const togglePanel = (which: 'chat' | 'participants' | 'stats') =>
    setPanel((open) => (open === which ? null : which))
  const chat = useChatNotifications({
    messages: state.chat,
    loaded: state.chatLoaded,
    you: state.you,
    open: chatOpen,
  })
  // 更多's switches (G3): 音效 and 隱藏表情反應, remembered (session.ts)
  const [prefs, setPrefs] = useState<RoomPrefs>(loadPrefs)
  const updatePrefs = (changes: Partial<RoomPrefs>) => {
    const next = { ...prefs, ...changes }
    savePrefs(next)
    setPrefs(next)
  }
  // The room's sounds (e4-t16): never before a gesture, never while 音效 is off (sounds.ts)
  const [sounds] = useState(() => new Sounds())
  useEffect(() => sounds.setEnabled(prefs.sounds), [sounds, prefs.sounds])
  useEffect(() => () => sounds.close(), [sounds])
  // A chat message from someone else while the chat is closed: the preview bubble, and a blip
  useEffect(() => {
    if (chat.preview) sounds.play('chat')
  }, [chat.preview, sounds])
  // 設定 (H3, H4): the processing switches, HD, the advanced noise suppression and 省電模式,
  // remembered with the pre-join screen's
  const mediaSettings = useMediaSettings()
  const powerSaving = mediaSettings.powerSaving
  // 省電模式 turns motion off (e6-t05): the reduced-motion paths, in JS (MotionOffContext) and
  // CSS (GlobalStyle)
  useEffect(() => {
    if (!powerSaving) return
    document.documentElement.dataset.motion = 'off'
    return () => {
      delete document.documentElement.dataset.motion
    }
  }, [powerSaving])
  // Reactions floating over the tiles (e5-t03); none at all while hidden
  const reducedMotion = useReducedMotion() || powerSaving
  const reactions = useReactions(onReaction, { hidden: prefs.hideReactions, reducedMotion })
  const onReact = (emoji: Reaction) => {
    if (sendReaction(emoji) === 'rateLimited') show(strings.reactions.tooFast, 'warn')
  }
  // The room refused a message as too fast (the browser checks first, so this is rare)
  useEffect(
    () =>
      onError((code) => {
        if (code === 'rate_limited') show(strings.chat.rateLimited, 'warn')
        if (code === 'annotation_limit') show(strings.screenShare.annotationLimit, 'warn')
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
    {
      id: 'hide-reactions',
      label: strings.reactions.hide,
      section: viewSection,
      kind: 'checkbox',
      checked: prefs.hideReactions,
      onSelect: () => updatePrefs({ hideReactions: !prefs.hideReactions }),
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
  // Local recording (I4: e8-t01 – e8-t03). RoomDO decides who records and everyone sees it
  // (CLAUDE.md rules 1 and 4); the recorder itself is lazy (src/record/). It reads the scene the
  // page keeps up to date below, on every frame.
  const roomRecordings = state.view?.room.recordings
  const recorders = recordingOrder(roomRecordings)
  const recordingScene = useRef<Scene>(EMPTY_SCENE)
  const onRecordingEvent = (event: RecordingEvent) => {
    switch (event.type) {
      case 'started':
        show(strings.record.started)
        return
      case 'saved':
        if (event.saved.bytes === 0) show(strings.record.empty, 'warn')
        else if (event.problem === 'storage') show(strings.record.storageFull, 'warn')
        else if (event.problem === 'failed') show(strings.record.failed, 'warn')
        else show(strings.record.saved(event.saved.fileName))
        return
      case 'startFailed':
        show(strings.record.startFailed, 'warn')
        return
      case 'forbidden':
        // The room's refusal is already said (onError: strings.participants.forbidden)
        return
    }
  }
  const recording = useLocalRecording({
    roomId,
    roomName: title,
    you: state.you,
    recordings: state.view ? (roomRecordings ?? {}) : undefined,
    send,
    onError,
    getScene: () => recordingScene.current,
    powerSaving,
    notify: onRecordingEvent,
  })
  const [recordSupported] = useState(canRecordLocally)
  const [recordDialog, setRecordDialog] = useState(false)
  const [recordSettings, setRecordSettings] = useState<RecordingSettings>(loadRecordingSettings)
  const onStartRecording = (settings: RecordingSettings) => {
    setRecordDialog(false)
    setRecordSettings(settings)
    saveRecordingSettings(settings)
    recording.start(settings)
    // A long recording needs room: say so when the device is nearly full (it still starts)
    void navigator.storage
      ?.estimate?.()
      .then(({ quota, usage: used }) => {
        if (quota !== undefined && used !== undefined && quota - used < LOW_STORAGE_BYTES) {
          show(strings.record.lowStorage, 'warn')
        }
      })
      .catch(() => {})
  }
  const weRecord =
    recording.phase === 'starting' ||
    recording.phase === 'recording' ||
    recording.phase === 'saving'
  // The recording question (CLAUDE.md rule 4 「明確同意」): RoomDO keeps who agreed to each
  // recording; until we have, the room is blocked by the question. What the pre-join screen
  // asked about and we agreed to is sent at once (recordingAgreed)
  const unanswered =
    state.view !== null && !waiting
      ? recorders.filter(
          (entry) =>
            entry.memberId !== state.you && !(entry.consented ?? []).includes(state.you ?? ''),
        )
      : []
  const agreedBefore = choices.recordingAgreed ?? []
  const coveredByPrejoin =
    unanswered.length > 0 && unanswered.every((entry) => agreedBefore.includes(recordingKey(entry)))
  const consentAsked = unanswered.length > 0 && !coveredByPrejoin
  const unansweredKey = unanswered.map(recordingKey).join(',')
  // A fullscreen share would hide the recording question (CLAUDE.md rule 4)
  useEffect(() => {
    if (consentAsked && document.fullscreenElement) void document.exitFullscreen?.()
  }, [consentAsked])
  useEffect(() => {
    if (coveredByPrejoin) send({ t: 'consent' })
  }, [coveredByPrejoin, unansweredKey, send])
  const consentNames = unanswered.map((entry) => state.view?.members[entry.memberId]?.name ?? '')
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
    // 開始錄影 for who may record (the host, or someone the host allowed; RoomDO checks again);
    // grey where the browser cannot (e8-t03). 停止錄影 while we record.
    ...(weRecord || recording.phase === 'claiming'
      ? [
          {
            id: 'record-stop',
            label: strings.record.stop,
            section: strings.record.section,
            disabled: recording.phase === 'saving',
            onSelect: recording.stop,
          },
        ]
      : can(role, 'record') || self?.mayRecord === true
        ? [
            {
              id: 'record',
              label: strings.record.start,
              section: strings.record.section,
              disabled: !recordSupported,
              hint: recordSupported ? undefined : strings.record.unavailable,
              onSelect: () => setRecordDialog(true),
            },
          ]
        : []),
    ...viewItems,
    {
      id: 'sounds',
      label: strings.sounds.toggle,
      section: strings.sounds.section,
      kind: 'checkbox',
      checked: prefs.sounds,
      onSelect: () => updatePrefs({ sounds: !prefs.sounds }),
    },
    // 更多 › 連線統計 (H2, e2-t14)
    { id: 'stats', label: strings.stats.menu, onSelect: () => setPanel('stats') },
    // The list of keyboard shortcuts (G4, e4-t13), where there is a keyboard layout
    ...(phone === null
      ? [{ id: 'shortcuts', label: strings.shortcuts.menu, onSelect: () => setShortcutsOpen(true) }]
      : []),
    // 更多 › 語言 (G1, e4-t15): each language named in itself; switching keeps the call going
    ...LOCALES.map((which) => ({
      id: `language-${which}`,
      label: strings.language.names[which],
      section: strings.language.section,
      checked: getLocale() === which,
      onSelect: () => setLocale(which),
    })),
  ]
  const onNotice = useCallback((notice: DeviceNotice) => show(noticeText(notice), 'warn'), [show])
  // 設定 (H3: e6-t01, e6-t04): the dialog on a computer, the drawer on a phone
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [processingSupported] = useState(audioProcessingSupport)
  // The microphone and camera chosen on the pre-join screen, opened again for the room; the
  // toolbar turns them on and off and switches them after that (e2-t05, e2-t06). Joining in
  // 純音訊模式 leaves the camera closed (it comes on when the mode ends, if it was chosen).
  // 進階噪音抑制 (e6-t02) runs where it can, while chosen and not held off by 省電模式; meanwhile
  // the browser's own noise suppression pauses (no double processing: RNNoise works on the
  // microphone as it is, and the two together dull the voice)
  const [noiseSupported] = useState(canSuppressNoise)
  const advancedNoise = noiseSupported && mediaSettings.advancedNoise && !powerSaving
  const processing = useMemo(
    () => micProcessing(mediaSettings.processing, advancedNoise),
    [mediaSettings.processing, advancedNoise],
  )
  const { state: local, devices } = useLocalDevices(
    { mic: choices.mic, cam: choices.cam && !choices.audioOnly },
    choices.devices,
    onNotice,
    processing,
  )
  // A switch (or the advanced suppression) changed what the microphone is opened with: applied
  // to the open one, or by opening it again (LocalDevices.setProcessing)
  const appliedProcessing = useRef(processing)
  useEffect(() => {
    if (!devices || appliedProcessing.current === processing) return
    appliedProcessing.current = processing
    void devices.setProcessing(processing).then((outcome) => {
      if (outcome === 'failed') show(strings.settings.processingFailed, 'warn')
    })
  }, [devices, processing, show])
  const onProcessing = (next: AudioProcessing) => mediaSettings.setProcessing(next)
  const noise = useNoiseSuppression({
    mic: local.mic.track,
    on: advancedNoise && local.ready,
    onStop: (reason) => {
      mediaSettings.setAdvancedNoise(false)
      show(
        reason === 'overloaded'
          ? strings.settings.advancedNoiseOverloaded
          : strings.settings.advancedNoiseFailed,
        'warn',
      )
    },
  })
  // Low battery (Chromium's Battery Status API): 省電模式 is suggested once, never turned on
  useBatteryHint(!powerSaving, () => show(strings.settings.batteryLow))
  // Sent while unmuted: RNNoise's track once it runs, the microphone itself until then
  const micSending = local.mic.on ? (noise.track ?? local.mic.track) : null
  const camSending = local.cam.on ? local.cam.track : null
  const sending = useMemo<LocalTracks | null>(
    () => (local.ready ? { mic: micSending, cam: camSending } : null),
    [local.ready, micSending, camSending],
  )
  const [speakerSupported] = useState(canChooseSpeaker)
  // The sounds go to the speaker chosen for the room, where Web Audio can (Chrome, Edge)
  useEffect(() => sounds.setSpeaker(local.chosen.speaker), [sounds, local.chosen.speaker])

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
  // Screen sharing (D1; several at once from H5): RoomDO says who shares; our screen is
  // published once it lists our share
  const roomShares = state.view?.room.shares
  const sharerKey = shareOrder(roomShares)
    .map((share) => share.memberId)
    .join(' ')
  const sharerIds = useMemo(() => (sharerKey ? sharerKey.split(' ') : []), [sharerKey])
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
        case 'full':
          show(strings.screenShare.full(MAX_SHARES), 'warn')
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
  // Where the camera goes off while sharing (Safari, as a precaution): what the guard does is set
  // below, once everything it needs is declared
  const [cameraGuard] = useState(() => (shareStopsCamera() ? new ShareCameraGuard() : null))
  const screenShare = useScreenShare({
    guard: cameraGuard,
    shares: roomShares,
    you: state.you,
    send,
    onError,
    welcomes: state.welcomes,
    notify: onShareNotice,
  })
  const sharePhase = screenShare.phase
  const shareUnderWay =
    sharePhase === 'preparing' || sharePhase === 'claiming' || sharePhase === 'sharing'
  const cameraLocked = cameraGuard !== null && shareUnderWay
  const sharingScreen = sharePhase === 'sharing' ? screenShare.track : null
  // The share's sound (e3-t04): sent with the screen while the bar's switch is on
  const sharingAudio = sharePhase === 'sharing' && screenShare.audioOn ? screenShare.audio : null
  useShareStartedNotice(sharerIds, state.you, memberName, show)
  useBoardOpenedNotice(roomInfo?.whiteboard?.by ?? null, state.you, memberName, show)
  // This tab says it is a meeting tab, so a share of it is recognised (e3-t09, Capture Handle)
  useEffect(() => announceMeetingTab(roomId), [roomId])
  // The presenter view's thumbnail and the dynamic-content hint (e3-t06, e3-t08): our own
  // capture, sampled once a second, never what the SFU sends back
  const sharePreview = useSharePreview(sharingScreen, screenShare.noticeMotion)
  // Sharing the meeting itself (e3-t09): the warning, until dismissed for this screen
  const selfCaptureKind = useSelfCapture(sharingScreen ? screenShare.surface : null)
  const [selfCaptureDismissed, setSelfCaptureDismissed] = useState<MediaStreamTrack | null>(null)
  const selfCaptureShown =
    selfCaptureKind !== null && selfCaptureDismissed !== sharingScreen ? selfCaptureKind : null
  // Whose share this viewer keeps in the main area (e3-t07): the latest unless they chose one
  const [chosenShare, setChosenShare] = useState(() => loadMainShare(roomId))
  // Our own share in the main area, where its marks show (J3): only while we share
  const [ownViewWanted, setOwnViewWanted] = useState(false)
  if (ownViewWanted && sharingScreen === null) setOwnViewWanted(false)
  const chooseShare = (memberId: string) => {
    setOwnViewWanted(false)
    setChosenShare(memberId)
    saveMainShare(roomId, memberId)
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
    screenMode: screenShare.mode,
    send,
    you: state.you,
    view: state.view,
    welcomes: state.welcomes,
    hd: mediaSettings.hd,
    powerSaving,
    initialAudioOnly: choices.audioOnly ?? false,
    visibleOnly: true,
  })
  const usage = state.view?.usage ?? 'normal'
  useUsageNotices(usage, media.videoRefused, show)
  useRecordingStoppedNotice(recorders, state.you, memberName, show)
  // 純音訊模式 (e6-t04), whoever turns it on (the settings, H2's adaptation): the camera device
  // goes off with it (its light too) and comes back when it ends, if it was on
  const audioOnly = media.audioOnly
  const camBeforeAudioOnly = useRef(choices.cam && (choices.audioOnly ?? false))
  const audioOnlyBefore = useRef(audioOnly)
  const onAudioOnlyChange = useEffectEvent((on: boolean) => {
    if (on) {
      camBeforeAudioOnly.current = local.cam.on || local.cam.opening
      if (camBeforeAudioOnly.current) void devices?.setOn('cam', false)
    } else if (camBeforeAudioOnly.current) {
      camBeforeAudioOnly.current = false
      // During a share where the camera must stay off, it comes back when the share ends
      if (cameraGuard?.active) cameraGuard.hold()
      else void devices?.setOn('cam', true)
    }
  })
  useEffect(() => {
    if (audioOnly === audioOnlyBefore.current) return
    audioOnlyBefore.current = audioOnly
    onAudioOnlyChange(audioOnly)
  }, [audioOnly])
  useEffect(() => {
    cameraGuard?.configure({
      cameraOn: () => {
        const cam = devices?.getState().cam
        return !!cam && (cam.on || cam.opening)
      },
      turnOff: () => void devices?.setOn('cam', false),
      restore: () => {
        // Once the month is audio-only a camera that is off stays off (e11-t13)
        if (usage === 'audioOnly') return
        // 純音訊模式 sends no camera: it comes back when the mode ends
        if (audioOnly) camBeforeAudioOnly.current = true
        else void devices?.setOn('cam', true)
      },
      notify: () => show(strings.screenShare.cameraOffForShare, 'warn'),
    })
  })
  const cameraOpen = local.cam.on || local.cam.opening
  const cameraSent = media.published.some((track) => track.kind === 'cam' && !track.muted)
  useEffect(() => {
    if (cameraOpen) cameraGuard?.cameraCameOn()
    else if (!cameraSent) cameraGuard?.cameraGone()
  }, [cameraGuard, cameraOpen, cameraSent])
  // The uplink held HD back (e6-t04): said once each time
  useEffect(() => {
    if (media.hdLimited) show(strings.settings.hdLimitedToast, 'warn')
  }, [media.hdLimited, show])
  useAdaptationNotices(media.downlink, media.uplink, audioOnly, show)
  // The adaptation's audio-only suggestion (e2-t15) switches H3's 純音訊模式
  const switchAudioOnly = () => {
    media.setAudioOnly(true)
    show(strings.adapt.audioOnlyOn)
  }
  // The suggestion until the member answers it; it comes back after the link recovered
  const [suggestionDismissed, setSuggestionDismissed] = useState(false)
  if (suggestionDismissed && media.downlink !== 'audioOnly') setSuggestionDismissed(false)
  const suggestAudioOnly =
    inRoom && media.downlink === 'audioOnly' && !audioOnly && !suggestionDismissed
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
        cameraGuard?.forget()
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
      // G3 (e5-t04)
      case 'handLowered':
        show(strings.hostNotice.handLowered(who))
        return
      // I4 (e8-t02): the recorder's browser stops and saves on its own (useLocalRecording)
      case 'recordingStopped':
        show(strings.hostNotice.recordingStopped(who), 'warn')
        return
      case 'recordAllowed':
        show(strings.hostNotice.recordAllowed(who))
        return
      case 'recordRevoked':
        show(strings.hostNotice.recordRevoked(who))
        return
      // J3 (e7-t05)
      case 'annotationPolicy':
        if (notice.policy) {
          show(
            strings.hostNotice.annotationPolicy(
              who,
              strings.annotation.policy.options[notice.policy],
            ),
          )
        }
        return
      case 'annotationsCleared':
        // Maybe a sharer, not only a host: the name alone
        show(
          strings.hostNotice.annotationsCleared(
            actor?.name ?? '',
            notice.all === true,
            notice.layer === WHITEBOARD_LAYER,
          ),
          'warn',
        )
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
    if (action === 'lowerHand') {
      show(strings.reactions.lowered(viewMembers?.[memberId]?.name ?? ''))
    }
  }
  // Recording (I4): the host stops someone's, or allows them to record; RoomDO decides
  const onRecordAction = (action: RecordAction, memberId: string) => {
    const name = viewMembers?.[memberId]?.name ?? ''
    if (action === 'stop') {
      send({ t: 'host', action: 'stopRecording', memberId })
      show(strings.record.stoppedTheirs(name))
      return
    }
    send({ t: 'host', action: 'allowRecord', memberId, on: action === 'allow' })
    show(action === 'allow' ? strings.record.allowedNow(name) : strings.record.revokedNow(name))
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
  // Someone joined, left or raised a hand (G3): sounds (join and leave only in a small room) and,
  // for who can lower hands, a toast
  const staff = can(role, 'lowerHand')
  useMemberEvents(viewMembers, state.you, state.welcomes, (changes, count) => {
    if (changes.raised.length > 0 && staff) {
      for (const id of changes.raised)
        show(strings.reactions.handRaised(viewMembers?.[id]?.name ?? ''))
      sounds.play('hand')
    }
    if (!crowdAllowsSound(count)) return
    if (changes.joined.length > 0) sounds.play('join')
    else if (changes.left.length > 0) sounds.play('leave')
  })
  const onLock = (on: boolean) => {
    send({ t: 'host', action: 'lock', on })
    show(on ? strings.participants.lockedNow : strings.participants.unlockedNow)
  }
  const onWaitingRoom = (on: boolean) => {
    send({ t: 'host', action: 'waitingRoom', on })
    show(on ? strings.participants.waitingOnNow : strings.participants.waitingOffNow)
  }
  // Who may annotate (J3, e7-t05): RoomDO decides and tells everyone else
  const annotationPolicy: AnnotationPolicy = roomInfo?.annotationPolicy ?? DEFAULT_ANNOTATION_POLICY
  const onAnnotationPolicy = (policy: AnnotationPolicy) => {
    send({ t: 'host', action: 'annotationPolicy', policy })
    show(strings.annotation.policy.changed(strings.annotation.policy.options[policy]))
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
    if (shareUnderWay) {
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
    // The button is disabled meanwhile; this is for the keyboard shortcut
    if (cameraLocked) {
      show(strings.screenShare.cameraLocked, 'warn')
      return false
    }
    // Once the month is audio-only a camera that is off stays off (e11-t13): say so without
    // opening it
    if (!local.cam.on && usage === 'audioOnly') {
      show(strings.usage.videoRefused, 'warn')
      return false
    }
    // 純音訊模式 sends no camera (e6-t04): say how to get it back instead of opening it
    if (!local.cam.on && audioOnly) {
      show(strings.settings.audioOnlyCam, 'warn')
      return false
    }
    void devices?.setOn('cam', !local.cam.on)
    return true
  }

  const members = Object.values(state.view?.members ?? {})
  // Everyone's place in the raised-hand queue (e5-t04), 1 first
  const handPlace = new Map(handQueue(members).map((member, index) => [member.id, index + 1]))
  // Each member's camera as their tile shows it: ours while it sends, theirs while it is on
  const videoOf = (member: (typeof members)[number]): MediaStreamTrack | null => {
    if (member.id === state.you) return media.videoRefused || audioOnly ? null : camSending
    const cam = member.tracks.find((t) => t.kind === 'cam')
    return (cam && !cam.muted && media.received[trackKey(cam)]?.track) || null
  }
  // A camera the downlink paused (e2-t15) is still on: its tile stays when hiding tiles without video
  const paused = new Set(media.pausedVideos)
  const camKey = (member: (typeof members)[number]) => {
    const cam = member.tracks.find((t) => t.kind === 'cam')
    return cam ? trackKey(cam) : null
  }
  const videoPaused = (member: (typeof members)[number]) =>
    member.id !== state.you && paused.has(camKey(member) ?? '')
  // A camera that is on, not paused and not here: off screen, or its picture is on its way (L1).
  // Also still "on": its tile must stay, or it would never come into view and be subscribed
  const videoWaiting = (member: (typeof members)[number]) => {
    if (member.id === state.you || videoPaused(member)) return false
    const cam = member.tracks.find((t) => t.kind === 'cam')
    return !!cam && !cam.muted && !media.received[trackKey(cam)]
  }
  const shown = visibleTiles({
    tiles: members.map((member) => ({
      id: member.id,
      video: videoOf(member) !== null || videoPaused(member) || videoWaiting(member),
    })),
    you: state.you,
    hideSelf: view.hideSelf,
    hideNoVideo,
    keep: [pinnedId, spotlight],
  })
  const speaker = useHeldSpeaker(pickSpeaker(shown.ids, state.you, lastHeard), shown.ids)
  const focus = stageFocus(shown.ids, pinnedId, spotlight, speaker)
  // The cameras that stay when the downlink has to stop receiving cameras (e2-t15): the ones
  // chosen (a pin, a spotlight), then whoever the stage shows big and the speaker
  const camKeysOf = (ids: readonly (string | null)[]) =>
    [...new Set(ids)]
      .filter((id): id is string => id !== null && id !== state.you)
      .flatMap((id) => {
        const member = state.view?.members[id]
        const key = member ? camKey(member) : null
        return key ? [key] : []
      })
      .join(' ')
  const chosenKeys = camKeysOf([pinnedId, spotlight])
  const speakerKeys = camKeysOf([focus?.id ?? null, speaker])
  const { setVideoPriority } = media
  useEffect(() => {
    const split = (keys: string) => (keys === '' ? [] : keys.split(' '))
    setVideoPriority(split(chosenKeys), split(speakerKeys))
  }, [setVideoPriority, chosenKeys, speakerKeys])
  // Who could take over from us: connected members in the meeting, the room's own pick first
  const successors = members
    .filter((member) => member.id !== state.you && !member.reconnecting)
    .sort((a, b) => successorOrder(a) - successorOrder(b) || a.joinedAt - b.joinedAt)

  // Keyboard shortcuts and push-to-talk (G4, e4-t13): only in the room itself. 離開 from the
  // keyboard asks first (a host is asked who takes over, as with the button)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const micBusy = !local.ready || local.mic.opening
  // What a screen reader is told when nothing it is on changed (G5, e4-t14): a shortcut's result,
  // push-to-talk, the media coming back
  const announcer = useAnnouncer()
  const { announce } = announcer
  const talking = useRoomShortcuts({
    // Not while the recording question blocks the room (I4)
    enabled: inRoom && !consentAsked,
    micOn: local.mic.on,
    micBusy,
    setMic: (on) => void devices?.setOn('mic', on),
    onAction: (action) => {
      switch (action) {
        case 'mic':
          if (micBusy) return false
          void devices?.setOn('mic', !local.mic.on)
          announce(strings.shortcuts.announceMic(!local.mic.on))
          return
        case 'cam':
          if (!local.ready || local.cam.opening) return false
          // Refused in an audio-only month: the toast says so instead
          if (toggleCam()) announce(strings.shortcuts.announceCam(!local.cam.on))
          return
        case 'share':
          if (!screenShareSupported) return false
          onToggleShare()
          return
        case 'chat':
          togglePanel('chat')
          return
        case 'participants':
          togglePanel('participants')
          return
        case 'hand':
          onToggleHand()
          return
        case 'leave':
          if (role === 'host' && successors.length > 0) setLeaving(true)
          else setConfirmLeave(true)
          return
        case 'help':
          setShortcutsOpen(true)
          return
        case 'close':
          if (panel === null) return false
          setPanel(null)
          return
      }
    },
  })

  const talkingBefore = useRef(talking)
  useEffect(() => {
    if (talking === talkingBefore.current) return
    talkingBefore.current = talking
    announce(talking ? strings.shortcuts.talking : strings.shortcuts.talkingEnd)
  }, [talking, announce])
  const mediaReconnecting = inRoom && state.status === 'open' && media.status === 'reconnecting'
  useEffect(() => {
    if (mediaReconnecting) announce(strings.room.mediaReconnecting)
  }, [mediaReconnecting, announce])
  // Speaking while muted (e6-t03): a hint with a one-tap unmute; nothing is sent meanwhile
  // (useMutedSpeechHint.ts)
  const mutedSpeech = useMutedSpeechHint({
    track: local.mic.track,
    muted: local.ready && !local.mic.on,
    pushToTalk: talking,
    disabled: !inRoom,
  })
  useEffect(() => {
    if (mutedSpeech.hint) announce(strings.mutedSpeech.text)
  }, [mutedSpeech.hint, announce])
  // The 更多 menu's media items (H3), after the others
  const mediaItems: MenuItem[] = [
    {
      id: 'audio-only',
      label: strings.settings.audioOnly,
      section: strings.settings.title,
      kind: 'checkbox',
      checked: audioOnly,
      onSelect: () => media.setAudioOnly(!audioOnly),
    },
    {
      id: 'settings',
      label: strings.settings.menu,
      section: strings.settings.title,
      onSelect: () => setSettingsOpen(true),
    },
  ]

  // What a recording made here shows (I4, e8-t01): our stage's people and layout, the share in
  // our main area (ours too: the others see it), and every sound we hear plus our microphone.
  // The recorder reads it on each frame; it is only built while we record.
  const buildScene = (): Scene => {
    const received = (track: { sessionId: string; trackName: string } | undefined) =>
      (track && media.received[trackKey(track)]?.track) || null
    const byId = new Map(members.map((member) => [member.id, member]))
    const mainShare = shareSlots(sharerIds, null, chosenShare).main
    const sharer = mainShare === null ? undefined : byId.get(mainShare)
    const ids = sharer ? focusFirst(shown.ids, focus) : shown.ids
    // Who has not agreed to our recording yet (CLAUDE.md rule 4): their tile shows only their
    // initial, their screen and sound are left out, until RoomDO lists their consent
    const agreed = new Set(state.you ? (roomRecordings?.[state.you]?.consented ?? []) : [])
    const excluded = (id: string) => id !== state.you && !agreed.has(id)
    return {
      tiles: ids.flatMap((id) => {
        const member = byId.get(id)
        if (!member) return []
        const you = member.id === state.you
        const mic = member.tracks.find((t) => t.kind === 'mic')
        return [
          {
            id: member.id,
            name: member.name,
            video: excluded(member.id) ? null : videoOf(member),
            micMuted: you ? micSending === null : excluded(member.id) || (mic?.muted ?? true),
            you,
          },
        ]
      }),
      share: sharer
        ? {
            id: sharer.id,
            name: sharer.name,
            video:
              sharer.id === state.you
                ? sharingScreen
                : excluded(sharer.id)
                  ? null
                  : received(sharer.tracks.find((t) => t.kind === 'screen')),
            // What someone who has not agreed yet drew stays out too (CLAUDE.md rule 4)
            marks: () =>
              annotationStore.strokes(sharer.id).filter((stroke) => !excluded(stroke.by)),
          }
        : null,
      layout: stageLayout(view.layout, null, focus) === 'speaker' ? 'speaker' : 'grid',
      focus: focus?.id ?? null,
      audio: [
        ...members.flatMap((member) => {
          if (member.id === state.you || excluded(member.id)) return []
          const mic = member.tracks.find((t) => t.kind === 'mic' && !t.muted)
          const screenAudio = sharerIds.includes(member.id)
            ? member.tracks.find((t) => t.kind === 'screenAudio')
            : undefined
          return [received(mic), received(screenAudio)].filter(
            (track): track is MediaStreamTrack => track !== null,
          )
        }),
        ...(micSending ? [micSending] : []),
        ...(sharingAudio ? [sharingAudio] : []),
      ],
    }
  }
  useEffect(() => {
    if (weRecord) recordingScene.current = buildScene()
  })
  // The recorder reads the tracks, not the tiles (L1): the cameras it draws stay received
  // whatever this screen shows. Someone who has not agreed is drawn as an initial: not needed.
  const recordedCameras = weRecord
    ? shown.ids
        .filter(
          (id) => id !== state.you && roomRecordings?.[state.you ?? '']?.consented.includes(id),
        )
        .flatMap((id) => {
          const member = state.view?.members[id]
          const key = member ? camKey(member) : null
          return key ? [key] : []
        })
        .join(' ')
    : ''
  const { setVideoNeeded } = media
  useEffect(() => {
    setVideoNeeded(recordedCameras === '' ? [] : recordedCameras.split(' '))
  }, [setVideoNeeded, recordedCameras])

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
  // Someone else shares: their screen takes the main area (e3-t05, e4-t08); with several, the one
  // this viewer chose, else the latest, and the others go first in the strip (e3-t07). Our own
  // share is never shown back to us big (it would mirror endlessly): the presenter view is the
  // bar's thumbnail (e3-t08).
  // The whiteboard is one more thing that can take the main area (J3, e7-t06), and our own share
  // comes to it only when asked for (J3): the bar's button, never by itself.
  const sharers = sharerIds.flatMap((id) => state.view?.members[id] ?? [])
  const otherSharers = sharers.filter((sharer) => sharer.id !== state.you)
  const board = roomInfo?.whiteboard ?? null
  const ownView = ownViewWanted && sharingScreen !== null && state.you !== null
  const sources = stageSources(
    shareOrder(roomInfo?.shares),
    board && { layer: WHITEBOARD_LAYER, since: board.since },
  )
  const slots = ownView
    ? shareSlots(sources, null, state.you)
    : shareSlots(sources, state.you, chosenShare)
  const receivedOf = (member: Member, kind: 'screen' | 'screenAudio') => {
    const track = member.tracks.find((t) => t.kind === kind)
    return (track && media.received[trackKey(track)]?.track) || null
  }
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
      sharerIds={sharerIds}
      onAction={onMemberAction}
      onMuteAll={onMuteAll}
      onEndMeeting={onEndMeeting}
      waiting={waitingList}
      locked={roomInfo?.locked ?? false}
      waitingRoom={roomInfo?.waitingRoom ?? false}
      annotationPolicy={annotationPolicy}
      onAnnotationPolicy={onAnnotationPolicy}
      onLock={onLock}
      onWaitingRoom={onWaitingRoom}
      onAdmit={onAdmit}
      onDeny={onDeny}
      onAdmitAll={onAdmitAll}
      passwordSet={roomHasPassword}
      onPassword={() => setPasswordDialog(true)}
      onRole={onRole}
      recorderIds={recorders.map((entry) => entry.memberId)}
      onRecordAction={onRecordAction}
    />
  )
  // Whose a received track is, for the stats panel (e2-t14)
  const describeTrack = (key: string): ReturnType<StatsPanelProps['describe']> => {
    for (const member of members) {
      const track = member.tracks.find((t) => trackKey(t) === key)
      if (track) return { name: member.name, kind: track.kind }
    }
    return null
  }
  const statsPanel = (
    <Suspense fallback={null}>
      <StatsPanel
        store={media.stats}
        describe={describeTrack}
        onExported={() => show(strings.stats.exported)}
        noise={noiseSupported ? { status: noise.status, load: noise.load } : null}
      />
    </Suspense>
  )
  // The red light (CLAUDE.md rule 4): who records, in words; while we record it is 停止錄影
  const otherRecorders = recorders.filter((entry) => entry.memberId !== state.you)
  const recordingLabel =
    otherRecorders.length === 0
      ? strings.record.byYou
      : recorders.length > 1
        ? strings.record.byMany(recorders.length)
        : strings.record.byOne(viewMembers?.[otherRecorders[0].memberId]?.name ?? '')
  const mainSharer = otherSharers.find((sharer) => sharer.id === slots.main)
  const nameOnMarks = (memberId: string) => viewMembers?.[memberId]?.name ?? null
  const recordingText = recorders.length > 0 || weRecord ? recordingLabel : null
  const mainChoices = [
    ...otherSharers.map(({ id, name }) => ({ id, name })),
    ...(board
      ? [{ id: WHITEBOARD_LAYER, name: strings.whiteboard.label, label: strings.whiteboard.label }]
      : []),
  ].sort((a, b) => sources.indexOf(a.id) - sources.indexOf(b.id))
  const mainPicker =
    mainChoices.length > 1 ? (
      <SharePicker shares={mainChoices} main={slots.main ?? ''} onPick={chooseShare} />
    ) : undefined
  const boardOwner = board !== null && board.by === state.you
  const mayCloseThisBoard = board !== null && mayCloseBoard(role, boardOwner)
  const closeBoard = () => send({ t: 'whiteboard', open: false })
  const shareTile =
    slots.main === WHITEBOARD_LAYER ? (
      <Suspense fallback={null}>
        <Whiteboard
          key={WHITEBOARD_LAYER}
          store={annotationStore}
          me={mayDraw(annotationPolicy, role, boardOwner) ? state.you : null}
          manage={mayClearLayer(role, boardOwner)}
          nameOf={nameOnMarks}
          picker={mainPicker}
          recording={recordingText}
          onClose={mayCloseThisBoard ? closeBoard : undefined}
          roomName={roomInfo?.name ?? null}
        />
      </Suspense>
    ) : ownView && state.you ? (
      <ShareTile
        key={`${state.you}-own-share`}
        name={self?.name ?? ''}
        video={sharingScreen}
        annotations={{
          store: annotationStore,
          share: state.you,
          me: mayDraw(annotationPolicy, role, true) ? state.you : null,
          manage: mayClearLayer(role, true),
          nameOf: nameOnMarks,
          roomName: roomInfo?.name ?? null,
        }}
        recording={recordingText}
        picker={mainPicker}
        own={{
          // Not known to be a window or a tab: it may be everything, the meeting included
          mirrorRisk:
            selfCaptureKind !== null ||
            (screenShare.surface?.surface !== 'window' &&
              screenShare.surface?.surface !== 'browser'),
        }}
      />
    ) : mainSharer ? (
      <ShareTile
        key={`${mainSharer.id}-share`}
        name={mainSharer.name}
        video={receivedOf(mainSharer, 'screen')}
        annotations={{
          store: annotationStore,
          share: mainSharer.id,
          me: mayDraw(annotationPolicy, role, false) ? state.you : null,
          manage: mayClearLayer(role, false),
          nameOf: nameOnMarks,
          roomName: roomInfo?.name ?? null,
        }}
        recording={recordingText}
        picker={mainPicker}
      />
    ) : undefined
  // The other shares, first in the strip; each brings itself to the main area (e3-t07)
  const stripShares = [
    ...otherSharers
      .filter((sharer) => slots.strip.includes(sharer.id))
      .map((sharer) => (
        <ShareTile
          key={`${sharer.id}-share`}
          name={sharer.name}
          video={receivedOf(sharer, 'screen')}
          annotations={{ store: annotationStore, share: sharer.id, me: null, nameOf: nameOnMarks }}
          onShowMain={() => chooseShare(sharer.id)}
        />
      )),
    ...(slots.strip.includes(WHITEBOARD_LAYER)
      ? [<BoardStripTile key={WHITEBOARD_LAYER} onShowMain={() => chooseShare(WHITEBOARD_LAYER)} />]
      : []),
  ]
  // 更多 › 白板: open it (and bring it to our own main area), look at it, close it for everyone
  const boardItems: MenuItem[] = [
    ...(board === null && mayOpenBoard(annotationPolicy, role)
      ? [
          {
            id: 'whiteboard-open',
            label: strings.whiteboard.open,
            section: strings.whiteboard.section,
            onSelect: () => {
              send({ t: 'whiteboard', open: true })
              chooseShare(WHITEBOARD_LAYER)
            },
          },
        ]
      : []),
    ...(board !== null && slots.main !== WHITEBOARD_LAYER
      ? [
          {
            id: 'whiteboard-show',
            label: strings.whiteboard.show,
            section: strings.whiteboard.section,
            onSelect: () => chooseShare(WHITEBOARD_LAYER),
          },
        ]
      : []),
    ...(mayCloseThisBoard
      ? [
          {
            id: 'whiteboard-close',
            label: strings.whiteboard.close,
            section: strings.whiteboard.section,
            onSelect: closeBoard,
          },
        ]
      : []),
  ]
  // The tiles in the stage's order; in the share's strip the pinned or spotlighted one first
  // (a share keeps the main area)
  const byId = new Map(members.map((member) => [member.id, member]))
  const stageMembers = (shareTile ? focusFirst(shown.ids, focus) : shown.ids).flatMap(
    (id) => byId.get(id) ?? [],
  )
  const recordingLight =
    recorders.length > 0 || weRecord
      ? {
          label: recordingLabel,
          onStop: weRecord ? recording.stop : undefined,
          saving: recording.phase === 'saving',
        }
      : null
  return (
    <RoomContexts phone={phone} demand={media.demand} motionOff={powerSaving}>
      {/* The recording question makes everything else inert (CLAUDE.md rule 4) */}
      <Blockable inert={consentAsked}>
        <TopBar
          title={title}
          startedAt={roomInfo?.startedAt ?? null}
          status={statusText(state)}
          warn={state.status !== 'open'}
          locked={roomInfo?.locked ?? false}
          recording={recordingLight}
          onCopyLink={() => void copyRoomLink(link, title, strings.share.text).then(onLinkOutcome)}
          onLeave={onLeave}
        />
        <Middle>
          <StageArea>
            {sharePhase === 'sharing' && (
              <SharingBar
                note={cameraLocked ? strings.screenShare.cameraLocked : null}
                onStop={screenShare.stop}
                audio={
                  screenShare.audio
                    ? { on: screenShare.audioOn, onToggle: screenShare.toggleAudio }
                    : null
                }
                mode={{ value: screenShare.mode, onChange: screenShare.setMode }}
                motionHint={
                  screenShare.motionHint
                    ? {
                        onSwitch: () => screenShare.setMode('motion'),
                        onDismiss: screenShare.dismissMotionHint,
                      }
                    : null
                }
                preview={{
                  sample: sharePreview,
                  // A whole screen (or the meeting itself) would show the preview inside itself
                  off: screenShare.surface?.surface === 'monitor' || selfCaptureKind !== null,
                }}
                ownView={
                  state.you
                    ? {
                        open: ownView,
                        onToggle: () => setOwnViewWanted((open) => !open),
                        store: annotationStore,
                        layer: state.you,
                      }
                    : null
                }
                selfCapture={
                  selfCaptureShown
                    ? {
                        kind: selfCaptureShown,
                        onRepick: screenShare.repick,
                        onDismiss: () => setSelfCaptureDismissed(sharingScreen),
                      }
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
                  // Whoever speaks on another page of a large room (L1): nobody before anyone did
                  sideSpeaker={
                    lastHeard !== null && focus?.reason === 'speaker'
                      ? stageMembers.findIndex((member) => member.id === focus.id)
                      : null
                  }
                >
                  {stripShares}
                  {stageMembers.map((member) => {
                    const you = member.id === state.you
                    const mic = member.tracks.find((t) => t.kind === 'mic')
                    const audio = you ? null : remoteAudio(member)
                    return (
                      <MemberTile
                        key={member.id}
                        name={member.name}
                        you={you}
                        role={member.role}
                        reconnecting={you ? selfReconnecting : member.reconnecting}
                        relayed={you && media.usingRelay}
                        // Ours from our own stats while connected; theirs as they report it (e2-t13)
                        signal={
                          you ? (media.status === 'connected' ? media.signal : null) : member.signal
                        }
                        videoPaused={videoPaused(member)}
                        videoWaiting={videoWaiting(member)}
                        camera={you ? null : camKey(member)}
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
                        hand={handPlace.get(member.id) ?? null}
                        reactions={reactions[member.id]}
                        level={you ? micSending : mic && !mic.muted ? audio : null}
                        micMuted={you ? micSending === null : (mic?.muted ?? true)}
                        onHeard={you ? undefined : () => setLastHeard(member.id)}
                      />
                    )
                  })}
                </Stage>
              )}
              {inRoom && (
                // Reactions from someone whose tile is not on the stage (hidden): beside it
                <OffStageReactions
                  entries={members.flatMap((member) =>
                    stageMembers.some((shown) => shown.id === member.id)
                      ? []
                      : (reactions[member.id] ?? []).map((bubble) => ({
                          name: member.id === state.you ? strings.common.you : member.name,
                          bubble,
                        })),
                  )}
                />
              )}
              <Notices>
                {state.status === 'lost' && (
                  <Button variant="secondary" onClick={retryRoom}>
                    {strings.common.retry}
                  </Button>
                )}
                {/* Said by the announcer: a region added with its text is often not read */}
                {talking && <Note>{strings.shortcuts.talking}</Note>}
                {inRoom && media.status === 'connecting' && (
                  <Note>{strings.room.mediaConnecting}</Note>
                )}
                {mediaReconnecting && <Note>{strings.room.mediaReconnecting}</Note>}
                {suggestAudioOnly && (
                  <Alert role="alert">
                    <span>{strings.adapt.suggest}</span>
                    <AlertActions>
                      <Button variant="secondary" onClick={() => setSuggestionDismissed(true)}>
                        {strings.adapt.dismiss}
                      </Button>
                      <Button onClick={switchAudioOnly}>{strings.adapt.switchAudioOnly}</Button>
                    </AlertActions>
                  </Alert>
                )}
                {inRoom && <RecordingRecovery onDone={(text) => show(text)} />}
                {mediaLost && (
                  <Alert role="alert">
                    <span>{strings.room.mediaLost}</span>
                    <Button variant="secondary" onClick={media.retry}>
                      {strings.common.retry}
                    </Button>
                  </Alert>
                )}
                {mediaProblem && <Alert role="alert">{mediaProblem}</Alert>}
                {/* Said by the announcer, like push-to-talk */}
                {mutedSpeech.hint && (
                  <Note>
                    {strings.mutedSpeech.text}
                    <InlineButton
                      type="button"
                      onClick={() => {
                        mutedSpeech.dismiss()
                        void devices?.setOn('mic', true)
                      }}
                    >
                      {strings.mutedSpeech.unmute}
                    </InlineButton>
                    <InlineButton
                      type="button"
                      aria-label={strings.mutedSpeech.dismiss}
                      onClick={mutedSpeech.dismiss}
                    >
                      ×
                    </InlineButton>
                  </Note>
                )}
                {inRoom && audioOnly && (
                  <Note role="status">
                    {strings.settings.audioOnlyNote}
                    <InlineButton type="button" onClick={() => media.setAudioOnly(false)}>
                      {strings.settings.audioOnlyExit}
                    </InlineButton>
                  </Note>
                )}
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
          {panel === 'stats' && phone === null && (
            <SidePanel
              title={strings.stats.title}
              closeLabel={strings.stats.close}
              onClose={() => setPanel(null)}
            >
              {statsPanel}
            </SidePanel>
          )}
          {panel !== null && panel !== 'stats' && phone === null && (
            <SidePanel
              title={panel === 'chat' ? strings.chat.title : strings.participants.title}
              closeLabel={panel === 'chat' ? strings.chat.close : strings.participants.close}
              onClose={() => setPanel(null)}
            >
              {panelTabs}
              {panel === 'chat' ? (
                <ChatPanel
                  messages={state.chat}
                  you={state.you}
                  onSend={sendChat}
                  files={fileSharing}
                  autoFocus
                />
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
            sharing={shareUnderWay}
            onToggleShare={onToggleShare}
            chatOpen={chatOpen}
            chatUnread={chat.unread}
            onToggleChat={() => togglePanel('chat')}
            participantsOpen={panel === 'participants'}
            onToggleParticipants={() => togglePanel('participants')}
            moreItems={[...moreItems, ...boardItems, ...mediaItems]}
            onLeave={onLeave}
            micOn={local.mic.on}
            camOn={local.cam.on}
            micBusy={micBusy}
            camBusy={!local.ready || local.cam.opening || cameraLocked}
            camBusyHint={cameraLocked ? strings.screenShare.cameraLocked : undefined}
            onToggleMic={() => void devices?.setOn('mic', !local.mic.on)}
            onToggleCam={toggleCam}
            shortcuts={phone === null}
            devices={local.devices}
            selected={{
              mic: trackDevice(local.mic.track) ?? local.chosen.mic,
              cam: trackDevice(local.cam.track) ?? local.chosen.cam,
              speaker: local.chosen.speaker,
            }}
            onSelect={(choice, deviceId) => void devices?.select(choice, deviceId)}
            speakerSupported={speakerSupported}
            reactions={{ handUp, onReact, onToggleHand }}
          />
        </ToolbarArea>
        {panel === 'stats' && phone !== null && (
          <Drawer variant="full" title={strings.stats.title} onClose={() => setPanel(null)}>
            {statsPanel}
          </Drawer>
        )}
        {panel !== null && panel !== 'stats' && phone !== null && (
          <Drawer
            variant="full"
            title={panel === 'chat' ? strings.chat.title : strings.participants.title}
            onClose={() => setPanel(null)}
          >
            {panelTabs}
            {panel === 'chat' ? (
              <ChatPanel
                messages={state.chat}
                you={state.you}
                onSend={sendChat}
                files={fileSharing}
              />
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
        {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
        {recordDialog && (
          <Suspense fallback={null}>
            <RecordDialog
              initial={recordSettings}
              formats={recordFormats()}
              onStart={onStartRecording}
              onCancel={() => setRecordDialog(false)}
            />
          </Suspense>
        )}
        {settingsOpen && (
          <SettingsDialog
            phone={phone !== null}
            onClose={() => setSettingsOpen(false)}
            devices={local.devices}
            selected={{
              mic: trackDevice(local.mic.track) ?? local.chosen.mic,
              cam: trackDevice(local.cam.track) ?? local.chosen.cam,
              speaker: local.chosen.speaker,
            }}
            onSelect={(choice, deviceId) => void devices?.select(choice, deviceId)}
            speakerSupported={speakerSupported}
            processing={mediaSettings.processing}
            processingSupported={processingSupported}
            onProcessing={onProcessing}
            hd={mediaSettings.hd}
            hdLimited={media.hdLimited}
            onHd={mediaSettings.setHd}
            audioOnly={audioOnly}
            onAudioOnly={media.setAudioOnly}
            advancedNoiseSupported={noiseSupported}
            advancedNoise={mediaSettings.advancedNoise}
            advancedNoiseNote={noiseNote(noise.status)}
            onAdvancedNoise={mediaSettings.setAdvancedNoise}
            powerSaving={powerSaving}
            onPowerSaving={mediaSettings.setPowerSaving}
          />
        )}
        {confirmLeave && (
          <ConfirmDialog
            title={strings.shortcuts.leaveTitle}
            body={strings.shortcuts.leaveBody}
            confirmLabel={strings.shortcuts.leave}
            onConfirm={() => {
              setConfirmLeave(false)
              leave()
              onLeft('left', title)
            }}
            onCancel={() => setConfirmLeave(false)}
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
          {/* Every share's sound (e3-t04), whichever share is in the main area */}
          {otherSharers.map((sharer) => (
            <MemberAudio
              key={`${sharer.id}-share`}
              name={sharer.name}
              track={receivedOf(sharer, 'screenAudio')}
              speaker={local.chosen.speaker}
              source="share"
            />
          ))}
        </div>
      </Blockable>
      {consentAsked && (
        <RecordingConsentDialog
          who={strings.record.who(...consentNames)}
          onAgree={() => send({ t: 'consent' })}
          onLeave={() => {
            leave()
            onLeft('declined', title)
          }}
        />
      )}
      <ToastViewport toasts={toasts.toasts} onDismiss={toasts.dismiss} />
      {announcer.region}
    </RoomContexts>
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

/**
 * Calls `onChange` with who joined, left or raised a hand (G3, roomEvents.ts) whenever the room's
 * members change, and how many are in the room now. The first view after each welcome is where
 * we start from, not a change: who was there already did not just arrive.
 */
function useMemberEvents(
  members: Readonly<Record<string, Member>> | undefined,
  you: string | null,
  welcomes: number,
  onChange: (changes: MemberChanges, count: number) => void,
) {
  const previous = useRef<{ welcomes: number; members: Readonly<Record<string, Member>> } | null>(
    null,
  )
  const notify = useEffectEvent(onChange)
  useEffect(() => {
    if (!members) return
    const before = previous.current?.welcomes === welcomes ? previous.current.members : null
    previous.current = { welcomes, members }
    if (!before) return
    const changes = memberChanges(before, members, you)
    if (changes.joined.length + changes.left.length + changes.raised.length === 0) return
    notify(changes, Object.keys(members).length)
  }, [members, you, welcomes])
}

/** 「<名字> 開始分享畫面」 for everyone else who starts sharing (not when we do) */
function useShareStartedNotice(
  sharerIds: readonly string[],
  you: string | null,
  name: { current: (id: string) => string },
  show: (text: string) => void,
) {
  const previous = useRef(sharerIds)
  useEffect(() => {
    for (const id of sharerIds) {
      if (id !== you && !previous.current.includes(id)) {
        show(strings.screenShare.started(name.current(id)))
      }
    }
    previous.current = sharerIds
  }, [sharerIds, you, name, show])
}

/** Someone else opened the whiteboard (J3): it may have just taken the main area */
function useBoardOpenedNotice(
  by: string | null,
  you: string | null,
  name: { current: (id: string) => string },
  show: (text: string) => void,
) {
  const previous = useRef(by)
  useEffect(() => {
    if (by !== null && by !== you && previous.current !== by) {
      show(strings.whiteboard.opened(name.current(by)))
    }
    previous.current = by
  }, [by, you, name, show])
}

/**
 * What the room's components read from context: the phone layout (e4-t07), and where received
 * videos report their drawn size for the layer choice (e2-t12, useVideoDemand)
 */
function RoomContexts({
  phone,
  demand,
  motionOff,
  children,
}: {
  phone: PhoneLayout
  demand: VideoDemandStore
  /** 省電模式 (e6-t05): no animation, as with prefers-reduced-motion */
  motionOff: boolean
  children: ReactNode
}) {
  return (
    <PhoneLayoutContext.Provider value={phone}>
      <MotionOffContext.Provider value={motionOff}>
        <VideoDemandContext.Provider value={demand}>{children}</VideoDemandContext.Provider>
      </MotionOffContext.Provider>
    </PhoneLayoutContext.Provider>
  )
}

/**
 * What the microphone is opened with (e6-t02): the switches as chosen, except that the browser's
 * own noise suppression is off while the advanced one runs
 */
function micProcessing(processing: AudioProcessing, advancedNoise: boolean): AudioProcessing {
  return advancedNoise && processing.noiseSuppression
    ? { ...processing, noiseSuppression: false }
    : processing
}

/** The settings' line under 進階噪音抑制 while it is on but not running yet */
function noiseNote(status: NoiseStatus): string | null {
  if (status === 'loading') return strings.settings.advancedNoiseLoading
  if (status === 'paused') return strings.settings.advancedNoisePaused
  return null
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
  camera,
  ...tile
}: TileProps & {
  level: MediaStreamTrack | null
  onHeard?: () => void
  /** Their camera's trackKey: the tile's seat for it (L1); null for us, or without one */
  camera: string | null
}) {
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
  return (
    <TileSeat camera={camera}>
      <Tile {...tile} speaking={speaking} />
    </TileSeat>
  )
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
/** 連線統計 (e2-t14): its own chunk, loaded when the panel first opens */
const StatsPanel = lazy(() => import('../components/StatsPanel.tsx'))

/** The whiteboard (J3, e7-t06): its own chunk, loaded when someone first looks at it (rule 6) */
const Whiteboard = lazy(() => import('../annotate/Whiteboard.tsx'))

/** 錄影設定 (I4, e8-t03): its own chunk, like the recorder */
const RecordDialog = lazy(() => import('../components/RecordDialog.tsx'))

/** Below this much free storage a long recording may not fit: said when it starts (it still does) */
const LOW_STORAGE_BYTES = 1024 ** 3

/** The formats this browser would record in, for the hint in 錄影設定 */
function recordFormats(): { video: string | null; audio: string | null } {
  const isTypeSupported = (type: string) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)
  return { video: pickMimeType(isTypeSupported, false), audio: pickMimeType(isTypeSupported, true) }
}

/** One recording, as the pre-join screen's agreement names it (I4): who, and since when */
const recordingKey = (entry: { memberId: string; since: number }) =>
  `${entry.memberId} ${entry.since}`

/** 「<名字> 停止錄影了」 when someone else's recording ends */
function useRecordingStoppedNotice(
  recorders: readonly RecordingInfo[],
  you: string | null,
  name: { current: (id: string) => string },
  show: (text: string) => void,
) {
  const ids = recorders.map((entry) => entry.memberId).join(' ')
  const previous = useRef<string | null>(null)
  useEffect(() => {
    const before = previous.current
    previous.current = ids
    if (before === null) return
    const now = ids.split(' ')
    for (const id of before.split(' ')) {
      if (id !== '' && id !== you && !now.includes(id)) {
        show(strings.record.othersStopped(name.current(id)))
      }
    }
  }, [ids, you, name, show])
}

/**
 * What the bandwidth adaptation did, as toasts (e2-t15, PRD 「網路不穩，已降低畫質」): a step
 * down on what we receive or send, and the way back. The audio-only suggestion is a banner, not
 * a toast; nothing is said while the member chose audio-only.
 */
function useAdaptationNotices(
  downlink: DownlinkStage,
  uplink: UplinkState,
  audioOnly: boolean,
  show: (text: string, tone?: 'warn') => void,
) {
  const before = useRef(downlink)
  useEffect(() => {
    const was = before.current
    before.current = downlink
    if (was === downlink || audioOnly) return
    if (downlink === 'reduced' && was === 'normal') show(strings.adapt.reduced, 'warn')
    else if (downlink === 'videoCut' && was !== 'audioOnly') show(strings.adapt.videoCut, 'warn')
    else if (downlink === 'reduced' && was === 'videoCut') show(strings.adapt.videoBack)
    else if (downlink === 'normal') show(strings.adapt.recovered)
  }, [downlink, audioOnly, show])
  const limited = uplink.cam !== 'high' || uplink.screen !== 'high'
  const wasLimited = useRef(limited)
  useEffect(() => {
    if (wasLimited.current === limited) return
    wasLimited.current = limited
    if (limited) show(strings.adapt.uplinkLimited, 'warn')
    else show(strings.adapt.uplinkRestored)
  }, [limited, show])
}

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
    case 'recordingDeclined':
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
    case 'rateLimited':
      return strings.room.rateLimited
  }
}

function NotFound({ text }: { text?: string }) {
  return (
    <Panel>
      <p role="alert">{text ?? strings.room.notFound}</p>
      <Link to="/">{strings.room.backHome}</Link>
    </Panel>
  )
}

const Page = styled.main`
  min-height: 100dvh;
  display: grid;
  place-items: center;
  font-family: ${font.current};
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
  font-family: ${font.current};
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

const AlertActions = styled.span`
  display: inline-flex;
  flex-wrap: wrap;
  gap: ${space(2)};
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

/** The whole room but the recording question, made inert while it is asked (I4) */
const Blockable = styled.div`
  display: contents;
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
