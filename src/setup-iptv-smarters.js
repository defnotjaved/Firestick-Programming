const fs = require('fs');
const path = require('path');
const {
  ensureDir,
  nowStamp,
  parseArgs,
  safeName,
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
  listDevices
} = require('./adb-runner');

const SMARTERS_PACKAGES = [
  'com.nst.iptvsmarterstvbox',
  'com.nst.iptvsmarters',
  'com.whmcs.smarters',
  'com.smarters.player',
  'com.smarterspro'
];

const APPSTORE_PACKAGES = [
  'com.nst.iptvsmarterstvbox',
  'com.nst.iptvsmarters',
  'com.whmcs.smarters'
];

const APPSTORE_SEARCH_URLS = [
  'amzn://apps/android?s=IPTV%20Smarters',
  'amzn://apps/android?s=Smarters%20Player%20Lite',
  'amzn://apps/android?s=IPTV%20Smarters%20Pro'
];

const INSTALL_BUTTONS = [
  /^get$/i,
  /^download$/i,
  /^install$/i,
  /^open$/i,
  /^launch$/i,
  /you own it/i,
  /free download/i
];

const LOGIN_BUTTONS = [
  /login with xtream/i,
  /xtream codes/i,
  /add user/i,
  /^add$/i,
  /^login$/i,
  /^next$/i,
  /^ok$/i,
  /^allow$/i,
  /^save$/i,
  /^live tv$/i,
  /install epg/i,
  /download/i
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

function visibleText(xml) {
  return [...String(xml).matchAll(/\b(?:text|content-desc)="([^"]+)"/gi)]
    .map((match) => match[1].replace(/&amp;/g, '&').replace(/&#10;/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 100);
}

function parseInputs(xml) {
  return [...String(xml).matchAll(/<node\b[^>]*>/gi)]
    .map((match) => match[0])
    .map((node) => {
      const className = (node.match(/\bclass="([^"]*)"/i) || [])[1] || '';
      const text = (node.match(/\btext="([^"]*)"/i) || [])[1] || '';
      const desc = (node.match(/\bcontent-desc="([^"]*)"/i) || [])[1] || '';
      const bounds = (node.match(/\bbounds="([^"]*)"/i) || [])[1] || '';
      const focusable = /\bfocusable="true"/i.test(node);
      const clickable = /\bclickable="true"/i.test(node);
      const center = require('./adb-runner').parseBounds(bounds);
      return { className, text, desc, focusable, clickable, center };
    })
    .filter((node) => node.center && /EditText/i.test(node.className));
}

function installedSmartersPackage(adb) {
  const installed = adb.listPackages();
  return SMARTERS_PACKAGES.find((packageName) => installed.has(packageName)) || '';
}

function chooseDevice(ip) {
  const output = connectDevice('adb', ip).trim();
  const id = ip.includes(':') ? ip : `${ip}:5555`;
  const found = listDevices('adb').find((device) => device.id === id);
  if (!found || found.state !== 'device') {
    throw new Error(`${id} is not authorized. Approve the ADB debugging prompt and rerun.`);
  }
  return { id, output };
}

async function createAccounts(args, runDir, ips) {
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
    throw new Error(`Bouquet "${args.bouquet || 'Trini Classic1'}" was not found. Full bouquet list written to ${path.join(runDir, 'bouquets.json')}`);
  }

  const reseller = await client.reseller();
  const accounts = [];
  for (let index = 0; index < ips.length; index += 1) {
    const ip = ips[index];
    const label = `${args['account-prefix'] || 'gadgetbaytt'}${index + 1}`;
    const notes = `${label} ${ip}`;
    const response = await client.createM3u({
      sub: args.sub || 12,
      pack: bouquet.id,
      country: args.country || 'ALL',
      notes
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
      notes: first.notes || notes,
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
    playlistUrl: account.playlistUrl ? account.playlistUrl.replace(account.password || '__none__', '***') : account.playlistUrl
  })));
  return accounts;
}

function tryInstallFromAppstore(adb, dir) {
  const report = [];
  let installed = installedSmartersPackage(adb);
  if (installed) return { installed, report: [{ action: 'already-installed', packageName: installed }] };

  for (const packageName of APPSTORE_PACKAGES) {
    const url = `amzn://apps/android?p=${packageName}`;
    const entry = { action: 'open-appstore-package', packageName, url };
    try {
      entry.output = adb.openUrl(url).trim();
      adb.sleep(5000);
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const state = captureState(adb, dir, `appstore-${safeName(packageName)}-${attempt}`);
        entry[`visibleText${attempt}`] = visibleText(state.ui);
        const click = findClickableText(state.ui, INSTALL_BUTTONS);
        if (click) {
          entry[`tap${attempt}`] = click;
          adb.tap(click.x, click.y);
          adb.sleep(8000);
        }
        installed = installedSmartersPackage(adb);
        if (installed) {
          entry.installed = installed;
          report.push(entry);
          return { installed, report };
        }
      }
    } catch (error) {
      entry.error = error.message;
    }
    report.push(entry);
  }

  for (const url of APPSTORE_SEARCH_URLS) {
    const entry = { action: 'open-appstore-search', url };
    try {
      entry.output = adb.openUrl(url).trim();
      adb.sleep(5000);
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const state = captureState(adb, dir, `appstore-search-${attempt}`);
        entry[`visibleText${attempt}`] = visibleText(state.ui);
        const click = findClickableText(state.ui, [/iptv smarters/i, /smarters player/i, ...INSTALL_BUTTONS]);
        if (click) {
          entry[`tap${attempt}`] = click;
          adb.tap(click.x, click.y);
          adb.sleep(8000);
        } else {
          adb.keyevent('DPAD_CENTER');
          adb.sleep(5000);
        }
        installed = installedSmartersPackage(adb);
        if (installed) {
          entry.installed = installed;
          report.push(entry);
          return { installed, report };
        }
      }
    } catch (error) {
      entry.error = error.message;
    }
    report.push(entry);
  }

  return { installed: '', report };
}

