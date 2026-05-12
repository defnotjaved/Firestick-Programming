# Fire TV APK Provisioning

This tool downloads approved APKs into `C:\apkapps`, installs them on one or more Fire TV devices through ADB, captures screenshots/UI dumps, and performs best-effort first-run setup.

## Prerequisites

- Node.js 18 or newer
- Android Platform Tools with `adb` on `PATH`
- Fire TV ADB debugging enabled and authorized
- Approved APK sources configured in `firetv-apps.json`

## Terminal GUI

Launch the terminal UI:

```powershell
.\scripts\firetv\firetv-tui.ps1
```

The TUI can:

- scan `C:\apkapps`
- download missing APKs
- connect Fire TVs by IP
- list authorized ADB devices
- run setup on multiple Fire TVs simultaneously
- run fast resumable TiviMate programming from pasted Firestick IPs
- open the APK folder in Explorer

Multi-device setup runs each selected Fire TV in parallel and passes `--allow-missing`, so devices still receive every APK currently present in `C:\apkapps` while missing requested apps are logged in the run folder.

For TiviMate programming, choose **6. Fast TiviMate setup/program Firesticks**, paste comma-separated IPs, confirm the accounts file and portal map, and the tool will run each Firestick in parallel. Use the fresh reset prompt only when you want TiviMate wiped and configured from scratch.

## Configure Apps

Edit `firetv-apps.json` before the first full run.

- Existing APKs were moved from `D:\apkapps` to `C:\apkapps`.
- The local category currently uses RedBox TV, Swift Streamz, and VLC from the moved folder.
- Bear Player is configured from a direct public APK URL because it was not listed on the Troypoint Downloader codes page.
- Add `packageName` for apps when you know it. If omitted, setup tries to discover it with `aapt` or `apkanalyzer`.

## Download APKs

Dry run:

```powershell
.\scripts\firetv\download-apks.ps1 -DryRun
```

Download:

```powershell
.\scripts\firetv\download-apks.ps1
```

Allow Bear Player alternate-source lookup after adding approved domains:

```powershell
.\scripts\firetv\download-apks.ps1 -AllowAlternateSearch
```

Every run writes a JSON report under:

```text
C:\apkapps\_runs\
```

## Setup Fire TV

Connect by IP:

```powershell
.\scripts\firetv\setup-firetv.ps1 -FireTvIp 192.168.1.50 -Mode unattended
```

Use an already connected ADB device:

```powershell
.\scripts\firetv\setup-firetv.ps1 -Device 192.168.1.50:5555 -Mode install-only
```

Install everything currently available and only log missing manifest APKs:

```powershell
.\scripts\firetv\setup-firetv.ps1 -Device 192.168.1.50:5555 -Mode unattended -AllowMissing
```

Modes:

- `unattended`: default; handles known prompts and logs unknown screens.
- `guarded`: pauses for manual help on unknown screens.
- `install-only`: installs, launches, screenshots, and skips deep initialization.

## Fast TiviMate Setup

The TiviMate setup script is resumable. It stores per-device progress under:

```text
C:\apkapps\_state\
```

By default, reruns reuse installed APKs, reuse the ADB keyboard, and verify an already configured matching playlist instead of clearing TiviMate and starting over.

Run multiple authorized sticks in parallel using existing saved accounts and wd-card portals:

```powershell
.\scripts\firetv\setup-tivimate.ps1 `
  -Ips "192.168.1.202,192.168.1.206,192.168.1.163" `
  -AccountsFile "C:\apkapps\_runs\tivimate-2026-05-11T19-32-01-678Z\accounts.json" `
  -PortalMap "C:\apkapps\tivimate-portals.json" `
  -Parallel `
  -WaitForAuthMinutes 30
```

Use `-Fresh` only when you intentionally want to wipe TiviMate app data and redo the first-run setup.

## Logs

Setup creates:

- `device-info.json`
- `install-report.json`
- `adb-commands.json`
- per-app screenshots and `uiautomator` XML dumps
- launcher arrangement report

Home-screen arrangement is best-effort because Fire OS launcher behavior varies by version. If direct movement is blocked, the script launches apps in preferred order so they appear in recent apps.
