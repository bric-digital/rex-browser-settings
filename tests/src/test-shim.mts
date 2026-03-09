/**
 * Test shim for rex-browser-settings service worker module.
 *
 * Loads the real BrowserSettingsServiceWorkerModule and registers an
 * EventCaptureModule alongside it, so Playwright tests can assert on
 * dispatched events.
 *
 * Load tests/src/build/test-shim.bundle.js in the test page AFTER the
 * chrome mock has been defined on window.
 */
import rexCorePlugin, { registerREXModule, REXServiceWorkerModule } from '@bric/rex-core/service-worker'
import browserSettingsPlugin from '../../src/service-worker.mjs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any

g.__capturedEvents = []

class EventCaptureModule extends REXServiceWorkerModule {
  moduleName(): string { return 'EventCapture' }
  override setup(): void { /* intentional no-op */ }
  override handleMessage(_msg: unknown, _sender: unknown, _sendResponse: (r: unknown) => void): boolean { return false }
  override logEvent(event: object): void {
    const arr = g.__capturedEvents
    if (Array.isArray(arr)) {
      arr.push(event)
    }
  }
}

registerREXModule(new EventCaptureModule())

g.__browserSettingsPlugin = browserSettingsPlugin

g.__sendMessage = (message: Record<string, unknown>): Promise<unknown> => {
  return new Promise((resolve) => {
    rexCorePlugin.handleMessage(message, {}, resolve)
  })
}

g.__browserSettingsShimLoaded = true
