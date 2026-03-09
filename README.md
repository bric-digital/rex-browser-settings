# rex-browser-settings

REX module for detecting browser settings such as the participant's default search engine.

## Detection Strategy

Two complementary detection mechanisms:

1. **Proactive detection** (30 seconds after first setup): Uses `chrome.search.query()` in a minimized window to determine which search engine handles the request.

2. **Passive observation** (always-on): Monitors `chrome.webNavigation.onCommitted` for `transitionType: 'generated'` events, which indicate omnibox searches.

3. **24-hour re-check alarm**: Periodically verifies the detection result, skipping if a passive observation occurred recently.

Results are reported to PDK via `dispatchEvent` and stored locally via rex-core's IndexedDB `storeValue`/`fetchValue`.

## Supported Search Engines

Google, Bing, DuckDuckGo, Yahoo, Ecosia, Brave, Baidu, Yandex, Startpage.

## Installation

Add to your extension's `package.json`:

```json
"@bric/rex-browser-settings": "github:bric-digital/rex-browser-settings"
```

Import in your service worker:

```typescript
import browserSettingsPlugin from '@bric/rex-browser-settings/service-worker'
```

Add to your extension's `manifest.json` permissions:

```json
"permissions": ["search", "webNavigation"]
```

## Server Configuration

```json
"browser_settings": {
    "enabled": true,
    "recheck_interval_hours": 24,
    "detection_timeout_ms": 10000
}
```

## Development

```bash
npm install
npm run build
npm run lint
npm test
```
