const fs = require('fs');
const path = require('path');
const {
  appApkPath,
  ensureDir,
  expandPath,
  loadManifest,
  nowStamp,
  parseArgs,
  safeName,
  sha256File,
  validateManifest,
  writeJson
} = require('./common');
const {
  AdbRunner,
  KEY,
  adbExists,
  connectDevice,
  findClickableText,
  listDevices
} = require('./adb-runner');

const DEFAULT_MANIFEST = path.join(__dirname, '..', 'firetv-apps.json');
const KNOWN_PROMPTS = [
  /^allow$/i,
  /while using/i,
  /only this time/i,
  /^ok$/i,
  /^continue$/i,
  /^accept$/i,
  /^agree$/i,
  /^start$/i,
  /^next$/i,
  /^skip$/i,
  /not now/i,
  /maybe later/i,
  /^later$/i,
  /^close$/i,
  /^done$/i,
  /^don't show again$/i
];

const READY_TEXT = [
  /movies?/i,
  /tv shows?/i,
  /live tv/i,
  /channels?/i,
  /sports?/i,
  /trending/i,
  /popular/i,
  /search/i,
  /home/i,
  /watch/i,
  /play/i
];

const BLOCKED_TEXT = [
  /sign in/i,
  /login/i,
  /log in/i,
  /subscription/i,
  /subscribe/i,
  /activation/i,
  /payment/i,
  /purchase/i
];

function usage() {
  return [
    'Usage: node src/setup-firetv.js --mode unattended|guarded|install-only [--firetv-ip 192.168.1.10] [--device SERIAL]',
    '',
    'Requires Android Platform Tools adb on PATH.',
    'If adb is missing, install platform-tools and rerun.'
  ].join('\n');
}

function detectPackage(apkPath) {
  const tools = [
    { cmd: 'aapt', args: ['dump', 'badging', apkPath], regex: /package: name='([^']+)'/ },
    { cmd: 'apkanalyzer', args: ['manifest', 'application-id', apkPath], regex: /^(.+)$/m }
  ];

  const { spawnSync } = require('child_process');
  for (const tool of tools) {
    const result = spawnSync(tool.cmd, tool.args, { encoding: 'utf8', timeout: 30000 });
    if (result.status === 0) {
      const match = String(result.stdout).match(tool.regex);
      if (match && match[1]) return match[1].trim();
    }
  }
  return null;
}

function resolveApps(manifest, apkDir, includeOptional) {
  const validation = validateManifest(manifest, { includeOptional });
  if (validation.errors.length) {
    const message = validation.errors.map((error) => `Manifest error: ${error}`).join('\n');
    throw new Error(message);
  }

  return validation.selectedApps.map((app) => {
    const apkPath = appApkPath(app, apkDir);
    return {
      ...app,
      apkPath,
      apkExists: fs.existsSync(apkPath),
      sha256: fs.existsSync(apkPath) ? sha256File(apkPath) : null
    };
  });
}

function chooseDevice(args) {
  if (args['firetv-ip']) {
    const output = connectDevice('adb', args['firetv-ip']);
    console.log(output.trim());
    const requested = args['firetv-ip'].includes(':') ? args['firetv-ip'] : `${args['firetv-ip']}:5555`;
    const found = listDevices('adb').find((device) => device.id === requested);
    if (!found || found.state !== 'device') {
      throw new Error(`Requested Fire TV "${requested}" is not authorized. Approve the ADB debugging prompt on the Fire TV, then rerun.`);
    }
    return requested;
  }

  const devices = listDevices('adb').filter((device) => device.state === 'device');
  if (args.device) {
    const found = devices.find((device) => device.id === args.device);
    if (!found) throw new Error(`Requested ADB device "${args.device}" is not connected. Connected: ${devices.map((d) => d.id).join(', ') || 'none'}`);
    return args.device;
  }

  if (devices.length === 1) return devices[0].id;
  if (!devices.length) throw new Error('No authorized Fire TV/Android device found. Enable ADB debugging, approve the connection on the Firestick, then rerun.');
  throw new Error(`Multiple ADB devices found. Rerun with --device. Connected: ${devices.map((d) => d.id).join(', ')}`);
}

