const fs = require('fs');
const path = require('path');
const {
  ensureDir,
  nowStamp,
  parseArgs,
  safeName,
  sha256File,
  writeJson
} = require('./common');
const {
  GoldPanelClient,
  findBouquet,
  parseM3uUrl,
  redactSecret
} = require('./gold-panel');
const {
  AdbRunner,
  connectDevice,
  findClickableText,
  listDevices,
  parseBounds
} = require('./adb-runner');

const TIVIMATE_PACKAGE = 'ar.tvplayer.tv';
const TIVIMATE_ACTIVITY = '.ui.MainActivity';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIVIMATE_DIRECT_APK = 'https://files.tivimate.com/tivimate.apk';
const ADB_KEYBOARD_PACKAGE = 'com.android.adbkeyboard';
const ADB_KEYBOARD_IME = 'com.android.adbkeyboard/.AdbIME';
const ADB_KEYBOARD_APK_URL = 'https://raw.githubusercontent.com/senzhk/ADBKeyBoard/master/ADBKeyboard.apk';

const PROMPTS = [
  /^allow$/i,
  /^ok$/i,
  /^continue$/i,
  /^next$/i,
  /^done$/i,
  /^close$/i,
  /^cancel$/i,
  /add playlist/i,
  /xtream codes/i,
  /server address/i,
  /enter url/i,
  /^login$/i,
  /^add$/i,
  /^apply$/i,
  /^save$/i,
  /^finish$/i,
  /tv guide/i,
  /live tv/i
];

function captureState(adb, dir, label) {
  ensureDir(dir);
  const base = safeName(label);
  const screenshot = path.join(dir, `${base}.png`);
  const uiDump = path.join(dir, `${base}.xml`);
  let ui = '';
  try {
    adb.screencap(screenshot);
  } catch (error) {
    fs.writeFileSync(`${screenshot}.error.txt`, error.message, 'utf8');
  }
  try {
    ui = adb.dumpUi(uiDump);
  } catch (error) {
    fs.writeFileSync(`${uiDump}.error.txt`, error.message, 'utf8');
  }
  return { screenshot, uiDump, ui };
}

