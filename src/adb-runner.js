const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureDir, writeJson } = require('./common');

const KEY = {
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  MENU: 82,
  MOVE_HOME: 122,
  ENTER: 66
};

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

class AdbRunner {
  constructor(options = {}) {
    this.adb = options.adb || 'adb';
    this.device = options.device || '';
    this.logDir = options.logDir || process.cwd();
    this.commandLog = [];
  }

  adbArgs(args) {
    return this.device ? ['-s', this.device, ...args] : args;
  }

  run(args, options = {}) {
    const finalArgs = this.adbArgs(args);
    const startedAt = new Date().toISOString();
    const result = spawnSync(this.adb, finalArgs, {
      encoding: options.encoding || 'utf8',
      timeout: options.timeoutMs || 60000,
      maxBuffer: options.maxBuffer || 20 * 1024 * 1024
    });

    const entry = {
      startedAt,
      command: `${this.adb} ${finalArgs.join(' ')}`,
      status: result.status,
      error: result.error ? result.error.message : undefined,
      stderr: typeof result.stderr === 'string' ? result.stderr.trim() : undefined
    };
    this.commandLog.push(entry);

    if (result.error) throw result.error;
    if (result.status !== 0 && !options.allowFailure) {
      throw new Error(`${entry.command} failed: ${entry.stderr || result.stdout || 'unknown error'}`);
    }
    return result.stdout;
  }

  shell(command, options = {}) {
    return this.run(['shell', command], options);
  }

  keyevent(key) {
    const code = typeof key === 'number' ? key : KEY[key];
    if (!code) throw new Error(`Unknown keyevent "${key}".`);
    return this.shell(`input keyevent ${code}`);
  }

  tap(x, y) {
    return this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  text(value) {
    const escaped = String(value).replace(/%/g, '%25').replace(/\s/g, '%s').replace(/"/g, '\\"');
    return this.shell(`input text "${escaped}"`);
  }

  adbKeyboardText(value) {
    return this.shell(`am broadcast -a ADB_INPUT_TEXT --es msg ${shellQuote(value)}`, { timeoutMs: 30000 });
  }

  clearText(count = 80) {
    for (let i = 0; i < count; i += 1) this.keyevent(67);
  }

  sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  install(apkPath) {
    return this.run(['install', '-r', '-d', apkPath], { timeoutMs: 240000 });
  }

  uninstall(packageName) {
    return this.run(['uninstall', packageName], { timeoutMs: 120000 });
  }

  grantCommonPermissions(packageName) {
    const permissions = [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.POST_NOTIFICATIONS'
    ];
    return permissions.map((permission) => ({
      permission,
      output: this.shell(`pm grant ${packageName} ${permission}`, { allowFailure: true }).trim()
    }));
  }

  packagePath(packageName) {
    return this.shell(`pm path ${packageName}`, { allowFailure: true }).trim();
  }

  listPackages() {
    return new Set(
      this.shell('pm list packages -3', { allowFailure: true })
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^package:/, ''))
        .filter(Boolean)
    );
  }

  currentPackage() {
    const output = this.shell('dumpsys window windows | grep -E "mCurrentFocus|mFocusedApp"', { allowFailure: true });
    const match = String(output).match(/\b([a-zA-Z0-9_.]+)\/[a-zA-Z0-9_.$]+/);
    return match ? match[1] : '';
  }

  resolveActivity(packageName) {
    const commands = [
      `cmd package resolve-activity --brief ${packageName}`,
      `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${packageName}`,
      `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER -p ${packageName}`,
      `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${packageName}`
    ];
    for (const command of commands) {
      const output = this.shell(command, { allowFailure: true }).trim();
      const line = output
        .split(/\r?\n/)
        .map((value) => value.trim())
        .reverse()
        .find((value) => value.includes('/'));
      if (line && !/No activity found/i.test(line)) return line;
    }
    const packageDump = this.shell(`dumpsys package ${packageName}`, { allowFailure: true });
    const component = String(packageDump).match(new RegExp(`${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/[^\\s]+`));
    if (component) return component[0];
    return '';
  }