function captureState(adb, dir, label) {
  const base = `${String(label).replace(/[^a-z0-9._-]+/gi, '-')}`;
  const png = path.join(dir, `${base}.png`);
  const xml = path.join(dir, `${base}.xml`);
  let ui = '';
  try {
    adb.screencap(png);
  } catch (error) {
    fs.writeFileSync(`${png}.error.txt`, error.message, 'utf8');
  }
  try {
    ui = adb.dumpUi(xml);
  } catch (error) {
    fs.writeFileSync(`${xml}.error.txt`, error.message, 'utf8');
  }
  return { screenshot: png, uiDump: xml, ui };
}

function visibleText(xml) {
  return [...String(xml).matchAll(/\b(?:text|content-desc)="([^"]+)"/gi)]
    .map((match) => match[1].replace(/&amp;/g, '&').replace(/&#10;/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 80);
}

function classifyUi(xml) {
  const text = visibleText(xml).join(' ');
  if (BLOCKED_TEXT.some((pattern) => pattern.test(text))) return 'blocked-login-or-subscription';
  if (READY_TEXT.some((pattern) => pattern.test(text))) return 'ready';
  return 'unknown';
}

function guardedPause(message) {
  console.log(message);
  console.log('Press Enter here after handling the screen on the Firestick.');
  fs.readSync(0, Buffer.alloc(1), 0, 1);
}

function initializeApp(adb, app, runDir, mode) {
  const appDir = path.join(runDir, 'apps', safeName(app.id));
  ensureDir(appDir);
  const steps = [];

  adb.grantCommonPermissions(app.packageName);
  adb.launch(app.packageName, app.launchActivity);
  adb.sleep(4000);

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const state = captureState(adb, appDir, `step-${attempt}`);
    const click = findClickableText(state.ui, KNOWN_PROMPTS);
    const classification = classifyUi(state.ui);
    const step = {
      attempt,
      screenshot: state.screenshot,
      uiDump: state.uiDump,
      visibleText: visibleText(state.ui),
      classification,
      action: 'none'
    };

    if (click) {
      step.action = `tap "${click.text}"`;
      step.resourceId = click.resourceId;
      step.x = click.x;
      step.y = click.y;
      adb.tap(click.x, click.y);
      adb.sleep(2000);
      steps.push(step);
      continue;
    }

    if (classification === 'blocked-login-or-subscription') {
      step.action = 'blocked-login-or-subscription';
      steps.push(step);
      break;
    }

    if (classification === 'ready') {
      step.action = 'ready';
      steps.push(step);
      break;
    }

    if (mode === 'guarded') {
      step.action = 'guarded-pause';
      steps.push(step);
      guardedPause(`Unknown screen while initializing ${app.name}.`);
      continue;
    }

    if (mode === 'unattended') {
      step.action = 'unattended-back';
      adb.keyevent('BACK');
      adb.sleep(1500);
      steps.push(step);
      continue;
    }

    steps.push(step);
    break;
  }

  writeJson(path.join(appDir, 'initialize-report.json'), steps);
  adb.keyevent('HOME');
  adb.sleep(1000);
}

function enableUnknownSources(adb, runDir, mode) {
  const dir = path.join(runDir, 'unknown-sources');
  ensureDir(dir);
  adb.startSettingsUnknownSources();
  adb.sleep(2500);
  const state = captureState(adb, dir, 'initial');
  const allow = findClickableText(state.ui, [/on/i, /allow/i, /unknown/i, /install/i]);
  const report = [{ screenshot: state.screenshot, uiDump: state.uiDump, action: 'opened-settings' }];

  if (allow) {
    adb.tap(allow.x, allow.y);
    adb.sleep(1000);
    report.push({ action: `tap "${allow.text}"`, x: allow.x, y: allow.y });
  } else if (mode === 'guarded') {
    report.push({ action: 'guarded-pause' });
    guardedPause('Unknown-sources settings screen was not recognized.');
  } else {
    report.push({ action: 'best-effort-only' });
  }

  captureState(adb, dir, 'after');
  adb.keyevent('HOME');
  writeJson(path.join(dir, 'unknown-sources-report.json'), report);
}

function installApps(adb, apps, runDir, skipInstall) {
  const report = [];
  for (const app of apps) {
    const entry = {
      id: app.id,
      name: app.name,
      apkPath: app.apkPath,
      sha256: app.sha256,
      packageName: app.packageName || null,
      status: 'pending'
    };
    report.push(entry);

    if (!app.apkExists) {
      entry.status = 'missing-apk';
      continue;
    }

    if (!entry.packageName) {
      entry.packageName = detectPackage(app.apkPath);
      app.packageName = entry.packageName;
    }

    if (skipInstall) {
      if (entry.packageName && !adb.packagePath(entry.packageName)) {
        entry.status = 'not-installed-skip-install';
      } else {
        entry.status = 'skipped-install';
      }
      continue;
    }

    try {
      const beforePackages = adb.listPackages();
      try {
        entry.output = adb.install(app.apkPath).trim();
      } catch (installError) {
        if (entry.packageName && /INSTALL_FAILED_UPDATE_INCOMPATIBLE/i.test(installError.message)) {
          entry.replacedIncompatiblePackage = true;
          entry.uninstallOutput = adb.uninstall(entry.packageName).trim();
          entry.output = adb.install(app.apkPath).trim();
        } else {
          throw installError;
        }
      }
      const afterPackages = adb.listPackages();
      if (!entry.packageName) {
        const added = [...afterPackages].filter((packageName) => !beforePackages.has(packageName));
        if (added.length === 1) {
          entry.packageName = added[0];
          app.packageName = added[0];
        }
      }
      entry.status = /success/i.test(entry.output) ? 'installed' : 'installed-unknown-result';
      if (!entry.packageName) {
        entry.launchWarning = 'Installed, but packageName could not be discovered. Add packageName to firetv-apps.json for automatic launch/init.';
      }
    } catch (error) {
      entry.status = 'install-failed';
      entry.error = error.message;
    }
    writeJson(path.join(runDir, 'install-report.json'), report);
  }
  writeJson(path.join(runDir, 'install-report.json'), report);
  return report;
}

function arrangeHome(adb, apps, runDir) {
  const report = [];
  const ordered = apps
    .filter((app) => app.packageName && Number.isFinite(Number(app.homeOrder)))
    .sort((a, b) => Number(a.homeOrder) - Number(b.homeOrder));

  adb.keyevent('HOME');
  adb.sleep(1500);

  for (const app of ordered) {
    const entry = { id: app.id, name: app.name, packageName: app.packageName, action: 'launch-recent-fallback' };
    try {
      adb.launch(app.packageName, app.launchActivity);
      adb.sleep(1200);
      captureState(adb, path.join(runDir, 'home-arrange'), `launched-${safeName(app.id)}`);
      adb.keyevent('HOME');
      adb.sleep(800);
      report.push(entry);
    } catch (error) {
      entry.action = 'failed';
      entry.error = error.message;
      report.push(entry);
    }
  }

  adb.keyevent('HOME');
  adb.sleep(1000);
  captureState(adb, path.join(runDir, 'home-arrange'), 'final-home');
  writeJson(path.join(runDir, 'home-arrange-report.json'), report);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  if (!adbExists('adb')) {
    console.error('ADB was not found on PATH.');
    console.error('Install Android Platform Tools, then add the platform-tools folder to PATH.');
    console.error('Download: https://developer.android.com/tools/releases/platform-tools');
    process.exitCode = 1;
    return;
  }

  const mode = args.mode || 'unattended';
  if (!['unattended', 'guarded', 'install-only'].includes(mode)) {
    throw new Error(`Unsupported --mode "${mode}". Use unattended, guarded, or install-only.`);
  }

  const manifest = loadManifest(args.manifest || DEFAULT_MANIFEST);
  const apkDir = path.resolve(expandPath(args['apk-dir'] || manifest.downloadsDir || path.join(process.env.USERPROFILE || process.cwd(), 'Downloads', 'firetv-apks')));
  const requestedDevice = args['firetv-ip'] || args.device || 'auto';
  const runDir = path.join(apkDir, '_runs', `setup-${nowStamp()}-${safeName(requestedDevice)}`);
  ensureDir(runDir);

  const apps = resolveApps(manifest, apkDir, Boolean(args['include-optional']));
  const missingRequired = apps.filter((app) => app.required !== false && !app.apkExists);
  if (missingRequired.length && !args['allow-missing']) {
    console.error('Required APKs are missing. Run download-apks.ps1 first or place these files manually:');
    for (const app of missingRequired) console.error(`- ${app.name}: ${app.apkPath}`);
    process.exitCode = 1;
    return;
  }
  if (missingRequired.length) {
    writeJson(path.join(runDir, 'missing-required-apks.json'), {
      createdAt: new Date().toISOString(),
      missing: missingRequired.map((app) => ({ id: app.id, name: app.name, apkPath: app.apkPath }))
    });
  }

  const duplicatePackages = new Map();
  for (const app of apps) {
    app.packageName = app.packageName || detectPackage(app.apkPath);
    if (!app.packageName) continue;
    if (!duplicatePackages.has(app.packageName)) duplicatePackages.set(app.packageName, []);
    duplicatePackages.get(app.packageName).push(app.name);
  }
  const dupes = [...duplicatePackages.entries()].filter(([, names]) => names.length > 1);
  if (dupes.length) {
    for (const [packageName, names] of dupes) console.error(`Duplicate package ${packageName}: ${names.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const device = chooseDevice(args);
  const adb = new AdbRunner({ device, logDir: runDir });

  const deviceInfo = {
    device,
    model: adb.shell('getprop ro.product.model', { allowFailure: true }).trim(),
    manufacturer: adb.shell('getprop ro.product.manufacturer', { allowFailure: true }).trim(),
    release: adb.shell('getprop ro.build.version.release', { allowFailure: true }).trim(),
    fireOs: adb.shell('getprop ro.build.version.name', { allowFailure: true }).trim(),
    wmSize: adb.shell('wm size', { allowFailure: true }).trim(),
    startedAt: new Date().toISOString()
  };
  writeJson(path.join(runDir, 'device-info.json'), deviceInfo);

  if (mode !== 'install-only') enableUnknownSources(adb, runDir, mode);

  const installReport = installApps(adb, apps, runDir, Boolean(args['skip-install']));
  const launchableApps = apps.filter((app) => app.packageName && installReport.find((entry) => entry.id === app.id && !entry.status.includes('failed') && entry.status !== 'missing-apk'));

  if (mode !== 'install-only' && !args['skip-initialize']) {
    for (const app of launchableApps) {
      try {
        initializeApp(adb, app, runDir, mode);
      } catch (error) {
        writeJson(path.join(runDir, 'apps', safeName(app.id), 'initialize-error.json'), {
          id: app.id,
          name: app.name,
          packageName: app.packageName,
          error: error.message
        });
        console.warn(`Warning: could not initialize ${app.name}: ${error.message}`);
        adb.keyevent('HOME');
      }
    }
  } else {
    for (const app of launchableApps) {
      try {
        adb.launch(app.packageName, app.launchActivity);
        adb.sleep(2500);
        captureState(adb, path.join(runDir, 'install-only'), safeName(app.id));
      } catch (error) {
        writeJson(path.join(runDir, 'install-only', `${safeName(app.id)}-error.json`), {
          id: app.id,
          name: app.name,
          packageName: app.packageName,
          error: error.message
        });
        console.warn(`Warning: could not launch ${app.name}: ${error.message}`);
      } finally {
        adb.keyevent('HOME');
      }
    }
  }

  if (!args['skip-arrange']) arrangeHome(adb, launchableApps, runDir);

  adb.saveCommandLog(path.join(runDir, 'adb-commands.json'));
  console.log(`Setup run written to ${runDir}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
