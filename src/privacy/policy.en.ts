import { SOURCE_URL } from '../../shared/privacy.ts'
import {
  APP_CACHES,
  COOKIE_NAME,
  LOCAL_STORAGE_KEYS,
  RECORDINGS_DATABASE,
  SESSION_STORAGE_KEYS,
  type Facts,
} from './facts.ts'
import type { PolicyDocument, StorageDescriptions } from './types.ts'

// The privacy policy in English. Every statement was checked against the code (I6, e11-t07); when
// a behaviour changes, change this and policy.zh-TW.ts in the same pull request. Numbers come from
// `f` (facts.ts), never typed in.

const STORAGE: StorageDescriptions = {
  'longtalk.name': 'The name you last joined with',
  'longtalk.client':
    'A random id for this browser. It goes with every join, and a host’s removal blocks it for a while',
  'longtalk.devices': 'Which microphone, camera and speaker you chose (their ids)',
  'longtalk.deviceLabels': 'Those devices’ names, to find them again when an id changes',
  'longtalk.view': 'Your layout and “hide myself”',
  'longtalk.prefs': 'Sounds on or off, reactions hidden or shown',
  'longtalk.media':
    'Microphone processing, HD, advanced noise suppression, power saving, background blur, mirroring, the self-view tile and where it sits',
  'longtalk:volumes:<room>': 'The volume you set for each person in that room',
  'longtalk.account':
    'The name of the account signed in here, only so the home page’s link can say so. It is not what signs you in',
  'longtalk.locale': 'Your language',
  'longtalk.theme': 'Light or dark',
  'longtalk.installDismissed': 'That you dismissed the offer to install the app',
  'longtalk.recording.settings': 'The recording options you chose last',
  'longtalk.recording.pending': 'That an unfinished recording may be waiting in this browser',
  'longtalk.session.<room>':
    'Your member token in that room, so a reload brings you back as the same member',
  'longtalk.password.<room>':
    'That room’s password as you entered or set it, in plain text, for “copy link with password”',
  'longtalk:mainShare:<room>': 'Whose shared screen (or the whiteboard) you chose for the main area',
}