function readJson(filePath, fallback = null) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function visibleText(xml) {
  return [...String(xml).matchAll(/\b(?:text|content-desc)="([^"]+)"/gi)]
    .map((match) => match[1].replace(/&amp;/g, '&').replace(/&#10;/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 120);
}

function inputs(xml) {
  return [...String(xml).matchAll(/<node\b[^>]*>/gi)]
    .map((match) => match[0])
    .map((node) => ({
      text: (node.match(/\btext="([^"]*)"/i) || [])[1] || '',
      desc: (node.match(/\bcontent-desc="([^"]*)"/i) || [])[1] || '',
      className: (node.match(/\bclass="([^"]*)"/i) || [])[1] || '',
      resourceId: (node.match(/\bresource-id="([^"]*)"/i) || [])[1] || '',
      center: parseBounds((node.match(/\bbounds="([^"]*)"/i) || [])[1] || '')
    }))
    .filter((node) => node.center && /EditText/i.test(node.className));
}

function chooseDevice(ip) {
  const output = connectDevice('adb', ip).trim();
  const id = ip.includes(':') ? ip : `${ip}:5555`;
  const found = listDevices('adb').find((device) => device.id === id);
  if (!found || found.state !== 'device') throw new Error(`${id} is not authorized.`);
  return { id, output };
}

function waitForDevice(ip, minutes = 0) {
  const deadline = Date.now() + Math.max(0, Number(minutes || 0)) * 60 * 1000;
  let lastOutput = '';
  do {
    try {
      lastOutput = connectDevice('adb', ip).trim();
    } catch (error) {
      lastOutput = error.message;
    }
    const id = ip.includes(':') ? ip : `${ip}:5555`;
    const found = listDevices('adb').find((device) => device.id === id);
    if (found && found.state === 'device') return { id, output: lastOutput };
    if (!minutes || Date.now() >= deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  } while (Date.now() < deadline);
  throw new Error(`${ip.includes(':') ? ip : `${ip}:5555`} is not authorized.`);
}

async function resolveDownloaderCode(code) {
  const url = `https://go.aftvnews.com/${code}`;
  const response = await fetch(url, {
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'referer': 'https://www.aftvnews.com/',
      'user-agent': USER_AGENT
    }
  });
  if (!response.ok) {
    if (code === '272483') return TIVIMATE_DIRECT_APK;
    throw new Error(`HTTP ${response.status} resolving Downloader code ${code}`);
  }
  const html = await response.text();
  const apk = html.match(/https?:\/\/[^\s"'<>]+\.apk(?:[^\s"'<>]*)?/i);
  if (!apk) {
    if (code === '272483') return TIVIMATE_DIRECT_APK;
    throw new Error(`Downloader code ${code} did not expose an APK link.`);
  }
  return apk[0];
}

async function downloadApk(url, destination) {
  if (fs.existsSync(destination) && fs.statSync(destination).size > 1024 * 1024) return destination;
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${url}`);
  ensureDir(path.dirname(destination));
  const temp = `${destination}.download`;
  fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(temp, destination);
  return destination;
}

async function ensureTivimateApk(args, runDir) {
  const code = args['downloader-code'] || '272483';
  const apkUrl = await resolveDownloaderCode(code);
  const apkPath = path.join(args['output-dir'] || 'C:\\apkapps', `TiviMate-${code}.apk`);
  await downloadApk(apkUrl, apkPath);
  writeJson(path.join(runDir, 'tivimate-apk.json'), {
    downloaderCode: code,
    apkUrl,
    apkPath,
    sha256: sha256File(apkPath),
    bytes: fs.statSync(apkPath).size
  });
  return apkPath;
}

async function createAccounts(args, runDir, ips) {
  if (args['accounts-file']) {
    const source = path.resolve(String(args['accounts-file']));
    const accounts = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (!Array.isArray(accounts)) throw new Error(`--accounts-file must contain an array: ${source}`);
    writeJson(path.join(runDir, 'accounts.json'), accounts);
    writeJson(path.join(runDir, 'accounts-redacted.json'), accounts.map((account) => ({
      ...account,
      password: account.password ? redactSecret(account.password) : account.password,
      playlistUrl: account.playlistUrl && account.password ? account.playlistUrl.replace(account.password, '***') : account.playlistUrl
    })));
    return accounts;
  }
  if (args['skip-create-accounts']) return [];
  const client = new GoldPanelClient();
  const bouquets = await client.bouquets();
  if (!Array.isArray(bouquets)) {
    writeJson(path.join(runDir, 'bouquets-error.json'), bouquets);
    throw new Error(`Gold Panel bouquet lookup failed: ${JSON.stringify(bouquets)}`);
  }
  const bouquet = findBouquet(bouquets, args.bouquet || 'Trini Classic1');
  if (!bouquet) {
    writeJson(path.join(runDir, 'bouquets.json'), bouquets);
    throw new Error(`Bouquet "${args.bouquet || 'Trini Classic1'}" was not found.`);
  }

  const reseller = await client.reseller();
  const accounts = [];
  const accountStartIndex = Number(args['account-start-index'] || 1);
  for (let index = 0; index < ips.length; index += 1) {
    const ip = ips[index];
    const label = `${args['account-prefix'] || 'gadgetbaytt'}${accountStartIndex + index}`;
    const response = await client.createM3u({
      sub: args.sub || 12,
      pack: bouquet.id,
      country: args.country || 'ALL',
      notes: `${label} ${ip}`
    });
    const first = Array.isArray(response) ? response[0] : response;
    if (!first || String(first.status).toLowerCase() !== 'true' || !first.url) {
      accounts.push({ ip, label, status: 'failed', response });
      continue;
    }
    accounts.push({
      ip,
      label,
      status: 'created',
      bouquet,
      userId: first.user_id,
      country: first.country,
      notes: first.notes || `${label} ${ip}`,
      ...parseM3uUrl(first.url)
    });
  }

  writeJson(path.join(runDir, 'reseller-redacted.json'), {
    apiKey: redactSecret(process.env.GOLD_PANEL_API_KEY),
    response: reseller
  });
  writeJson(path.join(runDir, 'accounts.json'), accounts);
  writeJson(path.join(runDir, 'accounts-redacted.json'), accounts.map((account) => ({
    ...account,
    password: account.password ? redactSecret(account.password) : account.password,
    playlistUrl: account.playlistUrl && account.password ? account.playlistUrl.replace(account.password, '***') : account.playlistUrl
  })));
  return accounts;
}

function packageInstalled(adb, packageName) {
  return adb.listPackages().has(packageName);
}

function statePathFor(outputDir, ip) {
  return path.join(outputDir || 'C:\\apkapps', '_state', `tivimate-${safeName(ip)}.json`);
}

function loadDeviceState(outputDir, ip) {
  return readJson(statePathFor(outputDir, ip), {});
}

function saveDeviceState(outputDir, ip, state) {
  writeJson(statePathFor(outputDir, ip), {
    ...state,
    updatedAt: new Date().toISOString()
  });
}

function normalizePortal(value) {
  if (!value) return '';
  const text = String(value).trim();
  if (!text) return '';
  return /^https?:\/\//i.test(text) ? text.replace(/\/+$/, '') : `http://${text.replace(/\/+$/, '')}`;
}

function loadPortalMap(args, outputDir) {
  const source = args['portal-map'] || process.env.TIVIMATE_PORTAL_MAP || path.join(outputDir || 'C:\\apkapps', 'tivimate-portals.json');
  if (!source || !fs.existsSync(source)) return { source, values: new Map() };
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  const values = new Map();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const username = item && (item.username || item.user);
      const portal = item && (item.portalUrl || item.serverUrl || item.url || item.wdCard);
      if (username && portal) values.set(String(username), normalizePortal(portal));
    }
  } else {
    for (const [username, portal] of Object.entries(raw || {})) {
      if (username && portal) values.set(String(username), normalizePortal(portal));
    }
  }
  return { source, values };
}

function resolvePortalForAccount(account, options = {}) {
  const portal = normalizePortal(
    options.serverUrl
      || account.portalUrl
      || account.xtreamServerUrl
      || account.wdCardServerUrl
      || (options.portalMap && options.portalMap.get(String(account.username)))
  );
  if (!portal) {
    const source = options.portalMapSource || 'C:\\apkapps\\tivimate-portals.json';
    throw new Error(
      `Missing TiviMate portal for username ${account.username}. ` +
      `Open cms-8k.net/users?t=lines, click Link > wd-card for that username, then add it to ${source}.`
    );
  }
  return portal;
}

async function ensureAdbKeyboardApk(outputDir) {
  const apkPath = path.join(outputDir || 'C:\\apkapps', 'ADBKeyboard.apk');
  await downloadApk(ADB_KEYBOARD_APK_URL, apkPath);
  return apkPath;
}

function enableAdbKeyboard(adb, apkPath) {
  const steps = [];
  if (!packageInstalled(adb, ADB_KEYBOARD_PACKAGE)) {
    steps.push({ action: 'install-adb-keyboard', output: adb.install(apkPath).trim() });
  }
  steps.push({ action: 'enable-adb-keyboard', output: adb.shell(`ime enable ${ADB_KEYBOARD_IME}`, { allowFailure: true }).trim() });
  steps.push({ action: 'set-adb-keyboard', output: adb.shell(`ime set ${ADB_KEYBOARD_IME}`, { allowFailure: true }).trim() });
  return steps;
}

function installTivimate(adb, apkPath) {
  if (packageInstalled(adb, TIVIMATE_PACKAGE)) return { status: 'already-installed', packageName: TIVIMATE_PACKAGE };
  return {
    status: 'installed',
    packageName: TIVIMATE_PACKAGE,
    output: adb.install(apkPath).trim()
  };
}

function captureStep(adb, dir, report, label, action = {}) {
  const state = captureState(adb, dir, label);
  const text = visibleText(state.ui);
  const step = {
    label,
    screenshot: state.screenshot,
    uiDump: state.uiDump,
    visibleText: text,
    ...action
  };
  report.push(step);
  return { ...state, text, joined: text.join(' '), step };
}

function tapTextOrPoint(adb, xml, patterns, fallback, step) {
  const target = findClickableText(xml, patterns);
  const point = target || fallback;
  if (!point) return false;
  step.tap = target || { text: 'fallback-point', ...fallback };
  adb.tap(point.x, point.y);
  return true;
}

function closeEditor(adb) {
  adb.keyevent('BACK');
  adb.sleep(1800);
}

function typeXtreamDialogValue(adb, dir, report, label, rowPoint, value) {
  const before = captureStep(adb, dir, report, `xtream-${safeName(label)}-before`, { action: `open-${label}` });
  adb.tap(rowPoint.x, rowPoint.y);
  adb.sleep(1200);
  captureStep(adb, dir, report, `xtream-${safeName(label)}-editor`, { action: `editor-${label}` });
  adb.clearText(120);
  adb.text(value);
  adb.sleep(1000);
  captureStep(adb, dir, report, `xtream-${safeName(label)}-typed`, { action: `typed-${label}` });
  closeEditor(adb);
  captureStep(adb, dir, report, `xtream-${safeName(label)}-saved`, { action: `saved-${label}`, from: before.screenshot });
}

function looksLikeTivimateGuide(text) {
  return /all playlists|tv guide|movies|series|live tv|channels|search|settings/i.test(text)
    && !/error|failed|server address|username|password|playlist is processed|processing|please wait|add playlist|doesn't provide/i.test(text);
}

function verifyTivimateGuide(adb, dir, label = 'verify-guide') {
  adb.keyevent(224);
  adb.launch(TIVIMATE_PACKAGE, TIVIMATE_ACTIVITY);
  adb.sleep(8000);
  for (let index = 1; index <= 12; index += 1) {
    adb.keyevent(224);
    const state = captureState(adb, dir, `${label}-${index}`);
    const text = visibleText(state.ui);
    const joined = text.join(' ');
    if (looksLikeTivimateGuide(joined)) {
      return {
        verified: true,
        screenshot: state.screenshot,
        uiDump: state.uiDump,
        visibleText: text
      };
    }
    if (/playlist is processed/i.test(joined)) {
      const done = findClickableText(state.ui, [/^Done$/i]);
      if (done) adb.tap(done.x, done.y);
    }
    adb.sleep(10000);
  }
  const final = captureState(adb, dir, `${label}-final`);
  return {
    verified: false,
    screenshot: final.screenshot,
    uiDump: final.uiDump,
    visibleText: visibleText(final.ui)
  };
}

function loginTivimate(adb, account, dir, options = {}) {
  const report = [];
  const serverUrl = resolvePortalForAccount(account, options);
  if (options.fresh) adb.shell(`pm clear ${TIVIMATE_PACKAGE}`, { allowFailure: true });
  adb.keyevent(224);
  adb.launch(TIVIMATE_PACKAGE, TIVIMATE_ACTIVITY);
  adb.sleep(7000);

  let state = captureStep(adb, dir, report, '01-launched', { action: 'launch-tivimate' });
  if (/doesn't provide|add a playlist|Add playlist/i.test(state.joined)) {
    const step = captureStep(adb, dir, report, '02-before-add-playlist', { action: 'tap-add-playlist' }).step;
    tapTextOrPoint(adb, state.ui, [/add playlist/i], { x: 862, y: 640 }, step);
    adb.sleep(2500);
  }

  state = captureStep(adb, dir, report, '03-playlist-type', { action: 'choose-xtream-codes' });
  tapTextOrPoint(adb, state.ui, [/xtream codes/i], { x: 1278, y: 525 }, state.step);
  adb.sleep(2500);

  captureStep(adb, dir, report, '04-xtream-form', { action: 'form-visible' });
  typeXtreamDialogValue(adb, dir, report, 'server-address', { x: 1278, y: 422 }, serverUrl);
  typeXtreamDialogValue(adb, dir, report, 'username', { x: 1278, y: 565 }, account.username);
  typeXtreamDialogValue(adb, dir, report, 'password', { x: 1278, y: 563 }, account.password);

  state = captureStep(adb, dir, report, '08-before-submit', { action: 'submit-xtream-codes' });
  tapTextOrPoint(adb, state.ui, [/^Next$/i], { x: 1767, y: 421 }, state.step);
  adb.sleep(12000);

  let tappedDone = false;
  for (let index = 1; index <= 36; index += 1) {
    adb.keyevent(224);
    state = captureStep(adb, dir, report, `09-after-submit-${index}`, { action: 'post-submit-check' });
    if (looksLikeTivimateGuide(state.joined)) {
      state.step.status = 'verified-open';
      break;
    }
    const click = findClickableText(state.ui, [/^Next$/i, /^Done$/i, /^Finish$/i, /^OK$/i, /tv guide/i, /live tv/i]);
    if (!click) {
      adb.sleep(/processing|please wait|playlist is processed/i.test(state.joined) ? 10000 : 6000);
      continue;
    }
    if (/^done$/i.test(click.text || '') && tappedDone && !/please wait/i.test(state.joined) && index % 6 !== 0) {
      adb.sleep(10000);
      continue;
    }
    if (/^done$/i.test(click.text || '')) tappedDone = true;
    state.step.tap = click;
    adb.tap(click.x, click.y);
    adb.sleep(/processing|please wait|playlist is processed/i.test(state.joined) ? 10000 : 6000);
  }

  adb.keyevent(224);
  captureStep(adb, dir, report, 'final', { action: 'final-capture' });
  writeJson(path.join(dir, 'login-report.json'), report);
  return { report, serverUrl, verified: report.some((step) => step.status === 'verified-open') };
}

async function main() {
  const args = parseArgs(process.argv);
  const ips = String(args.ips || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!ips.length) throw new Error('--ips is required.');
  const outputDir = args['output-dir'] || 'C:\\apkapps';
  const waitForAuthMinutes = Number(args['wait-for-auth-minutes'] || 0);
  const runDir = path.join(outputDir, '_runs', `tivimate-${nowStamp()}`);
  ensureDir(runDir);

  const accounts = await createAccounts(args, runDir, ips);
  const accountByIp = new Map(accounts.map((account) => [account.ip, account]));
  const apkPath = args['skip-install'] ? '' : await ensureTivimateApk(args, runDir);
  const adbKeyboardApkPath = args['skip-login'] ? '' : await ensureAdbKeyboardApk(outputDir);
  const portalMap = loadPortalMap(args, outputDir);
  const devices = [];

  for (const ip of ips) {
    const deviceDir = path.join(runDir, safeName(ip));
    ensureDir(deviceDir);
    const device = waitForAuthMinutes ? waitForDevice(ip, waitForAuthMinutes) : chooseDevice(ip);
    const adb = new AdbRunner({ device: device.id, logDir: deviceDir });
    const account = accountByIp.get(ip);
    const persistedState = loadDeviceState(outputDir, ip);
    const deviceReport = { ip, device: device.id, connect: device.output, accountLabel: account && account.label, steps: [] };

    if (!args['skip-install']) {
      try {
        if (persistedState.tivimateInstalled && packageInstalled(adb, TIVIMATE_PACKAGE)) {
          deviceReport.steps.push({ action: 'install-tivimate', status: 'skipped-state', packageName: TIVIMATE_PACKAGE });
        } else {
          const install = installTivimate(adb, apkPath);
          deviceReport.steps.push({ action: 'install-tivimate', ...install });
          persistedState.tivimateInstalled = true;
          persistedState.tivimateInstalledAt = new Date().toISOString();
        }
      } catch (error) {
        deviceReport.steps.push({ action: 'install-tivimate', status: 'failed', error: error.message });
      }
    }

    if (!packageInstalled(adb, TIVIMATE_PACKAGE)) {
      deviceReport.steps.push({ action: 'login-skipped', reason: 'tivimate-not-installed' });
    } else if (args['skip-login']) {
      deviceReport.steps.push({ action: 'login-skipped', reason: 'skip-login' });
    } else if (!account || account.status !== 'created') {
      deviceReport.steps.push({ action: 'login-skipped', reason: 'account-not-created', account });
    } else {
      try {
        if (persistedState.adbKeyboardReady && packageInstalled(adb, ADB_KEYBOARD_PACKAGE)) {
          deviceReport.steps.push({ action: 'enable-adb-keyboard', status: 'skipped-state' });
        } else {
          deviceReport.steps.push(...enableAdbKeyboard(adb, adbKeyboardApkPath));
          persistedState.adbKeyboardReady = true;
          persistedState.adbKeyboardReadyAt = new Date().toISOString();
        }
      } catch (error) {
        deviceReport.steps.push({ action: 'enable-adb-keyboard', status: 'failed', error: error.message });
      }
      const serverUrl = resolvePortalForAccount(account, {
        serverUrl: args['server-url'],
        portalMap: portalMap.values,
        portalMapSource: portalMap.source
      });
      const sameLogin = persistedState.login
        && persistedState.login.username === account.username
        && persistedState.login.serverUrl === serverUrl
        && !args.fresh;
      if (sameLogin) {
        const verification = verifyTivimateGuide(adb, path.join(deviceDir, 'verify'), 'resume');
        deviceReport.steps.push({ action: 'login-tivimate', status: verification.verified ? 'skipped-verified' : 'resume-verification-failed', verification });
        if (!verification.verified) {
          persistedState.login = undefined;
        }
      }
      if (!sameLogin && !persistedState.login && !args.fresh) {
        const verification = verifyTivimateGuide(adb, path.join(deviceDir, 'verify'), 'bootstrap');
        if (verification.verified) {
          persistedState.login = {
            username: account.username,
            serverUrl,
            verifiedAt: new Date().toISOString(),
            inferredFromGuide: true
          };
          deviceReport.steps.push({ action: 'login-tivimate', status: 'skipped-existing-guide', verification });
        }
      }
      if (!persistedState.login || !sameLogin || args.fresh) {
        if (!persistedState.login || args.fresh) {
          const login = loginTivimate(adb, account, path.join(deviceDir, 'login'), {
            fresh: Boolean(args.fresh),
            serverUrl: args['server-url'],
            portalMap: portalMap.values,
            portalMapSource: portalMap.source
          });
          if (login.verified) {
            persistedState.login = {
              username: account.username,
              serverUrl: login.serverUrl,
              verifiedAt: new Date().toISOString()
            };
          }
          deviceReport.steps.push({
            action: 'login-tivimate',
            status: login.verified ? 'verified' : 'needs-review',
            reportPath: path.join(deviceDir, 'login', 'login-report.json'),
            finalStep: login.report.at(-1)
          });
        }
      }
    }

    saveDeviceState(outputDir, ip, persistedState);
    writeJson(path.join(deviceDir, 'device-report.json'), deviceReport);
    adb.saveCommandLog(path.join(deviceDir, 'adb-commands.json'));
    devices.push(deviceReport);
  }

  writeJson(path.join(runDir, 'summary.json'), {
    createdAt: new Date().toISOString(),
    runDir,
    ips,
    accountsPath: path.join(runDir, 'accounts.json'),
    devices
  });
  console.log(`TiviMate run written to ${runDir}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
