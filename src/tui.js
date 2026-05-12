const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const {
  appApkPath,
  expandPath,
  loadManifest,
  nowStamp,
  parseArgs,
  sha256File,
  validateManifest,
  writeJson
} = require('./common');
const { adbExists, connectDevice, listDevices } = require('./adb-runner');

const DEFAULT_MANIFEST = path.join(__dirname, '..', 'firetv-apps.json');

function clear() {
  process.stdout.write('\x1Bc');
}

function runNode(script, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: path.join(__dirname, '..'),
      stdio: options.stdio || 'inherit'
    });
    child.on('exit', (code) => resolve(code));
  });
}

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: path.join(__dirname, '..'),
      stdio: options.stdio || 'inherit'
    });
    child.on('exit', (code) => resolve(code));
  });
}

function readApks(apkDir) {
  if (!fs.existsSync(apkDir)) return [];
  return fs.readdirSync(apkDir)
    .filter((name) => /\.apk$/i.test(name))
    .map((name) => {
      const fullPath = path.join(apkDir, name);
      const stat = fs.statSync(fullPath);
      return { name, fullPath, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function findLatestAccountsFile(apkDir) {
  const runsDir = path.join(apkDir, '_runs');
  if (!fs.existsSync(runsDir)) return '';
  const candidates = [];
  for (const run of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!run.isDirectory() || !/^tivimate-/i.test(run.name)) continue;
    const accountsPath = path.join(runsDir, run.name, 'accounts.json');
    if (!fs.existsSync(accountsPath)) continue;
    const stat = fs.statSync(accountsPath);
    candidates.push({ accountsPath, mtime: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ? candidates[0].accountsPath : '';
}

function parseIps(value) {
  return String(value || '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean);
}

function getApkDir(manifest) {
  return path.resolve(expandPath(manifest.downloadsDir || 'C:\\apkapps'));
}

function statusForApps(manifest, apkDir) {
  const validation = validateManifest(manifest, { includeOptional: false });
  const apps = validation.selectedApps.map((app) => {
    const apkPath = appApkPath(app, apkDir);
    return {
      id: app.id,
      name: app.name,
      category: app.category,
      apkPath,
      exists: fs.existsSync(apkPath),
      sha256: fs.existsSync(apkPath) ? sha256File(apkPath) : null
    };
  });
  return { errors: validation.errors, apps };
}

async function promptDevices(rl) {
  if (!adbExists('adb')) {
    console.log('ADB is not on PATH, so device discovery/setup cannot run yet.');
    console.log('Install Android Platform Tools: https://developer.android.com/tools/releases/platform-tools');
    await rl.question('Press Enter to continue...');
    return [];
  }

  const ipText = await rl.question('Fire TV IPs to connect, comma-separated (blank to skip): ');
  const ips = ipText.split(',').map((value) => value.trim()).filter(Boolean);
  for (const ip of ips) {
    try {
      console.log(connectDevice('adb', ip).trim());
    } catch (error) {
      console.log(`Could not connect ${ip}: ${error.message}`);
    }
  }

  const devices = listDevices('adb').filter((device) => device.state === 'device');
  if (!devices.length) {
    console.log('No authorized devices found.');
    await rl.question('Press Enter to continue...');
    return [];
  }

  console.log('\nConnected devices:');
  devices.forEach((device, index) => console.log(`${index + 1}. ${device.id}`));
  const choice = await rl.question('Run on which devices? Use "all" or comma-separated numbers: ');
  if (choice.trim().toLowerCase() === 'all') return devices.map((device) => device.id);
  return choice
    .split(',')
    .map((value) => Number(value.trim()) - 1)
    .filter((index) => Number.isInteger(index) && devices[index])
    .map((index) => devices[index].id);
}

async function runMultiSetup(rl, manifestPath, manifest, apkDir) {
  const devices = await promptDevices(rl);
  if (!devices.length) return;

  const mode = (await rl.question('Mode [unattended/install-only/guarded] (default unattended): ')).trim() || 'unattended';
  const validModes = new Set(['unattended', 'install-only', 'guarded']);
  if (!validModes.has(mode)) {
    console.log(`Unsupported mode: ${mode}`);
    await rl.question('Press Enter to continue...');
    return;
  }

  const runRoot = path.join(apkDir, '_runs', `multi-${nowStamp()}`);
  fs.mkdirSync(runRoot, { recursive: true });
  writeJson(path.join(runRoot, 'devices.json'), { devices, mode, startedAt: new Date().toISOString() });

  console.log(`\nStarting ${devices.length} parallel setup run(s). Logs: ${runRoot}\n`);
  const setupScript = path.join(__dirname, 'setup-firetv.js');
  const children = devices.map((device) => {
    const logPath = path.join(runRoot, `${device.replace(/[^a-z0-9._-]+/gi, '-')}.log`);
    const log = fs.createWriteStream(logPath, { flags: 'a' });
    const args = [setupScript, '--manifest', manifestPath, '--apk-dir', apkDir, '--device', device, '--mode', mode, '--allow-missing'];
    const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..') });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on('exit', (code) => {
      log.write(`\nExited with code ${code}\n`);
      log.end();
      console.log(`${device} finished with code ${code}. Log: ${logPath}`);
    });
    return new Promise((resolve) => child.on('exit', (code) => resolve({ device, code, logPath })));
  });

  const results = await Promise.all(children);
  writeJson(path.join(runRoot, 'summary.json'), { finishedAt: new Date().toISOString(), results });
  await rl.question('\nAll selected device runs finished. Press Enter to continue...');
}

async function runFastTivimateSetup(rl, apkDir) {
  clear();
  console.log('Fast TiviMate Setup');
  console.log('===================\n');
  console.log('Paste Firestick IPs separated by commas. Example: 192.168.1.202,192.168.1.206\n');

  const ipText = await rl.question('Firestick IPs: ');
  const ips = parseIps(ipText);
  if (!ips.length) {
    console.log('No IPs entered.');
    await rl.question('Press Enter to continue...');
    return;
  }

  const defaultAccounts = findLatestAccountsFile(apkDir);
  const defaultPortalMap = path.join(apkDir, 'tivimate-portals.json');
  console.log('');
  if (defaultAccounts) console.log(`Default accounts file: ${defaultAccounts}`);
  console.log(`Default portal map: ${defaultPortalMap}`);

  const accountsAnswer = await rl.question('Accounts file (blank for default/latest): ');
  const accountsFile = path.resolve(expandPath(accountsAnswer.trim() || defaultAccounts));
  if (!accountsFile || !fs.existsSync(accountsFile)) {
    console.log(`Accounts file not found: ${accountsFile || '(none)'}`);
    await rl.question('Press Enter to continue...');
    return;
  }

  const portalAnswer = await rl.question('Portal map JSON (blank for default): ');
  const portalMap = path.resolve(expandPath(portalAnswer.trim() || defaultPortalMap));
  if (!fs.existsSync(portalMap)) {
    console.log(`Portal map not found: ${portalMap}`);
    await rl.question('Press Enter to continue...');
    return;
  }

  const freshAnswer = (await rl.question('Fresh reset TiviMate first? [y/N]: ')).trim().toLowerCase();
  const waitAnswer = (await rl.question('Minutes to wait for ADB authorization (default 30): ')).trim();
  const waitMinutes = waitAnswer ? Number(waitAnswer) : 30;
  if (!Number.isFinite(waitMinutes) || waitMinutes < 0) {
    console.log('Invalid wait time.');
    await rl.question('Press Enter to continue...');
    return;
  }

  const args = [
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, '..', 'setup-tivimate.ps1'),
    '-Ips', ips.join(','),
    '-AccountsFile', accountsFile,
    '-PortalMap', portalMap,
    '-Parallel',
    '-WaitForAuthMinutes', String(waitMinutes)
  ];
  if (freshAnswer === 'y' || freshAnswer === 'yes') args.push('-Fresh');

  console.log('\nStarting fast TiviMate setup...');
  console.log(`IPs: ${ips.join(', ')}`);
  console.log(`Accounts: ${accountsFile}`);
  console.log(`Portal map: ${portalMap}`);
  console.log(`Mode: ${args.includes('-Fresh') ? 'fresh reset' : 'resumable fast'}\n`);

  const code = await runCommand('powershell', args);
  console.log(`\nFast TiviMate setup exited with code ${code}.`);
  await rl.question('Press Enter to continue...');
}

async function printStatus(rl, manifest, apkDir) {
  clear();
  const apks = readApks(apkDir);
  const status = statusForApps(manifest, apkDir);
  console.log('Fire TV Provisioning Status');
  console.log('===========================\n');
  console.log(`APK folder: ${apkDir}`);
  console.log(`Raw APKs found: ${apks.length}\n`);

  if (status.errors.length) {
    console.log('Manifest errors:');
    status.errors.forEach((error) => console.log(`- ${error}`));
    console.log('');
  }

  console.log('Required manifest apps:');
  for (const app of status.apps) {
    console.log(`${app.exists ? '[x]' : '[ ]'} ${app.category.padEnd(8)} ${app.name} -> ${path.basename(app.apkPath)}`);
  }

  console.log('\nFolder APKs:');
  apks.forEach((apk) => console.log(`- ${apk.name} (${Math.round(apk.bytes / 1024 / 1024)} MB)`));
  await rl.question('\nPress Enter to continue...');
}

async function main() {
  const args = parseArgs(process.argv);
  const manifestPath = path.resolve(expandPath(args.manifest || DEFAULT_MANIFEST));
  const manifest = loadManifest(manifestPath);
  const apkDir = getApkDir(manifest);
  fs.mkdirSync(apkDir, { recursive: true });

  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      clear();
      console.log('GadgetBayTT Fire TV Provisioning');
      console.log('================================\n');
      console.log(`Manifest: ${manifestPath}`);
      console.log(`APK folder: ${apkDir}\n`);
      console.log('1. Status / scan APK folder');
      console.log('2. Download missing APKs');
      console.log('3. Dry-run downloader');
      console.log('4. Connect/list ADB devices');
      console.log('5. Run setup on multiple Fire TVs simultaneously');
      console.log('6. Fast TiviMate setup/program Firesticks');
      console.log('7. Open APK folder in Explorer');
      console.log('0. Exit\n');

      const choice = (await rl.question('Choose: ')).trim();
      if (choice === '0') break;
      if (choice === '1') await printStatus(rl, manifest, apkDir);
      if (choice === '2') {
        await runNode(path.join(__dirname, 'download-apks.js'), ['--manifest', manifestPath, '--output', apkDir]);
        await rl.question('Press Enter to continue...');
      }
      if (choice === '3') {
        await runNode(path.join(__dirname, 'download-apks.js'), ['--manifest', manifestPath, '--output', apkDir, '--dry-run']);
        await rl.question('Press Enter to continue...');
      }
      if (choice === '4') {
        await promptDevices(rl);
      }
      if (choice === '5') {
        await runMultiSetup(rl, manifestPath, manifest, apkDir);
      }
      if (choice === '6') {
        await runFastTivimateSetup(rl, apkDir);
      }
      if (choice === '7') {
        spawnSync('explorer.exe', [apkDir], { stdio: 'ignore' });
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
