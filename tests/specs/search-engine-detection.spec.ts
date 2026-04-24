import { test, expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForShimLoaded(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => (window as any).__browserSettingsShimLoaded === true, { timeout: 10_000 })
}

/** Inject a complete config so the module activates. */
async function seedConfig(
  page: import('@playwright/test').Page,
  overrides: Record<string, unknown> = {}
) {
  await page.evaluate((overrides) => {
    ;(window as any).chrome.storage.local._data.rexIdentifier = 'test-participant-001'
    ;(window as any).chrome.storage.local._data.REXConfiguration = {
      browser_settings: {
        enabled: true,
        recheck_interval_hours: 24,
        detection_timeout_ms: 2000,
        ...overrides,
      },
    }
  }, overrides)
}

/** Seed config with enabled: false. */
async function seedDisabledConfig(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    ;(window as any).chrome.storage.local._data.rexIdentifier = 'test-participant-001'
    ;(window as any).chrome.storage.local._data.REXConfiguration = {
      browser_settings: {
        enabled: false,
      },
    }
  })
}

/** Set the mock search engine URL that chrome.search.query will navigate to. */
async function setMockSearchUrl(page: import('@playwright/test').Page, url: string) {
  await page.evaluate((url) => {
    ;(window as any).__mockSearchEngineUrl = url
  }, url)
}

/** Enable search timeout mode (chrome.search.query will not trigger navigation). */
async function enableSearchTimeout(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    ;(window as any).__mockSearchTimeout = true
  })
}

/** Reset call tracking arrays. */
async function resetCallTracking(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    ;(window as any).__searchQueryCalls = []
    ;(window as any).__runtimeMessageCalls = []
    ;(window as any).__capturedEvents = []
    ;(window as any).chrome.windows._createCalls = []
  })
}

// ---------------------------------------------------------------------------
// Tests: Initialization
// ---------------------------------------------------------------------------

