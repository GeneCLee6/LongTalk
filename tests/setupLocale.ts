// Runs before anything imports src/strings.ts (G1, e4-t15): jsdom's browser says en-US, which
// would start the app in English; the tests read Chinese, the default locale
Object.defineProperty(navigator, 'languages', { value: ['zh-TW', 'en-AU'], configurable: true })
Object.defineProperty(navigator, 'language', { value: 'zh-TW', configurable: true })