function loginSmarters(adb, account, packageName, dir) {
  const report = [];
  adb.launch(packageName);
  adb.sleep(8000);

  const values = [
    account.label,
    account.username,
    account.password,
    account.serverUrl
  ];
  let valueIndex = 0;

  for (let attempt = 1; attempt <= 22; attempt += 1) {
    const state = captureState(adb, dir, `login-${attempt}`);
    const text = visibleText(state.ui);
    const joined = text.join(' ');
    const step = { attempt, screenshot: state.screenshot, uiDump: state.uiDump, visibleText: text };

    if (/live tv|install epg|download.*live|dashboard|users/i.test(joined)) {
      step.status = 'logged-in-or-dashboard';
      report.push(step);
      const live = findClickableText(state.ui, [/live tv/i, /install epg/i, /download/i]);
      if (live) {
        step.tap = live;
        adb.tap(live.x, live.y);
        adb.sleep(8000);
        captureState(adb, dir, `after-live-tv-${attempt}`);
      }
      break;
    }

    const button = findClickableText(state.ui, LOGIN_BUTTONS);
    if (button && !/edit/i.test(button.resourceId || '')) {
      step.action = `tap ${button.text}`;
      step.tap = button;
      adb.tap(button.x, button.y);
      adb.sleep(2500);
      report.push(step);
      continue;
    }

    const inputs = parseInputs(state.ui);
    if (inputs.length && valueIndex < values.length) {
      const input = inputs[Math.min(valueIndex, inputs.length - 1)];
      step.action = `type field ${valueIndex + 1}`;
      step.inputBounds = input.center;
      adb.tap(input.center.x, input.center.y);
      adb.sleep(500);
      adb.clearText();
      adb.text(values[valueIndex]);
      adb.sleep(700);
      valueIndex += 1;
      report.push(step);
      continue;
    }

    step.action = 'dpad-center-fallback';
    adb.keyevent('DPAD_CENTER');
    adb.sleep(2500);
    report.push(step);
  }

  adb.keyevent('HOME');
  writeJson(path.join(dir, 'login-report.json'), report);
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  const ips = String(args.ips || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!ips.length) throw new Error('--ips is required, comma-separated.');

  const outputDir = args['output-dir'] || 'C:\\apkapps';
  const runDir = path.join(outputDir, '_runs', `iptv-smarters-${nowStamp()}`);
  ensureDir(runDir);

  const accounts = await createAccounts(args, runDir, ips);
  const accountByIp = new Map(accounts.map((account) => [account.ip, account]));
  const devices = [];

  for (const ip of ips) {
    const deviceDir = path.join(runDir, safeName(ip));
    ensureDir(deviceDir);
    const device = chooseDevice(ip);
    const adb = new AdbRunner({ device: device.id, logDir: deviceDir });
    const deviceReport = { ip, device: device.id, connect: device.output, steps: [] };
    devices.push(deviceReport);

    let packageName = installedSmartersPackage(adb);
    if (!args['skip-appstore'] && !packageName) {
      const install = tryInstallFromAppstore(adb, path.join(deviceDir, 'appstore'));
      packageName = install.installed;
      deviceReport.steps.push({ action: 'appstore-install', packageName, report: install.report });
    } else {
      deviceReport.steps.push({ action: 'appstore-skip-or-installed', packageName });
    }

    if (!packageName) {
      deviceReport.steps.push({ action: 'login-skipped', reason: 'iptv-smarters-not-installed' });
      writeJson(path.join(deviceDir, 'device-report.json'), deviceReport);
      adb.saveCommandLog(path.join(deviceDir, 'adb-commands.json'));
      continue;
    }

    const account = accountByIp.get(ip);
    if (!account || account.status !== 'created') {
      deviceReport.steps.push({ action: 'login-skipped', reason: 'account-not-created', account });
      writeJson(path.join(deviceDir, 'device-report.json'), deviceReport);
      adb.saveCommandLog(path.join(deviceDir, 'adb-commands.json'));
      continue;
    }

    if (!args['skip-login']) {
      const login = loginSmarters(adb, account, packageName, path.join(deviceDir, 'login'));
      deviceReport.steps.push({ action: 'login', packageName, reportPath: path.join(deviceDir, 'login', 'login-report.json'), finalAction: login.at(-1) });
    }

    writeJson(path.join(deviceDir, 'device-report.json'), deviceReport);
    adb.saveCommandLog(path.join(deviceDir, 'adb-commands.json'));
  }

  writeJson(path.join(runDir, 'summary.json'), {
    createdAt: new Date().toISOString(),
    runDir,
    ips,
    accountsPath: path.join(runDir, 'accounts.json'),
    devices
  });
  console.log(`IPTV Smarters run written to ${runDir}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
