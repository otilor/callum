# The desktop app

The desktop app is Callum's own server and web app in a window, with a tray icon so Callum keeps working after the window is closed. It uses the same code as server mode.

## How it runs

- On start it takes a lock so a second launch only brings the first window to the front.
- It starts the server on a free port on `127.0.0.1`, with no password, and keeps everything in the app's data folder: `~/Library/Application Support/Callum` on macOS, `%APPDATA%\Callum` on Windows and `~/.config/Callum` on Linux. The database is `data/callum.db` inside it.
- Closing the window hides it. Callum keeps sending and reading replies. On Windows and Linux Callum says so once, in a notification. Quit Callum in the tray menu (or the app menu) stops the runner before the program ends.
- The tray menu has Open Callum, the status (Running, Paused until Monday, or LinkedIn needs you), Take a break until Monday or Resume, and Quit Callum.
- Links to other sites open in your own browser, and the page gets no Node or Electron access: its only extra is `window.callumDesktop` (see `electron/preload.ts`).
- Replies and the 8:30 morning note are shown as system notifications when notifications are on in Your Callum.
- Open at login uses the login items on macOS and Windows and an autostart entry on Linux (`~/.config/autostart/callum.desktop`). A login start opens Callum straight into the tray.

## LinkedIn

LinkedIn runs in Google Chrome or Microsoft Edge on the same computer, in a profile of its own inside the data folder. With neither installed, connecting LinkedIn says so. (`electron/browser.ts` also accepts a Chromium named in `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, or the one that comes with Playwright when developing.)

## Build it yourself

```sh
npm ci
npm run desktop:dev     # builds the web app, compiles electron/ and the server, opens the app
npm run desktop:build   # the unpacked app for this computer, in release/
npm run desktop:dist    # the installer for this computer (dmg, exe or AppImage), in release/
```

Notes:

- `desktop:dev` and the installers start from `dist/`, so run them after `npm run build` (the scripts do it for you).
- On Linux as root (a container) Electron refuses to start without `--no-sandbox`: `npx electron . --no-sandbox`.
- `CALLUM_DEMO=1` works in the desktop app too. `CALLUM_USER_DATA=<folder>` keeps its data somewhere else, which the end-to-end test uses.
- The tests: `npm test` covers the tray menu, notifications, open at login and the LinkedIn browser choice. `xvfb-run -a npx playwright test e2e/desktop.spec.ts` starts the real app (drop `xvfb-run -a` on a computer with a screen).
- The builds are not signed, which is why macOS and Windows warn the first time. See the README.