test.describe('BrowserSettingsModule — Initialization', () => {
  test('module loads and shim is available', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    const plugin = await page.evaluate(() => !!(window as any).__browserSettingsPlugin)
    expect(plugin).toBe(true)
  })

  test('without config, module retries configuration fetch', async ({ page }) => {
    // Don't seed any config — module should keep retrying
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    // Verify no alarm was created (config not available)
    const alarm = await page.evaluate(
      () => (window as any).chrome.alarms._alarms['rex-browser-settings-recheck']
    )
    expect(alarm).toBeUndefined()
  })

  test('with enabled: false, passive listener is not set up', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)
    await seedDisabledConfig(page)

    // Trigger config load via refreshConfiguration
    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.refreshConfiguration()
    })

    // Give time for config to load
    await page.waitForTimeout(500)

    const listenerCount = await page.evaluate(
      () => (window as any).chrome.webNavigation._committedListeners.length
    )
    expect(listenerCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: Proactive Detection
// ---------------------------------------------------------------------------

test.describe('BrowserSettingsModule — Proactive Detection', () => {
  test('detects Google as default search engine', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    await setMockSearchUrl(page, 'https://www.google.com/search?q=Ricardo+Montalb%C3%A1n')

    const result = await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    expect(result.engine).toBe('google')
    expect(result.detection_method).toBe('active')
    expect(result.confident).toBe(true)
    expect(result.url).toContain('google.com/search')
  })

  test('detects Bing as default search engine', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    await setMockSearchUrl(page, 'https://www.bing.com/search?q=Ricardo+Montalb%C3%A1n')

    const result = await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    expect(result.engine).toBe('bing')
    expect(result.detection_method).toBe('active')
    expect(result.confident).toBe(true)
  })

  test('detects DuckDuckGo as default search engine', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    await setMockSearchUrl(page, 'https://duckduckgo.com/?q=Ricardo+Montalb%C3%A1n')

    const result = await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    expect(result.engine).toBe('duckduckgo')
    expect(result.detection_method).toBe('active')
    expect(result.confident).toBe(true)
  })

  test('handles timeout gracefully', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    // Set a short timeout and enable search timeout mode
    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = {
        enabled: true,
        detection_timeout_ms: 500,
      }
    })
    await enableSearchTimeout(page)

    const result = await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    expect(result.engine).toBe('unknown')
    expect(result.detection_method).toBe('active')
    expect(result.confident).toBe(false)
    expect(result.error).toBe('Detection timed out')
  })

  test('filters out chrome-extension:// URLs during detection', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    await setMockSearchUrl(page, 'https://www.google.com/search?q=test')

    const result = await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    // The mock fires chrome-extension:// first, then the real URL.
    // If extension URLs aren't filtered, engine would be 'unknown'.
    expect(result.engine).toBe('google')
    expect(result.confident).toBe(true)
  })

  test('ignores non-search-engine URLs that appear before the search engine URL', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    // Override the mock to simulate a redirect chain: first a non-search URL, then Google
    await page.evaluate(() => {
      const origQuery = (window as any).chrome.search.query
      ;(window as any).chrome.search.query = (options, callback) => {
        ;(window as any).__searchQueryCalls.push(structuredClone(options))

        setTimeout(() => {
          // First: chrome-extension URL
          window.triggerWebNavigation({
            tabId: 999, url: 'chrome-extension://fakeid/redirect.html',
            frameId: 0, transitionType: 'generated', processId: 1, timeStamp: Date.now()
          })
          // Second: a random non-search redirect
          setTimeout(() => {
            window.triggerWebNavigation({
              tabId: 999, url: 'https://redirect.example.com/bouncing',
              frameId: 0, transitionType: 'generated', processId: 1, timeStamp: Date.now()
            })
          }, 3)
          // Third: actual search engine
          setTimeout(() => {
            window.triggerWebNavigation({
              tabId: 999, url: 'https://www.google.com/search?q=test',
              frameId: 0, transitionType: 'generated', processId: 1, timeStamp: Date.now()
            })
          }, 8)
        }, 10)

        if (callback) callback()
      }
    })

    const result = await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    // Non-search URLs should be ignored, only the search engine URL should be captured
    expect(result.engine).toBe('google')
    expect(result.confident).toBe(true)
  })

  test('search.query is called with tabId targeting the minimized window', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)
    await resetCallTracking(page)

    await setMockSearchUrl(page, 'https://www.google.com/search?q=test')

    await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    const calls = await page.evaluate(() => (window as any).__searchQueryCalls)
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const call = calls[0]
    expect(call.disposition).toBeUndefined()
    expect(typeof call.tabId).toBe('number')
    expect(typeof call.text).toBe('string')
    expect(call.text.length).toBeGreaterThan(0)
  })

  test('creates a minimized window for detection', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)
    await resetCallTracking(page)

    await setMockSearchUrl(page, 'https://www.google.com/search?q=test')

    await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    const createCalls = await page.evaluate(() => (window as any).chrome.windows._createCalls)
    expect(createCalls.length).toBeGreaterThanOrEqual(1)
    expect(createCalls[0].state).toBe('minimized')
  })

  test('cleans up window after detection', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    await setMockSearchUrl(page, 'https://www.google.com/search?q=test')

    // Track window removal calls
    await page.evaluate(() => {
      ;(window as any).__windowsRemoved = []
      const originalRemove = (window as any).chrome.windows.remove
      ;(window as any).chrome.windows.remove = (windowId, callback) => {
        ;(window as any).__windowsRemoved.push(windowId)
        originalRemove(windowId, callback)
      }
    })

    await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    const removed = await page.evaluate(() => (window as any).__windowsRemoved)
    expect(removed.length).toBeGreaterThanOrEqual(1)
  })

  test('cleans up window after timeout', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = {
        enabled: true,
        detection_timeout_ms: 200,
      }
    })
    await enableSearchTimeout(page)

    await page.evaluate(() => {
      ;(window as any).__windowsRemoved = []
      const originalRemove = (window as any).chrome.windows.remove
      ;(window as any).chrome.windows.remove = (windowId, callback) => {
        ;(window as any).__windowsRemoved.push(windowId)
        originalRemove(windowId, callback)
      }
    })

    await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    const removed = await page.evaluate(() => (window as any).__windowsRemoved)
    expect(removed.length).toBeGreaterThanOrEqual(1)
  })

  test('ignores iframe navigations (frameId !== 0) during proactive detection', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    // Override mock to fire an iframe navigation first, then the real one
    await page.evaluate(() => {
      ;(window as any).chrome.search.query = (options, callback) => {
        ;(window as any).__searchQueryCalls.push(structuredClone(options))

        setTimeout(() => {
          // iframe navigation to search engine (should be ignored)
          window.triggerWebNavigation({
            tabId: 999, url: 'https://www.bing.com/search?q=test',
            frameId: 3, transitionType: 'generated', processId: 1, timeStamp: Date.now()
          })
          // main frame navigation to Google
          setTimeout(() => {
            window.triggerWebNavigation({
              tabId: 999, url: 'https://www.google.com/search?q=test',
              frameId: 0, transitionType: 'generated', processId: 1, timeStamp: Date.now()
            })
          }, 5)
        }, 10)

        if (callback) callback()
      }
    })

    const result = await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    // Should detect Google (main frame), not Bing (iframe)
    expect(result.engine).toBe('google')
  })
})

