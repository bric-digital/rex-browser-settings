import { REXConfiguration } from '@bric/rex-core/extension'
import rexCorePlugin, { REXServiceWorkerModule, registerREXModule, dispatchEvent } from '@bric/rex-core/service-worker'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEARCH_ENGINE_MAP: Record<string, string> = {
  'google.com/search': 'google',
  'bing.com/search': 'bing',
  'duckduckgo.com/': 'duckduckgo',
  'search.yahoo.com/search': 'yahoo',
  'ecosia.org/search': 'ecosia',
  'search.brave.com/search': 'brave',
  'baidu.com/s': 'baidu',
  'yandex.com/search': 'yandex',
  'yandex.ru/search': 'yandex',
  'startpage.com/sp/search': 'startpage',
}

const STORAGE_KEY = 'rex-browser-settings-search-engine'
const ALARM_NAME = 'rex-browser-settings-recheck'
const PROACTIVE_DELAY_MS = 30000
const DEFAULT_RECHECK_HOURS = 24
const PDK_GENERATOR_ID = 'rex-browser-settings-search-engine'

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface DetectionResult {
  engine: string
  url: string
  detected_at: number
  detection_method: 'active' | 'passive'
  confident: boolean
  error?: string
}

interface BrowserSettingsConfig {
  enabled: boolean
  recheck_interval_hours?: number
  detection_timeout_ms?: number
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

class BrowserSettingsServiceWorkerModule extends REXServiceWorkerModule {
  config: BrowserSettingsConfig | null = null
  passiveListenerAdded = false
  navigationListener: ((details: { tabId: number; url: string; processId: number; frameId: number; transitionType: string; timeStamp: number }) => void) | null = null

  moduleName() {
    return 'BrowserSettingsModule'
  }

  setup() {
    this.refreshConfiguration()
  }

  refreshConfiguration() {
    rexCorePlugin.fetchConfiguration()
      .then((configuration: REXConfiguration) => {
        if (configuration !== undefined) {
          const browserSettingsConfig = configuration['browser_settings'] as BrowserSettingsConfig | undefined

          if (browserSettingsConfig !== undefined) {
            this.updateConfiguration(browserSettingsConfig)
            return
          }
        }

        setTimeout(() => {
          this.refreshConfiguration()
        }, 1000)
      })
  }
  fetchIdentifier(): Promise<string | null> {
    return chrome.runtime.sendMessage({ messageType: 'getIdentifier' })
      .then((identifier: string | null) => identifier || null)
  }

  updateConfiguration(config: BrowserSettingsConfig) {
    this.config = config

    if (!config.enabled) {
      return
    }

    this.setupPassiveDetection()
    this.setupAlarm()

    this.fetchIdentifier().then((identifier) => {
      if (!identifier) {
        console.log('[BrowserSettingsModule] No identifier set, deferring detection')
        this.listenForIdentifier()
        return
      }

      this.fetchStoredResult().then((result) => {
        if (!result) {
          setTimeout(() => {
            this.detectSearchEngineProactive()
          }, PROACTIVE_DELAY_MS)
        }
      })
    })
  }

  listenForIdentifier() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return
      if (!changes.rexIdentifier) return

      const newValue = changes.rexIdentifier.newValue
      if (!newValue) return

