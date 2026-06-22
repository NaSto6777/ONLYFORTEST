# Local Control Panel

Navigation: [Documentation index](./README.md) -> [Configuration](./configuration.md) -> [Core Dashboard](./dashboard.md)

The open-source bot includes an optional **localhost web control panel**. It is separate from the official Core remote dashboard.

## Enable

Add to `src/config.json`:

```json
"controlPanel": {
    "enabled": true,
    "port": 4780,
    "runOnStartup": true
}
```

Build and start the bot:

```bash
npm run build
npm start
```

On startup the bot prints a one-time URL with a bearer token:

```
[CONTROL-PANEL] Local control panel ready at http://127.0.0.1:4780/?token=...
```

Open that URL in your browser. The token is also stored in `.core/control-panel.json` while the panel is running.

## Environment overrides

| Variable | Purpose |
| --- | --- |
| `MSRB_CONTROL_PANEL_PORT` | Override `controlPanel.port` |
| `MSRB_CONTROL_PANEL_TOKEN` | Use a fixed token instead of a random one |

## Features

- **Dashboard** — run state, uptime, version, accounts due today, Run now / Stop safely
- **Accounts** — card layout with enable toggle, locale edit, **Open** (visible desktop browser), Run, Clear session
- **Workers** — toggle all `workers.*` flags
- **Settings** — headless, clusters, scheduler, search delays, console log filter
- **Logs** — live terminal via Server-Sent Events (last 500 entries)

## Security model

The panel follows a **localhost trust model**:

- Binds to `127.0.0.1` only — not reachable from other machines on your network
- API mutations require the bearer token
- **Passwords, TOTP secrets, and proxy passwords are never returned or editable** via the panel
- Webhook URLs are not exposed in the panel API

To add a new account with a password, edit `src/accounts.json` manually or use `npm run add-account`.

## Run behavior

When `controlPanel.enabled` is `true`, the bot stays alive after startup instead of exiting after a single run:

1. Starts the local HTTP server and `AgentRuntime` IPC
2. Optionally runs accounts immediately if `runOnStartup` is `true` (default)
3. Waits for **Run now** from the panel, a scheduler tick (if `scheduler.enabled`), or **Stop safely**
4. **Stop safely** sets `dashboardStopRequested`; the bot finishes the current run then exits

Recommended setup for daily automation plus manual control:

```json
"controlPanel": { "enabled": true, "runOnStartup": true },
"scheduler": { "enabled": true, "runOnStartup": false, ... }
```

## Coexistence with Core dashboard

| Capability | OSS control panel | Core remote dashboard |
| --- | --- | --- |
| Localhost HTTP UI | Yes (`127.0.0.1`) | No |
| Remote web UI | No | Yes |
| Password editing | No | Yes (encrypted to local bot) |
| Requires Core license | No | Yes |

Both can run at the same time if Core is installed and licensed.

## Related pages

- [Core Dashboard](./dashboard.md) — official remote dashboard (Core only)
- [Configuration](./configuration.md) — full `config.json` reference