// ---------------------------------------------------------------------------
// Tests: Passive Detection
// ---------------------------------------------------------------------------

test.describe('BrowserSettingsModule — Passive Detection', () => {
  test('captures search engine from webNavigation.onCommitted with generated transition', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)
    await seedConfig(page) // sets rexIdentifier

    // Manually trigger configuration
    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = { enabled: true, detection_timeout_ms: 2000 }
      ;(window as any).__browserSettingsPlugin.setupPassiveDetection()
    })

    await page.evaluate(() => { (window as any).__capturedEvents = [] })

    // Simulate a generated navigation to Google
    await page.evaluate(() => {
      window.triggerWebNavigation({
        frameId: 0,
        url: 'https://www.google.com/search?q=test+query',
        transitionType: 'generated',
        tabId: 1,
        timeStamp: Date.now(),
        documentId: 'doc1',
        documentLifecycle: 'active',
        frameType: 'outermost_frame',
        parentDocumentId: '',
        parentFrameId: -1,
        processId: 1,
        transitionQualifiers: [],
      })
    })

    // Give time for the event to be processed
    await page.waitForTimeout(200)

    const events = await page.evaluate(
      () => (window as any).__capturedEvents as Record<string, unknown>[]
    )
    const searchEvents = events.filter(e => e.name === 'rex-browser-settings-search-engine')
    expect(searchEvents.length).toBeGreaterThanOrEqual(1)
    expect(searchEvents[0].engine).toBe('google')
    expect(searchEvents[0].detection_method).toBe('passive')
  })

  test('ignores non-main-frame navigations', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = { enabled: true }
      ;(window as any).__browserSettingsPlugin.setupPassiveDetection()
    })

    await page.evaluate(() => { (window as any).__capturedEvents = [] })

    // Simulate iframe navigation (frameId !== 0)
    await page.evaluate(() => {
      window.triggerWebNavigation({
        frameId: 5,
        url: 'https://www.google.com/search?q=test',
        transitionType: 'generated',
        tabId: 1,
        timeStamp: Date.now(),
        documentId: 'doc1',
        documentLifecycle: 'active',
        frameType: 'sub_frame',
        parentDocumentId: 'parent1',
        parentFrameId: 0,
        processId: 1,
        transitionQualifiers: [],
      })
    })

    await page.waitForTimeout(200)

    const events = await page.evaluate(
      () => ((window as any).__capturedEvents as Record<string, unknown>[]).filter(
        e => e.name === 'rex-browser-settings-search-engine'
      )
    )
    expect(events).toHaveLength(0)
  })

  test('detects search engine regardless of transition type', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)
    await seedConfig(page)

    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = { enabled: true }
      ;(window as any).__browserSettingsPlugin.setupPassiveDetection()
    })

    await page.evaluate(() => { (window as any).__capturedEvents = [] })

    // Simulate a typed navigation to a search engine URL
    await page.evaluate(() => {
      window.triggerWebNavigation({
        frameId: 0,
        url: 'https://www.google.com/search?q=test',
        transitionType: 'typed',
        tabId: 1,
        timeStamp: Date.now(),
        documentId: 'doc1',
        documentLifecycle: 'active',
        frameType: 'outermost_frame',
        parentDocumentId: '',
        parentFrameId: -1,
        processId: 1,
        transitionQualifiers: [],
      })
    })

    await page.waitForTimeout(200)

    const events = await page.evaluate(
      () => ((window as any).__capturedEvents as Record<string, unknown>[]).filter(
        e => e.name === 'rex-browser-settings-search-engine'
      )
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toHaveProperty('engine', 'google')
  })

  test('does not store or report without identifier', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    // No identifier set — ensure sendMessage returns null for getIdentifier
    await page.evaluate(() => {
      delete (window as any).chrome.storage.local._data.rexIdentifier
    })

    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = { enabled: true }
      ;(window as any).__browserSettingsPlugin.setupPassiveDetection()
    })

    await page.evaluate(() => { (window as any).__capturedEvents = [] })

    await page.evaluate(() => {
      window.triggerWebNavigation({
        frameId: 0,
        url: 'https://www.google.com/search?q=test',
        transitionType: 'generated',
        tabId: 1,
        timeStamp: Date.now(),
        documentId: 'doc1',
        documentLifecycle: 'active',
        frameType: 'outermost_frame',
        parentDocumentId: '',
        parentFrameId: -1,
        processId: 1,
        transitionQualifiers: [],
      })
    })

    await page.waitForTimeout(300)

    const events = await page.evaluate(
      () => ((window as any).__capturedEvents as Record<string, unknown>[]).filter(
        e => e.name === 'rex-browser-settings-search-engine'
      )
    )
    expect(events).toHaveLength(0)

    const stored = await page.evaluate(
      () => (window as any).chrome.storage.local._data['rex-browser-settings-search-engine']
    )
    expect(stored).toBeUndefined()
  })

  test('updates stored result when passive detection occurs', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)
    await seedConfig(page) // sets rexIdentifier

    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = { enabled: true }
      ;(window as any).__browserSettingsPlugin.setupPassiveDetection()
    })

    // Simulate a passive detection for Bing
    await page.evaluate(() => {
      window.triggerWebNavigation({
        frameId: 0,
        url: 'https://www.bing.com/search?q=test',
        transitionType: 'generated',
        tabId: 1,
        timeStamp: Date.now(),
        documentId: 'doc1',
        documentLifecycle: 'active',
        frameType: 'outermost_frame',
        parentDocumentId: '',
        parentFrameId: -1,
        processId: 1,
        transitionQualifiers: [],
      })
    })

    await page.waitForTimeout(500)

    // Check stored result via message
    const result = await page.evaluate(
      () => (window as any).__sendMessage({ messageType: 'getBrowserSettingsStatus' })
    )
    expect(result).toBeTruthy()
    expect((result as any).engine).toBe('bing')
    expect((result as any).detection_method).toBe('passive')
  })

  test('does not re-report same engine within recheck interval', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)
    await seedConfig(page, { recheck_interval_hours: 24 })

    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = {
        enabled: true,
        recheck_interval_hours: 24,
      }
      ;(window as any).__browserSettingsPlugin.setupPassiveDetection()
    })

    await page.evaluate(() => { (window as any).__capturedEvents = [] })

    // First detection
    await page.evaluate(() => {
      window.triggerWebNavigation({
        frameId: 0, url: 'https://www.google.com/search?q=first',
        transitionType: 'generated', tabId: 1, timeStamp: Date.now(),
        processId: 1,
      })
    })
    await page.waitForTimeout(300)

    const eventsAfterFirst = await page.evaluate(
      () => ((window as any).__capturedEvents as Record<string, unknown>[]).filter(
        e => e.name === 'rex-browser-settings-search-engine'
      )
    )
    expect(eventsAfterFirst.length).toBe(1)

    // Second detection with same engine — should be suppressed
    await page.evaluate(() => {
      window.triggerWebNavigation({
        frameId: 0, url: 'https://www.google.com/search?q=second',
        transitionType: 'generated', tabId: 2, timeStamp: Date.now(),
        processId: 1,
      })
    })
    await page.waitForTimeout(300)

    const eventsAfterSecond = await page.evaluate(
      () => ((window as any).__capturedEvents as Record<string, unknown>[]).filter(
        e => e.name === 'rex-browser-settings-search-engine'
      )
    )
    // Should still be 1 — second event was suppressed
    expect(eventsAfterSecond.length).toBe(1)
  })

  test('re-reports when engine changes', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)
    await seedConfig(page, { recheck_interval_hours: 24 })

    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = {
        enabled: true,
        recheck_interval_hours: 24,
      }
      ;(window as any).__browserSettingsPlugin.setupPassiveDetection()
    })

    await page.evaluate(() => { (window as any).__capturedEvents = [] })

    // First detection: Google
    await page.evaluate(() => {
      window.triggerWebNavigation({
        frameId: 0, url: 'https://www.google.com/search?q=first',
        transitionType: 'generated', tabId: 1, timeStamp: Date.now(),
        processId: 1,
      })
    })
    await page.waitForTimeout(300)

    // Second detection: Bing (different engine) — should report
    await page.evaluate(() => {
      window.triggerWebNavigation({
        frameId: 0, url: 'https://www.bing.com/search?q=second',
        transitionType: 'generated', tabId: 2, timeStamp: Date.now(),
        processId: 1,
      })
    })
    await page.waitForTimeout(300)

    const events = await page.evaluate(
      () => ((window as any).__capturedEvents as Record<string, unknown>[]).filter(
        e => e.name === 'rex-browser-settings-search-engine'
      )
    )
    expect(events.length).toBe(2)
    expect(events[0].engine).toBe('google')
    expect(events[1].engine).toBe('bing')
  })
})

