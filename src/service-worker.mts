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
  'url*'?: string
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
  navigationListener: Parameters<typeof chrome.webNavigation.onCommitted.addListener>[0] | null = null

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

    this.navigationListener = (details) => {
      if (details.frameId !== 0) return

      const engine = this.identifySearchEngine(details.url)
      if (!engine) return

      console.log(`[BrowserSettingsModule] Passive: detected ${engine} navigation (transitionType: ${details.transitionType})`)

      this.fetchIdentifier().then((identifier) => {
        if (!identifier) {
          console.log('[BrowserSettingsModule] Passive: no identifier, skipping')
          return
        }

        this.fetchStoredResult().then((stored) => {
          const now = Date.now()
          const engineChanged = stored?.engine !== engine
          const hoursSinceLast = stored ? (now - stored.detected_at) / 3600000 : Infinity
          const recheckHours = this.config?.recheck_interval_hours ?? DEFAULT_RECHECK_HOURS

          if (!engineChanged && hoursSinceLast < recheckHours) {
            console.log(`[BrowserSettingsModule] Passive: skipping report — same engine (${engine}), ${hoursSinceLast.toFixed(2)}h since last (threshold: ${recheckHours}h)`)
            return
          }

          const result: DetectionResult = {
            engine,
            //need to add url* due to privacy
            url: details.url, 
            detected_at: now,
            detection_method: 'passive',
            confident: true,
          }
          this.storeResult(result)
          this.reportToPDK(result)
        })
      })
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

        const windowId = win.id!
        let resolved = false

        const onCommitted: Parameters<typeof chrome.webNavigation.onCommitted.addListener>[0] = (details) => {
          if (details.frameId !== 0) return

          const url = details.url
          if (url === 'about:blank' || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return

          const engine = this.identifySearchEngine(url)
          if (!engine) return  // Not a search engine URL, ignore

          if (resolved) return
          resolved = true

          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chrome-types bug: removeListener signature mismatches addListener
          chrome.webNavigation.onCommitted.removeListener(onCommitted as any)
          clearTimeout(timer)

          const now = Date.now()
          const result: DetectionResult = {
            engine,
            url,
            detected_at: now,
            detection_method: 'active',
            confident: true,
          }

          chrome.tabs.remove(details.tabId).catch(() => { /* tab may already be closed */ })
          chrome.windows.remove(windowId, () => {
            this.storeResult(result)
            this.reportToPDK(result)
            resolve(result)
          })
        }

        chrome.webNavigation.onCommitted.addListener(onCommitted)

        // Use search.query with tabId to keep the search inside the minimized window
        chrome.search.query({ text: 'Ricardo Montalbán', tabId: win.tabs[0].id! }, () => {
          console.log('[BrowserSettingsModule] search.query dispatched, waiting for navigation...')
        })

        const timer = setTimeout(() => {
          if (resolved) return
          resolved = true

          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chrome-types bug: removeListener signature mismatches addListener
          chrome.webNavigation.onCommitted.removeListener(onCommitted as any)

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