      console.log('[BrowserSettingsModule] Identifier now available, checking for stored result')
      this.fetchStoredResult().then((result) => {
        if (!result) {
          setTimeout(() => {
            this.detectSearchEngineProactive()
          }, PROACTIVE_DELAY_MS)
        }
      })
    })
  }

  setupPassiveDetection() {
    if (this.passiveListenerAdded) {
      return
    }

    this.navigationListener = (details: { tabId: number; url: string; processId: number; frameId: number; transitionType: string; timeStamp: number }) => {
      if (details.frameId !== 0) return
      if (details.transitionType !== 'generated') return

      const engine = this.identifySearchEngine(details.url)
      if (engine) {
        this.fetchIdentifier().then((identifier) => {
          if (!identifier) return

          const now = Date.now()
          const result: DetectionResult = {
            engine: engine,
            //possibly sensitive info
            'url*': details.url,
            detected_at: now,
            detection_method: 'passive',
            confident: true,
          }
          this.storeResult(result)
          this.reportToPDK(result)
        })
      }
    }

    chrome.webNavigation.onCommitted.addListener(this.navigationListener)
    this.passiveListenerAdded = true
  }

  setupAlarm() {
    const recheckHours = this.config?.recheck_interval_hours ?? DEFAULT_RECHECK_HOURS

    chrome.alarms.create(ALARM_NAME, { delayInMinutes: recheckHours * 60 })

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== ALARM_NAME) return

      this.fetchIdentifier().then((identifier) => {
        if (!identifier) return

        this.fetchStoredResult().then((result) => {
          const hours = this.config?.recheck_interval_hours ?? DEFAULT_RECHECK_HOURS
          const recheckMs = hours * 3600 * 1000
          const now = Date.now()

          if (result && result.detected_at > now - recheckMs && result.detection_method === 'passive') {
            // Recent passive detection exists, no active check needed
          } else {
            this.detectSearchEngineProactive()
          }

          // Re-schedule alarm
          chrome.alarms.create(ALARM_NAME, { delayInMinutes: hours * 60 })
        })
      })
    })
  }

  detectSearchEngineProactive(): Promise<DetectionResult> {
    const timeoutMs = this.config?.detection_timeout_ms ?? 10000

    return new Promise((resolve) => {
      chrome.windows.create({ state: 'minimized', url: 'about:blank' }, (win) => {
        if (!win || !win.tabs || win.tabs.length === 0) {
          const result: DetectionResult = {
            engine: 'unknown',
            url: '',
            detected_at: Date.now(),
            detection_method: 'active',
            confident: false,
            error: 'Failed to create detection window',
          }
          this.storeResult(result)
          this.reportToPDK(result)
          resolve(result)
          return
        }

        const tabId = win.tabs[0].id!
        const windowId = win.id!
        let resolved = false

        const onCommitted = (details: { tabId: number; url: string; frameId: number; transitionType: string }) => {
          if (details.tabId !== tabId || details.frameId !== 0) return

          const url = details.url
          if (url === 'about:blank' || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return

          console.log('[BrowserSettingsModule] Detection candidate URL:', url)

          if (resolved) return
          resolved = true

          chrome.webNavigation.onCommitted.removeListener(onCommitted)
          clearTimeout(timer)

          const engine = this.identifySearchEngine(url) || 'unknown'
          const now = Date.now()
          const result: DetectionResult = {
            engine,
            url,
            detected_at: now,
            detection_method: 'active',
            confident: engine !== 'unknown',
          }

          chrome.windows.remove(windowId, () => {
            this.storeResult(result)
            this.reportToPDK(result)
            resolve(result)
          })
        }

        chrome.webNavigation.onCommitted.addListener(onCommitted)

        chrome.search.query({ text: 'Ricardo Montalbán', tabId }, () => {
          // Search triggered — waiting for navigation via onCommitted
        })

        const timer = setTimeout(() => {
          if (resolved) return
          resolved = true

          chrome.webNavigation.onCommitted.removeListener(onCommitted)

          const now = Date.now()
          const result: DetectionResult = {
            engine: 'unknown',
            url: '',
            detected_at: now,
            detection_method: 'active',
            confident: false,
            error: 'Detection timed out',
          }

          chrome.windows.remove(windowId, () => {
            this.storeResult(result)
            this.reportToPDK(result)
            resolve(result)
          })
        }, timeoutMs)
      })
    })
  }

  identifySearchEngine(url: string): string | null {
    try {
      const parsed = new URL(url)
      const hostAndPath = parsed.hostname.replace(/^www\./, '') + parsed.pathname

      for (const [pattern, engine] of Object.entries(SEARCH_ENGINE_MAP)) {
        if (hostAndPath.startsWith(pattern)) {
          return engine
        }
      }
    } catch {
      // Invalid URL
    }
    return null
  }

  storeResult(result: DetectionResult) {
    chrome.storage.local.set({ [STORAGE_KEY]: result }).then(() => {
      console.log(`[BrowserSettingsModule] Stored search engine result: ${result.engine}`)
    })
  }

  fetchStoredResult(): Promise<DetectionResult | null> {
    return chrome.storage.local.get(STORAGE_KEY).then((data) => {
      return (data[STORAGE_KEY] as DetectionResult) || null
    })
  }

  reportToPDK(result: DetectionResult) {
    dispatchEvent({
      name: PDK_GENERATOR_ID,
      engine: result.engine,
      engine_url: result.url,
      confident: result.confident,
      detection_method: result.detection_method,
    })
  }

  handleMessage(message: any, sender: any, sendResponse: (response: any) => void): boolean { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (message.messageType === 'checkBrowserSettingsReady') {
      this.fetchStoredResult().then((result) => {
        if (result && result.confident) {
          sendResponse({ issues: [], ready: true })
        } else {
          sendResponse({
            issues: [{ message: 'Search engine detection pending', url: '' }],
            ready: false,
          })
        }
      })
      return true
    }

    if (message.messageType === 'detectSearchEngine') {
      this.detectSearchEngineProactive().then((result) => {
        sendResponse(result)
      })
      return true
    }

    if (message.messageType === 'getBrowserSettingsStatus') {
      this.fetchStoredResult().then((result) => {
        sendResponse(result)
      })
      return true
    }

    return false
  }
}

const plugin = new BrowserSettingsServiceWorkerModule()

registerREXModule(plugin)

export default plugin