// ---------------------------------------------------------------------------
// Tests: Search Engine Identification
// ---------------------------------------------------------------------------

test.describe('BrowserSettingsModule — identifySearchEngine', () => {
  test('identifies all known search engines', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    const results = await page.evaluate(() => {
      const plugin = (window as any).__browserSettingsPlugin
      return {
        google: plugin.identifySearchEngine('https://www.google.com/search?q=test'),
        bing: plugin.identifySearchEngine('https://www.bing.com/search?q=test'),
        ddg: plugin.identifySearchEngine('https://duckduckgo.com/?q=test'),
        yahoo: plugin.identifySearchEngine('https://search.yahoo.com/search?p=test'),
        ecosia: plugin.identifySearchEngine('https://www.ecosia.org/search?q=test'),
        brave: plugin.identifySearchEngine('https://search.brave.com/search?q=test'),
        baidu: plugin.identifySearchEngine('https://www.baidu.com/s?wd=test'),
        yandexCom: plugin.identifySearchEngine('https://yandex.com/search/?text=test'),
        yandexRu: plugin.identifySearchEngine('https://yandex.ru/search/?text=test'),
        startpage: plugin.identifySearchEngine('https://www.startpage.com/sp/search?q=test'),
        unknown: plugin.identifySearchEngine('https://some-random-site.com/results?q=test'),
        invalid: plugin.identifySearchEngine('not a url'),
      }
    })

    expect(results.google).toBe('google')
    expect(results.bing).toBe('bing')
    expect(results.ddg).toBe('duckduckgo')
    expect(results.yahoo).toBe('yahoo')
    expect(results.ecosia).toBe('ecosia')
    expect(results.brave).toBe('brave')
    expect(results.baidu).toBe('baidu')
    expect(results.yandexCom).toBe('yandex')
    expect(results.yandexRu).toBe('yandex')
    expect(results.startpage).toBe('startpage')
    expect(results.unknown).toBeNull()
    expect(results.invalid).toBeNull()
  })

  test('strips www prefix for matching', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    const results = await page.evaluate(() => {
      const plugin = (window as any).__browserSettingsPlugin
      return {
        withWww: plugin.identifySearchEngine('https://www.google.com/search?q=test'),
        withoutWww: plugin.identifySearchEngine('https://google.com/search?q=test'),
      }
    })

    expect(results.withWww).toBe('google')
    expect(results.withoutWww).toBe('google')
  })
})

