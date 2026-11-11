# Autosell V3 Windows desktop

Build on Windows x64 with Node 24.22.0 and npm. Installed users receive a dedicated Node 24 executable and the Playwright 1.63 Chromium build. Electron 45.2.3 runs the shell. The backend uses its own Node SQLite implementation and production dependency tree outside ASAR.

```powershell
npm ci
npm ci --prefix desktop
npm run check
npm run test:local
npm test --prefix desktop
npm run prepare:resources --prefix desktop
npm run test:runtime --prefix desktop
npm run package --prefix desktop
npm run test:installed --prefix desktop
```

On a fresh developer machine, install the test browser before `test:local` with `node node_modules/playwright/cli.js install chromium`. Packaging installs its own browser under `desktop/staging/browsers` and verifies the pinned Node ZIP SHA256 before extraction. Source files in `web/dist` are the existing distributable dashboard. There is no frontend build project in the supplied application. Packaging copies those assets, which the backend/UI tests validate.

The installer is written to `desktop/dist/Autosell-Setup-3.0.1-x64.exe`. `npm start --prefix desktop` runs the shell after resources have been prepared. The installer provides destination selection, Start Menu registration, an optional desktop shortcut, versioned Windows metadata, and an uninstaller. It refuses to overwrite files while the desktop or bundled backend is running. Choose **Exit safely** first.

## First launch and migration

The default persistent location is `%LOCALAPPDATA%\Autosell V3`. Its `workspace` directory contains the backend `data` directory, SQLite database and journals, encrypted vault, evidence, logs, seller profiles, and migrated environment settings. The `desktop` directory contains Electron preferences. Window bounds, update preferences, and update recovery journals are stored next to it.

Choose **Import existing installation** before opening a new workspace. Stop the old backend and select its installation root. The migration command verifies a backup, checks SQLite integrity, preserves the old vault, and retires the old workspace before publishing the destination. An interrupted import must be resumed by selecting the same source again. The shell blocks startup while a migration journal remains incomplete.

Enter the existing vault passphrase after migration. A new workspace requires an owner-selected passphrase of at least 12 characters. The optional remember switch protects it with Windows DPAPI through Electron safeStorage. Keep an independent secure copy of that passphrase. A dashboard owner password remains required inside the dashboard.

Minecraft 26.3, Fabric Loader 0.20.1, Java 25, and a valid Minecraft account are separate prerequisites. Both the Autosell bridge and Fabric API JAR are packaged under `resources/runtime/backend/release`. The dashboard's Prism setup flow installs the selected instance and pairing configuration. Live game connectivity depends on that client running with the correct account and server.

## Lifecycle and recovery

The desktop acquires Electron's single-instance lock. The backend also holds its persistent workspace lock. A random per-launch credential protects every loopback HTTP request, and the port is selected by the operating system. The dashboard retains owner authentication and CSRF checks. The renderer has no Node integration or backend token. Its WebContentsView has no desktop preload. Desktop IPC accepts only the owned shell's exact main frame.

Closing the window keeps the backend running in the system tray. **Exit safely** persists maintenance, waits for the real payment state and account locks to become safe, and then shuts down. Windows can impose shutdown deadlines, so persisted uncertainty journals remain necessary after an operating-system interruption.

A renderer crash recreates its UI independently. A backend crash permits at most three delayed restarts in a desktop session. Recovery opens the database under a durable maintenance fence, and **Resume after reconciliation** is explicit. Inspect unresolved payments and game connectivity before resuming. An unsafe result continues to hold dispatch and installation. `desktop-diagnostics.json` retains 200 lifecycle entries and recognized startup error categories without raw backend output or credentials. A slow live backend remains supervised and can still complete startup after the initial readiness deadline.

Updates download without interrupting the dashboard. **Restart and install safely** persists the update target, fences new financial operations, waits for admitted operations, checks uncertainty and account locks, checks safety again, and then stops the backend. A matching installed version with a matching safe persisted target may resume automatically. A failed or mismatched upgrade stays fenced for operator recovery.

The uninstaller preserves `%LOCALAPPDATA%\Autosell V3` by default. Reinstallation uses the same workspace. To remove the application and its personal data, exit safely, open **Uninstall Autosell V3** from Start Menu or Windows Installed Apps, select **Remove all Autosell data**, and confirm the permanent deletion. That option removes the owned desktop database, vault, journals, evidence, browser sessions, logs, window preferences and update state. Export anything you need first. Upgrades always preserve this data. Original migration sources, independently managed Prism instances, and custom `--profile-dir` locations require separate owner-managed removal.

Complete silent removal requires both explicit flags `--remove-all-autosell-data --confirm-remove-all-autosell-data` together with `/S`. A single flag preserves data. The removal helper validates the exact owned application root and its ownership marker, checks running processes and workspace locks, and refuses junctions or symbolic links before deletion.