export const policy = (f: Facts): PolicyDocument => ({
  title: 'Privacy policy',
  updated: (date) => `Last updated ${date}`,
  contentsTitle: 'Contents',
  contactLink: 'Open the LongTalk contact page',
  contactPublicWarning:
    'That page is public: anyone can read what you post there. Don’t post your name, email address, phone number or anything else personal. Say which room or meeting it is about only if you are comfortable with that being public.',
  sections: [
    {
      id: 'about',
      title: 'What this page is',
      blocks: [
        {
          kind: 'p',
          text: [
            'This is a plain description of how LongTalk works and what happens to your data, written from what the code does. It is not legal advice, and it does not claim that LongTalk meets any particular law, standard or certification. “The operator” below means the person who runs this service.',
          ],
        },
        {
          kind: 'p',
          text: [
            'LongTalk’s code is public, so you can check these statements: ',
            { text: 'the source on GitHub', href: SOURCE_URL },
            '.',
          ],
        },
        {
          kind: 'p',
          text: ['In short:'],
        },
        {
          kind: 'list',
          items: [
            ['You can meet without an account. An account has no email address, password or phone number.'],
            ['LongTalk does not store your audio or video. A local recording exists only in the browser and on the device of the person who made it.'],
            ['Chat is deleted when the meeting closes. Chat files last at most a day.'],
            ['There are no ads and no third-party trackers or analytics scripts.'],
            ['Everything runs on Cloudflare, so Cloudflare handles your data, including your network address.'],
          ],
        },
      ],
    },
    {
      id: 'stored',
      title: 'What is stored, and where',
      blocks: [
        {
          kind: 'table',
          caption: 'What LongTalk stores in each place',
          columns: ['Place', 'What is in it'],
          rows: [
            {
              key: 'room',
              cells: [
                'The room (Cloudflare Durable Object, one per room)',
                `For the length of the meeting: the room’s name; each member’s display name, role, member token, this browser’s random id and microphone, camera and raised-hand state; the last ${f.chatMessages} chat messages; each chat file’s name, size, type and which member sent it; who is recording and who agreed; marks on shared screens and the whiteboard (strokes, text and who drew them); names in the waiting room; removed browsers’ ids. If the room has a password, a salted hash of it, and for wrong guesses the browser’s random id and a digest of the network.`,
              ],
            },
            {
              key: 'files',
              cells: [
                'Chat files (Cloudflare R2)',
                'The files people send in chat, unchanged, and a small thumbnail the sender’s browser made for images.',
              ],
            },
            {
              key: 'accounts',
              cells: [
                'Accounts (Cloudflare D1)',
                'Accounts, passkeys’ public keys, signed-in browsers, personal rooms and scheduled meetings. See “Accounts”.',
              ],
            },
            {
              key: 'backups',
              cells: [
                'Backups (Cloudflare R2, a separate bucket)',
                'A daily copy of the accounts, passkeys, personal rooms and scheduled meetings tables. See “Backups”.',
              ],
            },
            {
              key: 'guard',
              cells: [
                'Abuse protection (a Durable Object for the whole site)',
                'Hashes of networks with the times they created rooms or accounts, started sign-ins, saved meetings or uploaded files; recent offenders; the blocklist. See “Abuse protection”.',
              ],
            },
            {
              key: 'telemetry',
              cells: [
                'Telemetry (a Durable Object for the whole site)',
                'Counters of events per hour and per day, and recent error texts. See “Telemetry”.',
              ],
            },
            {
              key: 'counts',
              cells: [
                'Running totals (two Durable Objects for the whole site)',
                'This month’s video traffic, and how much the chat file bucket holds. Totals only, about nobody in particular.',
              ],
            },
            {
              key: 'media',
              cells: [
                'Audio and video (Cloudflare Realtime SFU and TURN)',
                'Passes through and is not stored by LongTalk. See “Audio and video”.',
              ],
            },
            {
              key: 'browser',
              cells: [
                'Your own browser',
                'Your name, your settings and, if you record, the recording. See “Cookies and browser storage”.',
              ],
            },
          ],
        },
        {
          kind: 'p',
          text: [
            'Everyone in a meeting sees the other members’ names and states and the chat, and can download chat files. Names in the waiting room reach every member’s browser, although only hosts and co-hosts are shown them.',
          ],
        },
      ],
    },
    {
      id: 'media',
      title: 'Audio and video, and what is never stored',
      blocks: [
        {
          kind: 'list',
          items: [
            ['Audio, video and screen sharing go from your browser through Cloudflare’s Realtime media servers to the others, and through Cloudflare’s TURN relay when a direct route is blocked. The connection is encrypted on the way, as WebRTC requires, but it is not end-to-end encrypted: Cloudflare’s servers handle the media.'],
            ['Background blur is computed entirely in your browser (the model and code load from LongTalk’s own site and connect nowhere else); the picture goes nowhere, and others only receive the blurred video.'],
            ['LongTalk has no server-side recording: no code stores audio or video on any server. The only recording is a local one, in the recorder’s own browser (see “Recording”).'],
            ['LongTalk’s own storage holds network addresses only as hashes, never the address itself. Cloudflare still sees your address, because that is how the connection works (see “Who else handles your data”).'],
            ['Room passwords are stored only as a salted hash. A link with a password in it carries the password in its address on the first page load, through Cloudflare; the page then removes it from the address bar.'],
            ['Telemetry holds no names, room addresses, chat or network addresses.'],
          ],
        },
      ],
    },
    {
      id: 'retention',
      title: 'How long data is kept',
      blocks: [
        {
          kind: 'table',
          caption: 'Data retention',
          columns: ['Data', 'Where', 'How long'],
          rows: [
            {
              key: 'media',
              cells: ['Audio and video', 'Not stored by LongTalk', 'Not kept.'],
            },
            {
              key: 'meeting',
              cells: [
                'A meeting: members, chat, chat file names, recording state and who agreed',
                'The room',
                `For as long as the meeting goes on, with no fixed limit. Deleted when the host ends it, or ${f.emptyRoomMinutes} minutes after the room empties. Someone who loses connection stays listed for ${f.reconnectSeconds} seconds.`,
              ],
            },
            {
              key: 'annotations',
              cells: [
                'Marks on a shared screen and on the whiteboard: strokes, text and who drew them (the laser pointer is not stored)',
                'The room',
                'On a shared screen: deleted when that person stops sharing. On the whiteboard: kept when it is closed, deleted when someone clears it or the meeting ends (a personal room’s whiteboard: the next row). Marks on a shared screen can be cleared too, and everything goes when the meeting ends.',
              ],
            },
            {
              key: 'boards',
              cells: [
                'A personal room’s whiteboard: strokes and text, without who drew them',
                'R2',
                `Saved every ${f.boardSaveMinutes} minutes during a meeting, when the last person leaves and when the meeting ends, and used by the next meeting, with no fixed limit. Deleted when someone clears it, or with the room or the account; should that fail at the time, the hourly job deletes it.`,
              ],
            },
            {
              key: 'waiting',
              cells: [
                'A name in the waiting room',
                'The room',
                `Until let in, refused or gone, at most ${f.waitingMinutes} minutes.`,
              ],
            },
            {
              key: 'bans',
              cells: [
                'A removed or refused browser’s random id',
                'The room',
                `${f.banMinutes} minutes after removal; ${f.denySeconds} seconds after being refused at the waiting room.`,
              ],
            },
            {
              key: 'guesses',
              cells: [
                'Behind wrong password guesses: the browser’s random id and a digest of the network',
                'The room',
                `${f.guessMinutes} minutes.`,
              ],
            },
            {
              key: 'files',
              cells: [
                'Chat files and thumbnails',
                'R2',
                `At most ${f.fileHours} hours from the start of the upload: no download after that, and an hourly job deletes them between ${f.fileHours} and ${f.fileGoneHours} hours. If the meeting closes first, they are deleted then.`,
              ],
            },
            {
              key: 'account',
              cells: [
                'Account and passkeys',
                'D1',
                'Until you delete them. An unused account is not deleted automatically.',
              ],
            },
            {
              key: 'personalRoom',
              cells: [
                'A personal room: address, name, password hash, waiting room and lock settings',
                'D1 and the room',
                'Until its owner deletes it or the account. The meeting data above still goes as described.',
              ],
            },
            {
              key: 'session',
              cells: [
                'A signed-in browser',
                'D1',
                `Ends after ${f.sessionIdleDays} days unused and at most ${f.sessionMaxDays} days after signing in, or when you sign out. The expired row is removed the next time anyone signs in.`,
              ],
            },
            {
              key: 'challenge',
              cells: [
                'A sign-in challenge (and, when signing up, the new account’s name)',
                'D1',
                `Deleted when used; otherwise it expires after ${f.challengeMinutes} minutes and is removed at the next sign-in attempt.`,
              ],
            },
            {
              key: 'meeting-scheduled',
              cells: [
                'A scheduled meeting',
                'D1',
                `Until you delete it, its room or the account; otherwise ${f.meetingDays} days after it ended. From then it can’t be seen, and it is removed the next time anyone saves a scheduled meeting.`,
              ],
            },
            {
              key: 'backup',
              cells: ['Daily backups', 'R2', `${f.backupDays} days.`],
            },
            {
              key: 'telemetry',
              cells: [
                'Telemetry counters',
                'Durable Object',
                `Per day: ${f.telemetryDays} days. Per hour: ${f.telemetryHours} hours.`,
              ],
            },
            {
              key: 'errors',
              cells: [
                'Error texts reported by browsers',
                'Durable Object',
                `The latest ${f.errorSamples} different errors. There is no time limit: an error stays until newer ones replace it.`,
              ],
            },
            {
              key: 'network',
              cells: [
                'Network hashes for rate limits',
                'Durable Object',
                `Times older than ${f.networkCountHours} hours stop counting and are dropped when that network next acts, but the hash itself is not removed automatically.`,
              ],
            },
            {
              key: 'blocks',
              cells: [
                'Blocked networks and recent offenders (hashes)',
                'Durable Object',
                `A block lasts at most ${f.blockMaxDays} days. The latest ${f.offenders} offenders are kept with no time limit.`,
              ],
            },
            {
              key: 'logs',
              cells: [
                'Worker logs',
                'Cloudflare',
                `${f.cloudflareLogDays} days on this plan, according to Cloudflare.`,
              ],
            },
            {
              key: 'recording',
              cells: [
                'A local recording while it is made',
                'The recorder’s browser',
                `Deleted from the browser about ${f.recordingKeepMinutes} minutes after the file is downloaded, or on the next visit if the tab closed first. An unfinished one stays until the recorder downloads or discards it.`,
              ],
            },
            {
              key: 'recordingFile',
              cells: [
                'A downloaded recording file',
                'The recorder’s device',
                'As long as the recorder keeps it. LongTalk can’t reach it.',
              ],
            },
            {
              key: 'browserStorage',
              cells: [
                'Settings in your browser',
                'Your browser',
                'localStorage until you clear it; sessionStorage until the tab closes.',
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'chat-files',
      title: 'Chat and files',
      blocks: [
        {
          kind: 'list',
          items: [
            ['Chat belongs to the meeting. It is not kept for the next meeting, even in a personal room, and there is no chat history anywhere after the meeting closes.'],
            ['Only members of the room can download its files, and only while they last. A file’s name stays with its chat message until the meeting closes.'],
            ['Files are stored as sent. Photos can carry their location and camera details (EXIF), which stay in the original; thumbnails don’t have them. Remove them first if that matters.'],
            ['Uploads are checked for their type, not for what they say or show. LongTalk does not scan their content in any other way.'],
            ['Anyone in the meeting can copy what they see or download a file. LongTalk can’t delete those copies.'],
          ],
        },
      ],
    },
    {
      id: 'accounts',
      title: 'Accounts',
      blocks: [
        {
          kind: 'p',
          text: [
            'Accounts are optional and use passkeys only: there is no email address, password or phone number, which also means there is no way to recover an account whose passkeys are all lost. An account holds:',
          ],
        },
        {
          kind: 'list',
          items: [
            ['A random id, your display name and when it was made.'],
            ['For each passkey: its id and public key (the private key never leaves your device or password manager), algorithm, signature counter, transports, the authenticator model’s public id (AAGUID), whether it is synced, and when it was made and last used.'],
            ['For each signed-in browser: a random id, a hash of its token, and when it signed in, was last used and will expire. No network address or browser type.'],
            ['Your personal rooms and scheduled meetings: address, title, description, start, duration, time zone. No attendee list.'],
          ],
        },
        {
          kind: 'p',
          text: [
            'Anyone with a scheduled meeting’s link can see its title, description, time, time zone and the owner’s display name, and from shortly before it starts the room’s address.',
          ],
        },
      ],
    },
    {
      id: 'backups',
      title: 'Backups',
      blocks: [
        {
          kind: 'list',
          items: [
            [`Once a day the accounts, passkeys, personal rooms and scheduled meetings tables are copied to a separate storage bucket and kept for ${f.backupDays} days. Signed-in browsers and sign-in challenges are not copied. Rooms’ meeting data, chat and files are not in the backup.`],
            ['Backups have no encryption of their own beyond what Cloudflare’s storage provides. They can be reached through the operator’s Cloudflare account.'],
            [`A deleted account lingers in backups: deleting does not change old backups, so your data is gone from them up to ${f.backupDays} days later.`],
            ['If the database ever has to be restored from a backup, accounts deleted after that backup would come back. The operator’s restore procedure requires deleting them again straight after.'],
            [`Separately, Cloudflare’s platform has its own recovery features, which LongTalk’s code does not use: according to Cloudflare, the operator could restore the accounts database to a point up to ${f.cloudflareD1RecoveryDays} days back and a room’s storage to a point up to ${f.cloudflareRoomRecoveryDays} days back. So deleted data can remain in Cloudflare’s systems for that long.`],
          ],
        },
      ],
    },
    {
      id: 'telemetry',
      title: 'Telemetry',
      blocks: [
        {
          kind: 'p',
          text: [
            'Your browser reports a few kinds of events to LongTalk’s own server, so the operator can tell whether meetings work:',
          ],
        },
        {
          kind: 'list',
          items: [
            ['Joining a room worked, or failed and why; a reconnection; a rebuilt media session; whether media went through the relay.'],
            ['The 1–5 score you may give after leaving: the score only.'],
            ['Errors in the page and security policy reports. Their text is cut short, and web addresses, email addresses, long numbers and room addresses are removed in your browser and again on the server. An error’s text could in rare cases still contain something else that was in the message.'],
          ],
        },
        {
          kind: 'p',
          text: [
            'Events carry no name, room address, chat or account id, and are only added to counters. To limit how many events one source can send, the server uses a hash of your network address in memory, and does not store it.',
          ],
        },
        {
          kind: 'p',
          text: [
            `Cloudflare also keeps logs of the Worker for the operator to read, ${f.cloudflareLogDays} days on this plan according to Cloudflare. They describe each request to LongTalk’s server, including its web address, which can contain a room’s address. Cloudflare’s documentation doesn’t list every field, so assume they can also contain your network address.`,
          ],
        },
      ],
    },
    {
      id: 'abuse',
      title: 'Abuse protection',
      blocks: [
        {
          kind: 'list',
          items: [
            ['To limit how fast one network can create rooms, sign in or upload, LongTalk keeps a hash of the network (an IPv4 address, or the first half of an IPv6 address) and when it did so. The address itself is not stored.'],
            ['A hash is not anonymous. Someone with access to the storage could work out an IPv4 address by trying them all, unless a secret key is set on the server, which is optional.'],
            ['The operator can block a network for a time. Blocks and recent offenders are hashes, with any short note the operator adds. Everyone behind a blocked network is affected.'],
            ['Creating a room or an account may ask for Cloudflare Turnstile’s human check, if the operator has turned it on. Your browser then loads Cloudflare’s script, and the server sends Cloudflare your network address to verify the result.'],
          ],
        },
      ],
    },
    {
      id: 'processors',
      title: 'Who else handles your data',
      blocks: [
        {
          kind: 'p',
          text: [
            'Cloudflare runs all of LongTalk: the website and server (Workers), rooms (Durable Objects), the accounts database (D1), files and backups (R2), media (Realtime SFU, TURN and STUN) and the optional human check (Turnstile). It sees your network address and the traffic it carries. Its own terms apply: ',
            { text: 'Cloudflare’s privacy policy', href: 'https://www.cloudflare.com/privacypolicy/' },
            '.',
          ],
        },
        {
          kind: 'p',
          text: [
            'No region is set for this data, so Cloudflare decides where it is processed and stored, which can be outside your country.',
          ],
        },
        {
          kind: 'p',
          text: [
            'Others only get something if you choose to go to them: “Add to Google Calendar” and “Add to Outlook” send the meeting’s details to that service when you open them; links in chat lead wherever they lead; the contact link below goes to a service outside LongTalk. No other service receives anything from LongTalk’s pages, and the site’s security policy stops the pages from connecting anywhere except LongTalk’s own server, apart from the Cloudflare check above. There are no ads or trackers.',
          ],
        },
      ],
    },
    {
      id: 'browser',
      title: 'Cookies and browser storage',
      blocks: [
        {
          kind: 'p',
          text: [
            `LongTalk sets one cookie, ${COOKIE_NAME}, and only after you sign in to an account. It holds a random token, is sent only to LongTalk’s site and can’t be read by scripts. It lasts up to ${f.sessionIdleDays} days from last use, and at most ${f.sessionMaxDays} days from signing in. Without an account there are no cookies from LongTalk’s code. Cloudflare might set a cookie of its own for security, such as during the human check; LongTalk does not control that.`,
          ],
        },
        {
          kind: 'table',
          caption: 'What LongTalk keeps in your browser',
          columns: ['Key', 'Kept in', 'What for'],
          rows: [
            ...LOCAL_STORAGE_KEYS.map((key) => ({
              key,
              cells: [key, 'localStorage', STORAGE[key]],
            })),
            ...SESSION_STORAGE_KEYS.map((key) => ({
              key,
              cells: [key, 'sessionStorage', STORAGE[key]],
            })),
            {
              key: RECORDINGS_DATABASE,
              cells: [
                RECORDINGS_DATABASE,
                'IndexedDB',
                'A local recording while it is made: the video and sound, the room’s address and name, and the file name',
              ],
            },
            {
              key: APP_CACHES,
              cells: [
                APP_CACHES,
                'Cache Storage',
                'The app’s own files, so it opens quickly and offline. Nothing about you',
              ],
            },
          ],
        },
        {
          kind: 'p',
          text: [
            'You can remove all of this by clearing this site’s data in your browser’s settings. It stays in your browser; apart from the random browser id, your name, the token and passwords you use to join, it isn’t sent anywhere.',
          ],
        },
      ],
    },
    {
      id: 'recording',
      title: 'Recording: what everyone sees and agrees to',
      blocks: [
        {
          kind: 'p',
          text: ['LongTalk only has local recording. This is how it works:'],
        },
        {
          kind: 'list',
          items: [
            ['Who can record: the host, and anyone the host allows. The room checks this on the server, not in the browser.'],
            ['What everyone sees: a red light in the top bar saying who is recording, a “recording” label in the participants list, and a notice when it stops.'],
            ['Explicit agreement: everyone except the recorder gets a question that blocks the whole meeting, “Agree and stay” or “Leave meeting”. Before joining a meeting that is being recorded, you must tick “I agree to this meeting being recorded”. The waiting room says so too. If someone else starts recording, you are asked again.'],
            [`The ${f.consentSeconds}-second rule: with no answer within ${f.consentSeconds} seconds of the recording starting or of you coming in, whichever is later, you have not agreed, and the room takes you out of the meeting. You are not blocked, and you can rejoin and agree.`],
            ['Before you agree: the recorder’s file leaves out your camera, your shared screen and your sound. This happens in the recorder’s browser.'],
            ['What is recorded: what the recorder’s screen shows of the meeting (their layout, so people not on screen are not in the picture) and the meeting’s sound, or the sound alone.'],
            ['The file: it is written to the recorder’s browser and downloaded to their device. It never reaches LongTalk’s servers. After download the recorder holds it: LongTalk can’t see, delete or control it, or limit who it is passed to. To have one deleted, ask the person who made it.'],
            ['The record of who agreed is kept only during the meeting and deleted with it, so LongTalk has no record of it afterwards.'],
            ['What LongTalk can’t see: screen recorders, a phone pointed at the screen or other software. Agreeing here covers LongTalk’s own recording only.'],
          ],
        },
      ],
    },
    {
      id: 'deletion',
      title: 'Deleting your data and asking questions',
      blocks: [
        {
          kind: 'p',
          text: [
            { text: 'On your account page', href: '/me' },
            `, a signed-in person can delete the account, which at once deletes its passkeys, signed-in browsers, personal rooms (with their whiteboards) and scheduled meetings, and ends any meeting in those rooms. Backups still hold a copy for up to ${f.backupDays} days (see “Backups”). You can also delete one personal room, scheduled meeting or passkey there. Delete the passkey on your own devices yourself; calendar events and .ics files other people saved are out of LongTalk’s reach.`,
          ],
        },
        {
          kind: 'p',
          text: [
            'Without an account, there is nothing that ties data to you: LongTalk keeps no email address or identity, so it can’t look up “your” data by your name. Meeting data, chat and files go by themselves as in the table above, and you can clear your browser’s own storage at any time.',
          ],
        },
        {
          kind: 'p',
          text: ['For anything else, or a question about this page, write here:'],
        },
        { kind: 'contact' },
      ],
    },
    {
      id: 'notices',
      title: 'Third-party software',
      blocks: [
        {
          kind: 'p',
          text: [
            'Licences of the third-party code your browser receives: ',
            { text: 'third-party notices', href: '/third-party-notices.txt' },
            '.',
          ],
        },
      ],
    },
    {
      id: 'changes',
      title: 'Changes to this page',
      blocks: [
        {
          kind: 'p',
          text: [
            'When LongTalk’s handling of data changes, this page changes with it, and the date at the top is updated. Earlier versions are in the public source’s history.',
          ],
        },
      ],
    },
  ],
})