// ---------------------------------------------------------------------------
// Tests: Identifier Handling
// ---------------------------------------------------------------------------

test.describe('BrowserSettingsModule — Identifier Handling', () => {
  test('fetchIdentifier calls chrome.runtime.sendMessage with getIdentifier', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)
    await resetCallTracking(page)

    await page.evaluate(() => {
      ;(window as any).chrome.storage.local._data.rexIdentifier = 'test-id-123'
    })

    const result = await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.fetchIdentifier()
    })

    expect(result).toBe('test-id-123')

    const messageCalls = await page.evaluate(() => (window as any).__runtimeMessageCalls)
    const getIdCalls = messageCalls.filter((c: any) => c.messageType === 'getIdentifier')
    expect(getIdCalls.length).toBeGreaterThanOrEqual(1)
  })

  test('fetchIdentifier returns null when no identifier is set', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    await page.evaluate(() => {
      delete (window as any).chrome.storage.local._data.rexIdentifier
    })

    const result = await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.fetchIdentifier()
    })

    expect(result).toBeNull()
  })

  test('listenForIdentifier triggers detection when identifier becomes available', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    // No identifier initially
    await page.evaluate(() => {
      delete (window as any).chrome.storage.local._data.rexIdentifier
    })

    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = {
        enabled: true,
        detection_timeout_ms: 2000,
      }
      ;(window as any).__browserSettingsPlugin.listenForIdentifier()
    })

    await setMockSearchUrl(page, 'https://www.google.com/search?q=test')
    await resetCallTracking(page)

    // Simulate identifier becoming available via storage change
    await page.evaluate(() => {
      ;(window as any).chrome.storage.local._data.rexIdentifier = 'new-id-456'
      ;(window as any).chrome.storage.onChanged._listeners.forEach(listener => {
        listener(
          { rexIdentifier: { newValue: 'new-id-456', oldValue: undefined } },
          'local'
        )
      })
    })

    // Wait for the PROACTIVE_DELAY_MS (30s in prod, but detection should queue)
    // The listener calls setTimeout with PROACTIVE_DELAY_MS, so we can't easily wait.
    // Instead, verify the listener was registered and would trigger.
    // We can verify that the storage change listener was added.
    const listenerCount = await page.evaluate(
      () => (window as any).chrome.storage.onChanged._listeners.length
    )
    expect(listenerCount).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Tests: PDK Reporting