## Publishing stable and beta releases

The workflow is `.github/workflows/windows-release.yml`. Pull requests and main-branch pushes run the locked tests and produce a development installer. Version tags run validation first, then the protected `windows-release` environment performs the production build, signing, artifact validation and publication to the configured GitHub repository.

Configure the repository environment with release-tag restrictions and required reviewers. Set these environment variables and secrets before publishing. The exact setup steps are in [RELEASE-SETUP.md](RELEASE-SETUP.md).

| Name | Type | Value |
| --- | --- | --- |
| `AUTOSELL_SIGNING_PROVIDER` | Environment variable | `pfx` or `azure` |
| `AUTOSELL_PUBLISHER_NAME` | Environment variable | Exact Windows certificate publisher common name or full distinguished name |
| `AUTOSELL_UPDATE_PUBLIC_KEY` | Environment variable | Ed25519 public key in PEM format |
| `AUTOSELL_UPDATE_PRIVATE_KEY` | Environment secret | Corresponding Ed25519 private key in PEM format |
| `WINDOWS_CERTIFICATE_PFX_BASE64` | Environment secret | Base64 encoded code-signing PFX for the `pfx` path |
| `WINDOWS_CERTIFICATE_PASSWORD` | Environment secret | PFX password |
| `AZURE_SIGNING_ENDPOINT` | Environment variable | Azure Artifact Signing account endpoint for the `azure` path |
| `AZURE_SIGNING_ACCOUNT` | Environment variable | Azure code signing account name |
| `AZURE_SIGNING_PROFILE` | Environment variable | Azure certificate profile name |
| `AZURE_TENANT_ID` | Environment variable | Microsoft Entra tenant ID |
| `AZURE_CLIENT_ID` | Environment variable | Azure service principal application ID |
| `AZURE_CLIENT_SECRET` | Environment secret | Azure service principal secret used by the pinned signing module |

The workflow uses the repository-scoped `GITHUB_TOKEN` to publish. Private signing keys and credentials remain in the protected job steps. The distributed app contains only the public key and publisher identity. Release configuration fails closed if any required value is missing. This checkout has automatic updating disabled until production signing is configured.

Generate Ed25519 keys using an approved secure workstation, then place only the public key in the environment variable. OpenSSL can create them with `openssl genpkey -algorithm ED25519 -out update-private.pem` and `openssl pkey -in update-private.pem -pubout -out update-public.pem`. Store the private key in the environment secret and remove transient plaintext copies according to your key-handling procedure.

Set the same semantic version in root and desktop `package.json` and their lockfiles. Tag the tested commit `v3.0.1` for stable or `v3.1.0-beta.1` for beta. Stable uses `latest.yml` and `stable-manifest.json`. Beta uses `beta.yml` and `beta-manifest.json` and publishes a GitHub prerelease. The Updates screen persists the selected channel. It rejects downgrades, so moving from beta to stable waits for a newer stable version.

Each signed manifest binds channel, version, publisher, release notes, installer filename, size, and SHA512. The updater verifies the Ed25519 signature before allowing electron-updater to download the matching artifact. electron-updater verifies the SHA512 and Windows Authenticode publisher. The installer is the complete offline payload. Metadata mismatch, signature failure or interrupted download remains recoverable from Updates. Failed tests prevent release publication.

Keep prior installers and migration backups for recovery. An installer failure that preserves the old application leaves its payment fence active. Restore a compatible installer using the normal wizard after services have exited. Schema downgrade and automatic journal rollback are unsupported. Restore an offline database backup only after confirming which payments have executed since that backup and reconciling them.

## Validation boundaries

`test:runtime` uses a generated workspace, bundled Node, bundled Chromium, and a restricted PATH. It checks authenticated readiness, dashboard authentication, SQLite persistence, and maintenance shutdown/restart. `test:installed` drives the built Electron application with a generated profile and checks owner login, second instance, renderer and backend recovery, minimize/restore, tray close, and safe exit. `AUTOSELL_DESKTOP_TEST=1` uses an ephemeral Minecraft bridge port for fixtures. It is set only by test runners.

Local results and screenshots are written to ignored `desktop/test-results`. Production credentials and customer data are excluded from staging. A Windows host test with an isolated profile establishes the listed checks. A separate clean Windows VM, a live paired Minecraft client, a signed published upgrade between two versions, and certificate verification with the real publisher remain release acceptance checks requiring their corresponding environment and credentials. `npm run test:update --prefix desktop` drives the signed A-to-B acceptance script when both releases exist.

The design follows the documented [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security) and [electron-builder NSIS configuration](https://www.electron.build/nsis/).
