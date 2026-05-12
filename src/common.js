const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function expandPath(value) {
  if (!value) return value;
  return value
    .replace(/%USERPROFILE%/gi, os.homedir())
    .replace(/\$env:USERPROFILE/gi, os.homedir())
    .replace(/^~(?=$|[\\/])/, os.homedir());
}

function loadManifest(manifestPath) {
  const resolved = path.resolve(expandPath(manifestPath));
  const manifest = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  manifest.__path = resolved;
  manifest.__dir = path.dirname(resolved);
  return manifest;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function appApkFile(app) {
  if (app.source && app.source.apkFile) return app.source.apkFile;
  if (app.apkFile) return app.apkFile;
  return `${safeName(app.id || app.name)}.apk`;
}

function appApkPath(app, outputDir) {
  return path.join(outputDir, appApkFile(app));
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function validateManifest(manifest, options = {}) {
  const includeOptional = Boolean(options.includeOptional);
  const errors = [];
  const categories = manifest.categories || {};
  const apps = Array.isArray(manifest.apps) ? manifest.apps : [];
  const selectedApps = apps.filter((app) => includeOptional || app.required !== false);

  if (!apps.length) errors.push('Manifest must contain an apps array.');

  for (const app of apps) {
    if (!app.id) errors.push(`App "${app.name || '(unnamed)'}" is missing id.`);
    if (!app.name) errors.push(`App "${app.id || '(missing id)'}" is missing name.`);
    if (!app.category) errors.push(`App "${app.name || app.id}" is missing category.`);
    if (!app.source || !app.source.type) errors.push(`App "${app.name || app.id}" is missing source.type.`);
  }

  for (const [category, rule] of Object.entries(categories)) {
    const minimum = Number(rule.minimumRequired || 0);
    if (!minimum) continue;
    const count = selectedApps.filter((app) => app.category === category).length;
    if (count < minimum) {
      errors.push(`Category "${category}" requires at least ${minimum} configured required apps; found ${count}.`);
    }
  }

  const ids = new Set();
  for (const app of apps) {
    if (!app.id) continue;
    if (ids.has(app.id)) errors.push(`Duplicate app id "${app.id}".`);
    ids.add(app.id);
  }

  return { errors, selectedApps };
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

module.exports = {
  appApkFile,
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
};