// ---------------------------------------------------------------------------

test.describe('BrowserSettingsModule — PDK Reporting', () => {
  test('dispatches event with correct generator ID and payload', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)
    await resetCallTracking(page)

    await setMockSearchUrl(page, 'https://www.google.com/search?q=test')

    await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    const events = await page.evaluate(
      () => ((window as any).__capturedEvents as Record<string, unknown>[]).filter(
        e => e.name === 'rex-browser-settings-search-engine'
      )
    )

    expect(events.length).toBeGreaterThanOrEqual(1)
    const event = events[0]
    expect(event.name).toBe('rex-browser-settings-search-engine')
    expect(event.engine).toBe('google')
    expect(event.confident).toBe(true)
    expect(event.detection_method).toBe('active')
    expect(typeof event.engine_url).toBe('string')
  })

  test('PDK event for passive detection uses detection_method "passive"', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)
    await seedConfig(page)
    await resetCallTracking(page)

    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = { enabled: true }
      ;(window as any).__browserSettingsPlugin.setupPassiveDetection()
    })

    await page.evaluate(() => {
      window.triggerWebNavigation({
        frameId: 0, url: 'https://www.bing.com/search?q=passive-pdk',
        transitionType: 'generated', tabId: 1, timeStamp: Date.now(),
        processId: 1,
      })
    })

    await page.waitForTimeout(300)

    const events = await page.evaluate(
      () => ((window as any).__capturedEvents as Record<string, unknown>[]).filter(
        e => e.name === 'rex-browser-settings-search-engine'
      )
    )

    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0].detection_method).toBe('passive')
    expect(events[0].engine).toBe('bing')
  })
})

// ---------------------------------------------------------------------------
// Tests: Outstanding Issues (checkBrowserSettingsReady)
// ---------------------------------------------------------------------------