  launch(packageName, activity) {
    if (activity) return this.shell(`am start -n ${packageName}/${activity}`);
    const component = this.resolveActivity(packageName);
    if (component) return this.shell(`am start -n ${component}`, { timeoutMs: 30000 });
    return this.shell(`monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`, { timeoutMs: 30000 });
  }

  openUrl(url) {
    const escaped = String(url).replace(/"/g, '\\"');
    return this.shell(`am start -a android.intent.action.VIEW -d "${escaped}"`, { timeoutMs: 30000 });
  }

  startSettingsUnknownSources() {
    const intents = [
      'am start -a android.settings.MANAGE_UNKNOWN_APP_SOURCES',
      'am start -a android.settings.SECURITY_SETTINGS',
      'am start -n com.amazon.tv.settings/.MainSettingsActivity'
    ];
    for (const intent of intents) {
      const output = this.shell(intent, { allowFailure: true });
      if (!/Error|Exception|not found/i.test(output)) return output;
    }
    return '';
  }

  screencap(filePath) {
    ensureDir(path.dirname(filePath));
    const finalArgs = this.adbArgs(['exec-out', 'screencap', '-p']);
    const result = spawnSync(this.adb, finalArgs, {
      encoding: 'buffer',
      timeout: 30000,
      maxBuffer: 20 * 1024 * 1024
    });
    this.commandLog.push({
      startedAt: new Date().toISOString(),
      command: `${this.adb} ${finalArgs.join(' ')}`,
      status: result.status,
      error: result.error ? result.error.message : undefined
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`screencap failed: ${result.stderr ? result.stderr.toString() : 'unknown error'}`);
    fs.writeFileSync(filePath, result.stdout);
    return filePath;
  }

  dumpUi(filePath) {
    ensureDir(path.dirname(filePath));
    this.shell('uiautomator dump /sdcard/window_dump.xml', { allowFailure: true });
    const xml = this.run(['exec-out', 'cat', '/sdcard/window_dump.xml'], { allowFailure: true, timeoutMs: 30000 });
    fs.writeFileSync(filePath, xml || '', 'utf8');
    return xml || '';
  }

  saveCommandLog(filePath) {
    writeJson(filePath, this.commandLog);
  }
}

function adbExists(adb = 'adb') {
  try {
    execFileSync(adb, ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function listDevices(adb = 'adb') {
  const output = execFileSync(adb, ['devices'], { encoding: 'utf8' });
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, state] = line.split(/\s+/);
      return { id, state };
    });
}

function connectDevice(adb = 'adb', ip) {
  return execFileSync(adb, ['connect', ip], { encoding: 'utf8' });
}

function parseBounds(bounds) {
  const match = String(bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  const [, x1, y1, x2, y2] = match.map(Number);
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

function findClickableText(xml, patterns) {
  const nodes = [...String(xml).matchAll(/<node\b[^>]*>/gi)].map((match) => match[0]);
  const candidates = nodes.map((node) => {
    const text = (node.match(/\btext="([^"]*)"/i) || [])[1] || '';
    const desc = (node.match(/\bcontent-desc="([^"]*)"/i) || [])[1] || '';
    const resourceId = (node.match(/\bresource-id="([^"]*)"/i) || [])[1] || '';
    const bounds = (node.match(/\bbounds="([^"]*)"/i) || [])[1] || '';
    const clickable = /\bclickable="true"/i.test(node);
    const value = `${text} ${desc}`.replace(/&amp;/g, '&');
    return { node, value, resourceId, clickable, center: parseBounds(bounds) };
  });

  for (const pattern of patterns) {
    const matches = candidates.filter((candidate) => candidate.center && pattern.test(candidate.value));
    const clickable = matches.find((candidate) => candidate.clickable);
    const match = clickable || matches[0];
    if (match) {
      return { text: match.value.trim(), resourceId: match.resourceId, ...match.center };
    }
  }
  return null;
}

module.exports = {
  AdbRunner,
  KEY,
  adbExists,
  connectDevice,
  findClickableText,
  listDevices,
  parseBounds
};
