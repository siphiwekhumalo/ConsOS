# ConstructOS desktop app (Windows)

**Written for:** whoever builds and distributes the desktop app.

The desktop app is the same web app in an Electron window. It needs the ConstructOS server: it does not run the database or the APIs itself, and it works offline no more than the website does.

## How it works
- The built web app (`apps/web/dist`) ships inside the installer and is served from a private `app://constructos` origin.
- Calls to `/api`, `/sync` and `/ai` are forwarded by the app to the server, the same paths the load balancer routes on the web. The API needs no changes.
- File uploads and downloads go straight to S3 with presigned URLs, as on the web. `app://constructos` is in the S3 CORS rule (`infra/terraform/storage.tf`); apply Terraform before releasing the app.
- Sign-in works exactly as on the web (bearer token, cleared when the app closes).

### Security settings
- The renderer has no Node.js access (context isolation, sandbox).
- The page runs under a strict Content-Security-Policy.
- The app never navigates away from itself. Other links open in the system browser.
- Camera, microphone, location and other permission requests are refused.
- The server must use HTTPS. Plain HTTP is allowed only to `localhost`, for development.

## Server address
The default is `https://baheka-construct-os.com`. To point the app at another server (for example a test environment), edit `settings.json` in the app's data folder (**File → Open settings file…**):

```json
{ "serverUrl": "https://test.baheka-construct-os.com" }
```

For a single run, set the `CONSTRUCTOS_SERVER` environment variable instead.

## Build the installer
On a Windows machine with Node 22 and pnpm:

```bash
pnpm install
pnpm --filter @constructos/desktop dist:win
```

The installer is written to `apps/desktop/release/ConstructOS-Setup-<version>.exe`.

To work on the UI with live reload, run the web dev server (`pnpm dev:web`), then:

```bash
CONSTRUCTOS_DEV_URL=http://localhost:5173 pnpm --filter @constructos/desktop dev
```

## Before distributing to staff
1. **Code signing.** The installer is not signed yet. Unsigned executables trigger SmartScreen warnings, and on managed KAEFER laptops they are blocked outright (during development, Electron itself was blocked from running on a managed machine). Obtain a code-signing certificate, configure it in electron-builder (`win.certificateFile` / Azure Trusted Signing), and ask IT to approve the signed app for deployment (for example through Intune).
2. **Updates.** Auto-update is not configured. Until it is, each release means a new installer. electron-updater can be added once there is a place to publish signed releases.
3. **CI.** Buildkite compiles and tests the desktop code on every build, but does not build the installer. Building it needs a Windows agent; add a step on a Windows queue when signing is in place.