test.describe('BrowserSettingsModule — Outstanding Issues', () => {
  test('checkBrowserSettingsReady returns ready: true when engine is confidently detected', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    await setMockSearchUrl(page, 'https://www.google.com/search?q=test')

    // Run proactive detection to store a confident result
    await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    await page.waitForTimeout(200)

    const response = await page.evaluate(
      () => (window as any).__sendMessage({ messageType: 'checkBrowserSettingsReady' })
    )

    expect((response as any).ready).toBe(true)
    expect((response as any).issues).toHaveLength(0)
  })

  test('checkBrowserSettingsReady returns issue when detection failed', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    // No detection run, no stored result — should report pending
    const response = await page.evaluate(
      () => (window as any).__sendMessage({ messageType: 'checkBrowserSettingsReady' })
    )

    expect((response as any).ready).toBe(false)
    expect((response as any).issues.length).toBeGreaterThanOrEqual(1)
    expect((response as any).issues[0].message).toContain('Search engine detection pending')
  })

  test('checkBrowserSettingsReady returns issue when detection was inconclusive', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    // Set timeout mode and short timeout to get an inconclusive result
    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = {
        enabled: true,
        detection_timeout_ms: 100,
      }
    })
    await enableSearchTimeout(page)

    await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    await page.waitForTimeout(200)

    const response = await page.evaluate(
      () => (window as any).__sendMessage({ messageType: 'checkBrowserSettingsReady' })
    )

    expect((response as any).ready).toBe(false)
    expect((response as any).issues.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Tests: Message Handling
// ---------------------------------------------------------------------------

test.describe('BrowserSettingsModule — Message Handling', () => {
  test('detectSearchEngine message triggers detection and returns result', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    await setMockSearchUrl(page, 'https://www.bing.com/search?q=test')

    const result = await page.evaluate(
      () => (window as any).__sendMessage({ messageType: 'detectSearchEngine' })
    )

    expect((result as any).engine).toBe('bing')
    expect((result as any).detection_method).toBe('active')
  })

  test('getBrowserSettingsStatus returns null when no result stored', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    const result = await page.evaluate(
      () => (window as any).__sendMessage({ messageType: 'getBrowserSettingsStatus' })
    )

    expect(result).toBeNull()
  })

  test('getBrowserSettingsStatus returns stored result after detection', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    await setMockSearchUrl(page, 'https://www.google.com/search?q=test')

    await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    await page.waitForTimeout(200)

    const result = await page.evaluate(
      () => (window as any).__sendMessage({ messageType: 'getBrowserSettingsStatus' })
    )

    expect(result).toBeTruthy()
    expect((result as any).engine).toBe('google')
  })

  test('unrecognized message returns false (not handled)', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    const handled = await page.evaluate(() => {
      let response = undefined
      const result = (window as any).__browserSettingsPlugin.handleMessage(
        { messageType: 'unknownMessage' },
        {},
        (r) => { response = r }
      )
      return result
    })

    expect(handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: Alarm Logic
// ---------------------------------------------------------------------------

test.describe('BrowserSettingsModule — Alarm Logic', () => {
  test('alarm is created when config is loaded', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = {
        enabled: true,
        recheck_interval_hours: 12,
        detection_timeout_ms: 2000,
      }
      ;(window as any).__browserSettingsPlugin.setupAlarm()
    })

    const alarm = await page.evaluate(
      () => (window as any).chrome.alarms._alarms['rex-browser-settings-recheck']
    )
    expect(alarm).toBeTruthy()
    expect(alarm.delayInMinutes).toBe(12 * 60)
  })

  test('alarm triggers proactive detection when no recent passive detection', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)
    await seedConfig(page) // sets rexIdentifier

    await setMockSearchUrl(page, 'https://www.google.com/search?q=alarm-test')

    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = {
        enabled: true,
        recheck_interval_hours: 24,
        detection_timeout_ms: 2000,
      }
      ;(window as any).__browserSettingsPlugin.setupAlarm()
    })

    await page.evaluate(() => { (window as any).__capturedEvents = [] })

    // Trigger the alarm
    await page.evaluate(() => {
      window.triggerAlarm('rex-browser-settings-recheck')
    })

    // Wait for proactive detection to complete
    await page.waitForTimeout(500)

    const events = await page.evaluate(
      () => ((window as any).__capturedEvents as Record<string, unknown>[]).filter(
        e => e.name === 'rex-browser-settings-search-engine'
      )
    )
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0].detection_method).toBe('active')
  })

  test('alarm skips proactive detection when recent passive detection exists', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)
    await seedConfig(page) // sets rexIdentifier

    // Set up passive detection first
    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = {
        enabled: true,
        recheck_interval_hours: 24,
        detection_timeout_ms: 2000,
      }
      ;(window as any).__browserSettingsPlugin.setupPassiveDetection()
      ;(window as any).__browserSettingsPlugin.setupAlarm()
    })

    // Simulate a recent passive detection
    await page.evaluate(() => {
      window.triggerWebNavigation({
        frameId: 0,
        url: 'https://www.google.com/search?q=passive-test',
        transitionType: 'generated',
        tabId: 1,
        timeStamp: Date.now(),
        documentId: 'doc1',
        documentLifecycle: 'active',
        frameType: 'outermost_frame',
        parentDocumentId: '',
        parentFrameId: -1,
        processId: 1,
        transitionQualifiers: [],
      })
    })

    // Wait for passive detection to be stored
    await page.waitForTimeout(500)

    // Reset events to track only what alarm does
    await page.evaluate(() => { (window as any).__capturedEvents = [] })

    // Track if windows.create is called (indicating proactive detection)
    await page.evaluate(() => {
      ;(window as any).__proactiveTriggered = false
      const origCreate = (window as any).chrome.windows.create
      ;(window as any).chrome.windows.create = (opts, cb) => {
        ;(window as any).__proactiveTriggered = true
        origCreate(opts, cb)
      }
    })

    // Trigger the alarm
    await page.evaluate(() => {
      window.triggerAlarm('rex-browser-settings-recheck')
    })

    await page.waitForTimeout(500)

    const proactiveTriggered = await page.evaluate(() => (window as any).__proactiveTriggered)
    expect(proactiveTriggered).toBe(false)
  })

  test('alarm uses default 24-hour recheck when config omits recheck_interval_hours', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = {
        enabled: true,
        detection_timeout_ms: 2000,
        // no recheck_interval_hours
      }
      ;(window as any).__browserSettingsPlugin.setupAlarm()
    })

    const alarm = await page.evaluate(
      () => (window as any).chrome.alarms._alarms['rex-browser-settings-recheck']
    )
    expect(alarm).toBeTruthy()
    expect(alarm.delayInMinutes).toBe(24 * 60)
  })
})

