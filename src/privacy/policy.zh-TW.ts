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

// The privacy policy in Traditional Chinese. Every statement was checked against the code (I6,
// e11-t07); when a behaviour changes, change this and policy.en.ts in the same pull request.
// Numbers come from `f` (facts.ts), never typed in.

const STORAGE: StorageDescriptions = {
  'longtalk.name': '你上次加入時用的名字',
  'longtalk.client': '這個瀏覽器的亂數 id。每次加入都會帶上；主持人移出時，封鎖的就是它（有時間限制）',
  'longtalk.devices': '你選的麥克風、鏡頭、喇叭（裝置 id）',
  'longtalk.deviceLabels': '這些裝置的名稱，裝置 id 變了時用來找回',
  'longtalk.view': '你的版面與「隱藏自己」',
  'longtalk.prefs': '音效開關、隱藏表情反應',
  'longtalk.media': '麥克風處理、HD、進階噪音抑制、省電模式',
  'longtalk.account': '在這裡登入的帳號名稱，只讓首頁的連結知道該怎麼寫；登入靠的不是它',
  'longtalk.locale': '你選的語言',
  'longtalk.theme': '淺色或深色',
  'longtalk.installDismissed': '你關掉過安裝 App 的提示',
  'longtalk.recording.settings': '你上次選的錄影選項',
  'longtalk.recording.pending': '這個瀏覽器可能有一段沒完成的錄影',
  'longtalk.session.<room>': '你在那間會議室的成員 token，重新整理時回到同一個成員',
  'longtalk.password.<room>': '你輸入或設定的那間會議室密碼（明文），給「複製含密碼的連結」用',
  'longtalk:mainShare:<room>': '你選了誰的分享畫面（或白板）放在主區',
}

