import { enRoom } from '../src/i18n/en.ts'
import { zhTWRoom } from '../src/i18n/zh-TW.ts'
import { installDictionaries } from '../src/strings.ts'

// Every test reads any key and switches language synchronously: both dictionaries are whole from
// the start. How they arrive in a browser is tests/app/dictionarySplit.test.ts's business (J4).
installDictionaries({ 'zh-TW': zhTWRoom, en: enRoom })