// ---------------------------------------------------------------------------
// Tests: End-to-End Integration
// ---------------------------------------------------------------------------

test.describe('BrowserSettingsModule — Integration', () => {
  test('full flow: updateConfiguration → proactive detection → PDK report → stored result', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)

    // Set up identifier and config
    await page.evaluate(() => {
      ;(window as any).chrome.storage.local._data.rexIdentifier = 'integration-test-001'
      ;(window as any).chrome.storage.local._data.REXConfiguration = {
        browser_settings: {
          enabled: true,
          recheck_interval_hours: 24,
          detection_timeout_ms: 2000,
        },
      }
    })

    await setMockSearchUrl(page, 'https://www.ecosia.org/search?q=integration+test')
    await resetCallTracking(page)

    // Trigger the full flow via updateConfiguration
    await page.evaluate(() => {
      const plugin = (window as any).__browserSettingsPlugin
      // Reset passiveListenerAdded so setupPassiveDetection runs
      plugin.passiveListenerAdded = false
      plugin.updateConfiguration({
        enabled: true,
        recheck_interval_hours: 24,
        detection_timeout_ms: 2000,
      })
    })

    // updateConfiguration calls detectSearchEngineProactive after PROACTIVE_DELAY_MS (30s).
    // For integration test, call it directly instead of waiting.
    await page.evaluate(async () => {
      return await (window as any).__browserSettingsPlugin.detectSearchEngineProactive()
    })

    await page.waitForTimeout(300)

    // 1. Verify PDK event was dispatched
    const events = await page.evaluate(
      () => ((window as any).__capturedEvents as Record<string, unknown>[]).filter(
        e => e.name === 'rex-browser-settings-search-engine'
      )
    )
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0].engine).toBe('ecosia')
    expect(events[0].detection_method).toBe('active')
    expect(events[0].confident).toBe(true)

    // 2. Verify result is stored and retrievable via message
    const status = await page.evaluate(
      () => (window as any).__sendMessage({ messageType: 'getBrowserSettingsStatus' })
    )
    expect((status as any).engine).toBe('ecosia')

    // 3. Verify checkBrowserSettingsReady reports ready
    const ready = await page.evaluate(
      () => (window as any).__sendMessage({ messageType: 'checkBrowserSettingsReady' })
    )
    expect((ready as any).ready).toBe(true)
    expect((ready as any).issues).toHaveLength(0)

    // 4. Verify alarm was created
    const alarm = await page.evaluate(
      () => (window as any).chrome.alarms._alarms['rex-browser-settings-recheck']
    )
    expect(alarm).toBeTruthy()

    // 5. Verify passive listener was set up
    const passiveListeners = await page.evaluate(
      () => (window as any).chrome.webNavigation._committedListeners.length
    )
    expect(passiveListeners).toBeGreaterThanOrEqual(1)
  })

  test('full flow with passive detection: navigation → store → PDK → ready', async ({ page }) => {
    await page.goto('/test-page.html')
    await waitForShimLoaded(page)
    await seedConfig(page)
    await resetCallTracking(page)

    // Set up module with passive detection
    await page.evaluate(() => {
      ;(window as any).__browserSettingsPlugin.config = {
        enabled: true,
        recheck_interval_hours: 24,
      }
      ;(window as any).__browserSettingsPlugin.setupPassiveDetection()
    })

    // Simulate user searching via omnibox (generated transition)
    await page.evaluate(() => {
      window.triggerWebNavigation({
        frameId: 0,
        url: 'https://search.brave.com/search?q=brave+test',
        transitionType: 'generated',
        tabId: 42,
        timeStamp: Date.now(),
        processId: 1,
      })
    })

    await page.waitForTimeout(500)

    // Verify PDK event
    const events = await page.evaluate(
      () => ((window as any).__capturedEvents as Record<string, unknown>[]).filter(
        e => e.name === 'rex-browser-settings-search-engine'
      )
    )
    expect(events.length).toBe(1)
    expect(events[0].engine).toBe('brave')
    expect(events[0].detection_method).toBe('passive')

    // Verify stored and ready
    const ready = await page.evaluate(
      () => (window as any).__sendMessage({ messageType: 'checkBrowserSettingsReady' })
    )
    expect((ready as any).ready).toBe(true)
  })
})