export const policy = (f: Facts): PolicyDocument => ({
  title: '隱私權政策',
  updated: (date) => `最後更新：${date}`,
  contentsTitle: '目錄',
  contactLink: '開啟 LongTalk 的聯絡頁面',
  contactPublicWarning:
    '那個頁面是公開的，寫在上面的內容任何人都看得到。請不要寫你的姓名、Email、電話或其他個人資料；要不要寫出是哪一間會議室或哪一場會議，也請想過它會被公開再決定。',
  sections: [
    {
      id: 'about',
      title: '這份文件是什麼',
      blocks: [
        {
          kind: 'p',
          text: [
            '這是一份白話的說明，照程式實際的行為寫下 LongTalk 怎麼運作、你的資料會怎樣。它不是法律意見，也不表示 LongTalk 符合任何特定的法律、標準或認證。下面說的「營運者」是指經營這個服務的人。',
          ],
        },
        {
          kind: 'p',
          text: [
            'LongTalk 的程式碼是公開的，你可以自己核對這裡寫的內容：',
            { text: 'GitHub 上的原始碼', href: SOURCE_URL },
            '。',
          ],
        },
        { kind: 'p', text: ['簡單說：'] },
        {
          kind: 'list',
          items: [
            ['不用帳號也能開會；帳號沒有 Email、密碼或電話。'],
            ['LongTalk 不儲存你的聲音與影像；本機錄影只存在錄影者自己的瀏覽器與裝置。'],
            ['聊天在會議關閉時刪除；聊天裡的檔案最多留一天。'],
            ['沒有廣告，也沒有第三方的追蹤或分析程式。'],
            ['整個服務跑在 Cloudflare 上，所以 Cloudflare 會經手你的資料，包括你的網路位址。'],
          ],
        },
      ],
    },
    {
      id: 'stored',
      title: '存了什麼、存在哪裡',
      blocks: [
        {
          kind: 'table',
          caption: 'LongTalk 在各個地方存的資料',
          columns: ['地方', '裡面有什麼'],
          rows: [
            {
              key: 'room',
              cells: [
                '會議室（Cloudflare Durable Object，每間一個）',
                `會議進行期間：房名；每位成員的顯示名稱、角色、成員 token、瀏覽器的亂數 id、麥克風、鏡頭與舉手狀態；最近 ${f.chatMessages} 則聊天；聊天檔案的檔名、大小、類型與哪位成員傳的；誰在錄影、誰同意了；分享畫面與白板上的標註（筆跡、文字與畫的人）；等候室裡的名字；被移出的瀏覽器 id。有設密碼的話還有密碼的加鹽雜湊；猜錯密碼時還有瀏覽器的亂數 id 與網路的摘要值。`,
              ],
            },
            {
              key: 'files',
              cells: [
                '聊天檔案（Cloudflare R2）',
                '大家在聊天裡傳的檔案（原樣保存），以及傳送者的瀏覽器替圖片做的小縮圖。',
              ],
            },
            {
              key: 'accounts',
              cells: [
                '帳號（Cloudflare D1）',
                '帳號、通行密鑰的公鑰、登入中的瀏覽器、固定會議室與預定會議。見「帳號」。',
              ],
            },
            {
              key: 'backups',
              cells: [
                '備份（Cloudflare R2，另一個 bucket）',
                '帳號、通行密鑰、固定會議室、預定會議這幾張表每天一份的副本。見「備份」。',
              ],
            },
            {
              key: 'guard',
              cells: [
                '濫用防護（全站一個 Durable Object）',
                '網路的雜湊值，以及它建立會議室或帳號、開始登入、儲存會議、上傳檔案的時間；最近碰到限制的網路；封鎖名單。見「濫用防護」。',
              ],
            },
            {
              key: 'telemetry',
              cells: [
                '遙測（全站一個 Durable Object）',
                '每小時與每天的事件計數，以及最近的錯誤文字。見「遙測」。',
              ],
            },
            {
              key: 'counts',
              cells: [
                '總量計數（全站兩個 Durable Object）',
                '這個月的影音流量、聊天檔案 bucket 的用量。只有總數，和特定的人無關。',
              ],
            },
            {
              key: 'media',
              cells: [
                '聲音與影像（Cloudflare Realtime SFU 與 TURN）',
                '只是經過，LongTalk 不儲存。見「聲音與影像」。',
              ],
            },
            {
              key: 'browser',
              cells: [
                '你自己的瀏覽器',
                '你的名字、設定；如果你錄影，還有錄影內容。見「Cookie 與瀏覽器儲存」。',
              ],
            },
          ],
        },
        {
          kind: 'p',
          text: [
            '會議裡的每個人都看得到其他成員的名字、狀態與聊天，也都能下載聊天檔案。等候室裡的名字會送到每位成員的瀏覽器，只是畫面上只顯示給主持人與共同主持人。',
          ],
        },
      ],
    },
    {
      id: 'media',
      title: '聲音與影像，以及從不儲存的東西',
      blocks: [
        {
          kind: 'list',
          items: [
            ['聲音、影像與螢幕分享從你的瀏覽器經過 Cloudflare 的 Realtime 媒體伺服器送給其他人；直接的路徑被擋時會經過 Cloudflare 的 TURN 轉送。傳輸途中有加密（WebRTC 的要求），但不是端對端加密：Cloudflare 的伺服器會經手媒體。'],
            ['LongTalk 沒有伺服器端錄影：沒有任何程式把聲音或影像存到伺服器。唯一的錄影是本機錄影，存在錄影者自己的瀏覽器（見「錄影」）。'],
            ['LongTalk 自己的儲存裡，網路位址只有雜湊值，沒有位址本身。Cloudflare 還是看得到你的位址，連線就是這樣運作的（見「還有誰會經手你的資料」）。'],
            ['會議室密碼只存加鹽的雜湊值。帶密碼的連結在第一次載入頁面時，密碼會出現在網址裡經過 Cloudflare，之後頁面會從網址列拿掉。'],
            ['遙測裡沒有名字、會議室網址、聊天內容或網路位址。'],
          ],
        },
      ],
    },
    {
      id: 'retention',
      title: '資料保留多久',
      blocks: [
        {
          kind: 'table',
          caption: '資料保留表',
          columns: ['資料', '在哪裡', '保留多久'],
          rows: [
            {
              key: 'media',
              cells: ['聲音與影像', 'LongTalk 不儲存', '不保留。'],
            },
            {
              key: 'meeting',
              cells: [
                '一場會議：成員、聊天、聊天檔案的檔名、錄影狀態與誰同意了',
                '會議室',
                `會議進行多久就留多久，沒有固定上限。主持人結束會議，或會議室空了 ${f.emptyRoomMinutes} 分鐘就刪除。斷線的人名單上再留 ${f.reconnectSeconds} 秒。`,
              ],
            },
            {
              key: 'annotations',
              cells: [
                '分享畫面與白板上的標註（筆跡、文字與畫的人；雷射筆不存）',
                '會議室',
                '分享畫面上的：那個人停止分享時就刪除。白板上的：關閉白板時留著，有人清除時或會議結束時刪除。分享畫面上的也有人能清除；會議結束時全部刪除。',
              ],
            },
            {
              key: 'waiting',
              cells: [
                '等候室裡的名字',
                '會議室',
                `到被放行、被拒絕或離開為止，最多 ${f.waitingMinutes} 分鐘。`,
              ],
            },
            {
              key: 'bans',
              cells: [
                '被移出或被拒絕的瀏覽器亂數 id',
                '會議室',
                `移出後 ${f.banMinutes} 分鐘；在等候室被拒絕後 ${f.denySeconds} 秒。`,
              ],
            },
            {
              key: 'guesses',
              cells: ['猜錯密碼的瀏覽器亂數 id 與網路的摘要值', '會議室', `${f.guessMinutes} 分鐘。`],
            },
            {
              key: 'files',
              cells: [
                '聊天檔案與縮圖',
                'R2',
                `從開始上傳算起最多 ${f.fileHours} 小時：之後就下載不到，每小時的排程在 ${f.fileHours} 到 ${f.fileGoneHours} 小時之間刪除。會議先關閉的話當場刪除。`,
              ],
            },
            {
              key: 'account',
              cells: ['帳號與通行密鑰', 'D1', '到你刪除為止。沒在用的帳號不會自動刪除。'],
            },
            {
              key: 'personalRoom',
              cells: [
                '固定會議室：網址、名稱、密碼雜湊、等候室與鎖定設定',
                'D1 與會議室',
                '到擁有者刪除那間房或帳號為止。會議資料照上面的規則清除。',
              ],
            },
            {
              key: 'session',
              cells: [
                '登入中的瀏覽器',
                'D1',
                `${f.sessionIdleDays} 天沒用就結束，登入後最長 ${f.sessionMaxDays} 天，或你登出時。過期的紀錄在下一次有人登入時移除。`,
              ],
            },
            {
              key: 'challenge',
              cells: [
                '登入用的 challenge（註冊時還有新帳號的名字）',
                'D1',
                `用掉就刪；沒用的 ${f.challengeMinutes} 分鐘後過期，下一次有人要登入時移除。`,
              ],
            },
            {
              key: 'meeting-scheduled',
              cells: [
                '預定會議',
                'D1',
                `到你刪除那場、那間房或帳號為止；否則會議結束後 ${f.meetingDays} 天。之後就看不到，下一次有人儲存預定會議時移除。`,
              ],
            },
            {
              key: 'backup',
              cells: ['每日備份', 'R2', `${f.backupDays} 天。`],
            },
            {
              key: 'telemetry',
              cells: [
                '遙測計數',
                'Durable Object',
                `每天的計數 ${f.telemetryDays} 天；每小時的計數 ${f.telemetryHours} 小時。`,
              ],
            },
            {
              key: 'errors',
              cells: [
                '瀏覽器回報的錯誤文字',
                'Durable Object',
                `最近 ${f.errorSamples} 種不同的錯誤。沒有時間上限：留到被較新的錯誤取代。`,
              ],
            },
            {
              key: 'network',
              cells: [
                '速率限制用的網路雜湊值',
                'Durable Object',
                `超過 ${f.networkCountHours} 小時的時間不再計算，並在那個網路下次有動作時丟掉；雜湊值本身不會自動移除。`,
              ],
            },
            {
              key: 'blocks',
              cells: [
                '被封鎖的網路與最近碰到限制的網路（雜湊值）',
                'Durable Object',
                `封鎖最長 ${f.blockMaxDays} 天。碰到限制的網路留最近 ${f.offenders} 個，沒有時間上限。`,
              ],
            },
            {
              key: 'logs',
              cells: ['Worker 記錄', 'Cloudflare', `依 Cloudflare 的說明，這個方案是 ${f.cloudflareLogDays} 天。`],
            },
            {
              key: 'recording',
              cells: [
                '錄影中的本機錄影',
                '錄影者的瀏覽器',
                `檔案下載後約 ${f.recordingKeepMinutes} 分鐘從瀏覽器刪除；分頁先關掉的話，下次打開時刪除。沒完成的留到錄影者下載或捨棄為止。`,
              ],
            },
            {
              key: 'recordingFile',
              cells: [
                '已下載的錄影檔',
                '錄影者的裝置',
                '錄影者留多久就多久。LongTalk 碰不到。',
              ],
            },
            {
              key: 'browserStorage',
              cells: [
                '瀏覽器裡的設定',
                '你的瀏覽器',
                'localStorage 到你清除為止；sessionStorage 到分頁關閉為止。',
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'chat-files',
      title: '聊天與檔案',
      blocks: [
        {
          kind: 'list',
          items: [
            ['聊天屬於那一場會議：下一場看不到，固定會議室也一樣；會議關閉後任何地方都沒有聊天紀錄。'],
            ['只有這間會議室的成員能下載它的檔案，而且只在期限內。檔名跟著聊天訊息留到會議關閉。'],
            ['檔案照原樣保存。照片可能帶有拍攝地點與相機資訊（EXIF），原檔會保留，縮圖沒有；介意的話請先移除。'],
            ['上傳時只檢查檔案類型，不看內容寫了什麼、拍了什麼；LongTalk 也沒有其他內容掃描。'],
            ['會議裡的人都可以複製看到的東西或下載檔案，那些副本 LongTalk 刪不到。'],
          ],
        },
      ],
    },
    {
      id: 'accounts',
      title: '帳號',
      blocks: [
        {
          kind: 'p',
          text: [
            '帳號是選用的，只用通行密鑰：沒有 Email、密碼或電話，所以通行密鑰全部遺失時也沒有辦法找回帳號。帳號裡有：',
          ],
        },
        {
          kind: 'list',
          items: [
            ['隨機 id、你的顯示名稱、建立時間。'],
            ['每把通行密鑰的 id 與公鑰（私鑰不會離開你的裝置或密碼管理工具）、演算法、簽章計數器、transports、驗證器型號的公開 id（AAGUID）、是否已同步、建立與上次使用時間。'],
            ['每個登入中的瀏覽器的隨機 id、token 的雜湊值、登入、上次使用與到期時間。不記網路位址或瀏覽器種類。'],
            ['你的固定會議室與預定會議：網址、標題、說明、開始時間、時長、時區。沒有與會者名單。'],
          ],
        },
        {
          kind: 'p',
          text: [
            '拿到預定會議連結的人，看得到標題、說明、時間、時區與擁有者的顯示名稱；開始前不久起也看得到會議室的網址。',
          ],
        },
      ],
    },
    {
      id: 'backups',
      title: '備份',
      blocks: [
        {
          kind: 'list',
          items: [
            [`每天把帳號、通行密鑰、固定會議室與預定會議這幾張表複製到另一個儲存空間，保留 ${f.backupDays} 天。登入中的瀏覽器與登入 challenge 不會複製；會議室裡的會議資料、聊天與檔案都不在備份裡。`],
            ['備份除了 Cloudflare 儲存本身提供的之外，沒有另外加密；透過營運者的 Cloudflare 帳號拿得到。'],
            [`刪除的帳號還會留在備份裡：刪除時不會去改舊備份，所以你的資料最多 ${f.backupDays} 天後才從備份消失。`],
            ['如果資料庫哪天必須從備份還原，那份備份之後才刪除的帳號會回來。營運者的還原步驟要求還原後立刻再刪一次。'],
            [`另外，Cloudflare 平台有自己的復原功能，LongTalk 的程式沒有使用：依 Cloudflare 的說明，營運者可以把帳號資料庫還原到最多 ${f.cloudflareD1RecoveryDays} 天前、把會議室的儲存還原到最多 ${f.cloudflareRoomRecoveryDays} 天前的狀態。所以刪掉的資料在 Cloudflare 的系統裡可能還會留這麼久。`],
          ],
        },
      ],
    },
    {
      id: 'telemetry',
      title: '遙測',
      blocks: [
        {
          kind: 'p',
          text: ['你的瀏覽器會把幾種事件回報給 LongTalk 自己的伺服器，讓營運者知道會議順不順：'],
        },
        {
          kind: 'list',
          items: [
            ['進房成功，或失敗與原因；重新連線；媒體連線重建；媒體是否經過轉送。'],
            ['離開後你可以給的 1–5 分：只有分數。'],
            ['頁面的錯誤與安全政策回報。文字會截短，網址、Email、長數字與會議室網址會先在你的瀏覽器、再在伺服器各去除一次。極少數情況下，錯誤文字裡仍可能留有訊息原本帶的其他內容。'],
          ],
        },
        {
          kind: 'p',
          text: [
            '事件不帶名字、會議室網址、聊天內容或帳號 id，而且只是加進計數。為了限制單一來源送的事件數量，伺服器會在記憶體裡用你網路位址的雜湊值，不會儲存。',
          ],
        },
        {
          kind: 'p',
          text: [
            `Cloudflare 也會保留 Worker 的記錄給營運者查看，依 Cloudflare 的說明，這個方案是 ${f.cloudflareLogDays} 天。記錄描述對 LongTalk 伺服器的每個請求，包括網址，而網址可能含有會議室網址。Cloudflare 的文件沒有列出所有欄位，所以請當作裡面也可能有你的網路位址。`,
          ],
        },
      ],
    },
    {
      id: 'abuse',
      title: '濫用防護',
      blocks: [
        {
          kind: 'list',
          items: [
            ['為了限制同一個網路建立會議室、登入或上傳的速度，LongTalk 會保留網路的雜湊值（IPv4 位址，或 IPv6 位址的前半段）與時間，不儲存位址本身。'],
            ['雜湊不等於匿名。拿得到儲存內容的人可以逐一嘗試、推回 IPv4 位址，除非伺服器設了一把秘密金鑰（這是選用的）。'],
            ['營運者可以暫時封鎖一個網路。封鎖名單與最近碰到限制的網路都是雜湊值，可能加上營運者寫的簡短備註。同一個網路後面的人都會受影響。'],
            ['營運者開啟 Cloudflare Turnstile 真人驗證的話，建立會議室或帳號時可能會要求驗證：你的瀏覽器會載入 Cloudflare 的程式，伺服器也會把你的網路位址送給 Cloudflare 檢查結果。'],
          ],
        },
      ],
    },
    {
      id: 'processors',
      title: '還有誰會經手你的資料',
      blocks: [
        {
          kind: 'p',
          text: [
            'LongTalk 整個跑在 Cloudflare 上：網站與伺服器（Workers）、會議室（Durable Objects）、帳號資料庫（D1）、檔案與備份（R2）、媒體（Realtime SFU、TURN 與 STUN）以及選用的真人驗證（Turnstile）。Cloudflare 看得到你的網路位址與它傳送的流量，並適用它自己的條款：',
            { text: 'Cloudflare 的隱私權政策', href: 'https://www.cloudflare.com/privacypolicy/' },
            '。',
          ],
        },
        {
          kind: 'p',
          text: ['這些資料沒有指定地區，由 Cloudflare 決定在哪裡處理與儲存，可能在你所在的國家以外。'],
        },
        {
          kind: 'p',
          text: [
            '其他服務只有在你自己選擇前往時才會拿到東西：「加入 Google 日曆」「加入 Outlook」在你打開時會把會議資訊帶給那個服務；聊天裡的連結通往它指向的地方；下面的聯絡連結通往 LongTalk 以外的服務。LongTalk 的頁面不會把任何東西送給其他服務，網站的安全政策也讓頁面除了上面的 Cloudflare 驗證之外，只能連到 LongTalk 自己的伺服器。沒有廣告，也沒有追蹤程式。',
          ],
        },
      ],
    },
    {
      id: 'browser',
      title: 'Cookie 與瀏覽器儲存',
      blocks: [
        {
          kind: 'p',
          text: [
            `LongTalk 只設一個 cookie：${COOKIE_NAME}，而且只在你登入帳號之後才有。裡面是一個隨機 token，只送回 LongTalk 的網站，程式讀不到。從上次使用起最多 ${f.sessionIdleDays} 天，登入後最長 ${f.sessionMaxDays} 天。沒有帳號的話，LongTalk 的程式不會設任何 cookie。Cloudflare 可能會為了安全設自己的 cookie（例如真人驗證時），那不在 LongTalk 的控制之內。`,
          ],
        },
        {
          kind: 'table',
          caption: 'LongTalk 存在你瀏覽器裡的東西',
          columns: ['名稱', '存在', '做什麼用'],
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
                '錄影中的本機錄影：影像與聲音、會議室網址與名稱、檔名',
              ],
            },
            {
              key: APP_CACHES,
              cells: [
                APP_CACHES,
                'Cache Storage',
                'App 自己的檔案，讓它開得快、離線也能開。沒有關於你的東西',
              ],
            },
          ],
        },
        {
          kind: 'p',
          text: [
            '在瀏覽器設定裡清除這個網站的資料，就能全部移除。這些都留在你的瀏覽器裡；除了加入時用到的瀏覽器亂數 id、名字、token 與密碼之外，不會送到任何地方。',
          ],
        },
      ],
    },
    {
      id: 'recording',
      title: '錄影：大家看到什麼、同意什麼',
      blocks: [
        {
          kind: 'p',
          text: ['LongTalk 只有本機錄影，流程如下：'],
        },
        {
          kind: 'list',
          items: [
            ['誰能錄：主持人，以及主持人允許的人。這由伺服器上的會議室判斷，不是瀏覽器。'],
            ['大家看到什麼：頂部條的紅燈寫著誰在錄影、參與者名單的「錄影中」標籤、停止時的提示。'],
            ['明確同意：錄影者以外的每個人都會看到擋住整個會議的問題，「同意並留在會議」或「離開會議」。要加入正在錄影的會議，先要勾「我同意這場會議被錄影」；等候畫面也會寫出來。換別人開始錄影時會再問一次。'],
            [`${f.consentSeconds} 秒規則：從錄影開始或你進來（取較晚的）算起 ${f.consentSeconds} 秒內沒有回答，就算不同意，會議室會讓你離開會議。這不是封鎖，你可以重新加入再同意。`],
            ['同意之前：錄影者的檔案裡不會有你的鏡頭、分享畫面與聲音。這是在錄影者的瀏覽器裡做到的。'],
            ['錄到什麼：錄影者畫面上看到的會議（照他的版面，畫面上沒有的人就不會入鏡）與會議的聲音，或只錄聲音。'],
            ['檔案：寫在錄影者的瀏覽器，再下載到他的裝置，從不送到 LongTalk 的伺服器。下載後檔案在錄影者手上：LongTalk 看不到、刪不到、也管不了，更不能限制他傳給誰。要刪除的話，請找錄影的人。'],
            ['誰同意了的紀錄只在會議期間保留，隨會議一起刪除，所以之後 LongTalk 沒有這份紀錄。'],
            ['LongTalk 看不到的：螢幕錄影軟體、拿手機對著螢幕拍或其他軟體。這裡的同意只涵蓋 LongTalk 自己的錄影。'],
          ],
        },
      ],
    },
    {
      id: 'deletion',
      title: '刪除資料與提問',
      blocks: [
        {
          kind: 'p',
          text: [
            { text: '在你的帳號頁面', href: '/me' },
            `，登入的人可以刪除帳號：通行密鑰、登入中的瀏覽器、固定會議室與預定會議會一起立刻刪除，那些會議室裡進行中的會議也會結束。備份裡還會留最多 ${f.backupDays} 天（見「備份」）。你也可以在那裡只刪一間固定會議室、一場預定會議或一把通行密鑰。裝置裡的通行密鑰要自己刪；別人存下的日曆活動與 .ics 檔 LongTalk 碰不到。`,
          ],
        },
        {
          kind: 'p',
          text: [
            '沒有帳號的話，沒有任何東西把資料和你連起來：LongTalk 沒有 Email 或身分資料，所以沒辦法用你的名字查出「你的」資料。會議資料、聊天與檔案會照上面的表自己消失，你也隨時可以清除瀏覽器裡的儲存。',
          ],
        },
        {
          kind: 'p',
          text: ['其他要求，或對這份文件的問題，請到這裡：'],
        },
        { kind: 'contact' },
      ],
    },
    {
      id: 'notices',
      title: '第三方軟體',
      blocks: [
        {
          kind: 'p',
          text: [
            '你的瀏覽器收到的第三方程式碼的授權：',
            { text: '第三方授權聲明', href: '/third-party-notices.txt' },
            '。',
          ],
        },
      ],
    },
    {
      id: 'changes',
      title: '這份文件的變更',
      blocks: [
        {
          kind: 'p',
          text: ['LongTalk 處理資料的方式改變時，這份文件會一起改，最上面的日期也會更新。以前的版本在公開原始碼的歷史裡。'],
        },
      ],
    },
  ],
})
