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

const DEFAULT_MANIFEST = path.join(__dirname, '..', 'firetv-apps.json');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

function findCodeNearApp(article, app) {
  if (!article) return false;
  const code = app.source && app.source.code;
  if (!code) return false;
  return article.includes(`Code: ${code}`) || article.includes(`Code:&nbsp;${code}`) || article.includes(code);
}

function absolutizeUrl(baseUrl, maybeUrl) {
  try {
    return new URL(maybeUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractApkLink(html, baseUrl) {
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html))) {
    const url = absolutizeUrl(baseUrl, match[1]);
    if (url && /\.apk(?:[?#].*)?$/i.test(url)) return url;
  }
  const loose = html.match(/https?:\/\/[^\s"'<>]+\.apk(?:[^\s"'<>]*)?/i);
  return loose ? loose[0] : null;
}

async function resolveUrl(url, hops = 0) {
  if (hops > 8) throw new Error(`Too many redirects while resolving ${url}`);
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': USER_AGENT }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);

  const contentType = response.headers.get('content-type') || '';
  const finalUrl = response.url || url;
  if (/\.apk(?:[?#].*)?$/i.test(finalUrl) || /application\/vnd\.android\.package-archive|application\/octet-stream/i.test(contentType)) {
    return finalUrl;
  }

  const html = await response.text();
  const apkUrl = extractApkLink(html, finalUrl);
  if (!apkUrl) {
    throw new Error(`Resolved ${url} to HTML, but no APK link was found.`);
  }
  return resolveUrl(apkUrl, hops + 1);
}

async function resolveDownloaderCode(code) {
  const candidates = [
    `https://aftv.news/${code}`,
    `https://go.aftvnews.com/${code}`,
    `https://troypoint.com/tpapp.php?download=${code}`
  ];

  const failures = [];
  for (const candidate of candidates) {
    try {
      return await resolveUrl(candidate);
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`Could not resolve Downloader code ${code}. ${failures.join(' | ')}`);
}

async function searchAlternateSource(app, manifest) {
  const approvedDomains = (app.source.approvedDomains || []).map((domain) => domain.toLowerCase());
  if (!approvedDomains.length) {
    throw new Error(`${app.name} uses alternate-search but has no approvedDomains configured.`);
  }

  const queries = app.source.queries || [`"${app.name}" APK`];
  const failures = [];
  for (const query of queries) {
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    try {
      const html = await fetchText(searchUrl);
      const links = [...html.matchAll(/<a\s+href=["'](https?:\/\/[^"']+)["']/gi)]
        .map((match) => match[1])
        .filter((url) => approvedDomains.some((domain) => new URL(url).hostname.toLowerCase().endsWith(domain)));

      for (const link of links) {
        const page = await fetchText(link);
        const codeMatch = page.match(/\bCode:\s*([0-9]{4,})\b/i);
        if (codeMatch) return resolveDownloaderCode(codeMatch[1]);
        const apkLink = extractApkLink(page, link);
        if (apkLink) return resolveUrl(apkLink);
      }
    } catch (error) {
      failures.push(`${query}: ${error.message}`);
    }
  }

  throw new Error(`No approved alternate source found for ${app.name}. ${failures.join(' | ')}`);
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status} while downloading ${url}`);

  const contentType = response.headers.get('content-type') || '';
  if (!/\.apk(?:[?#].*)?$/i.test(response.url || url) && !/application\/vnd\.android\.package-archive|application\/octet-stream/i.test(contentType)) {
    throw new Error(`Refusing to save non-APK response from ${url} (${contentType || 'unknown content type'}).`);
  }

  ensureDir(path.dirname(destination));
  const tempPath = `${destination}.download`;
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, destination);
}

async function main() {
  const args = parseArgs(process.argv);
  const manifestPath = args.manifest || DEFAULT_MANIFEST;
  const manifest = loadManifest(manifestPath);
  const outputDir = path.resolve(expandPath(args.output || manifest.downloadsDir || path.join(process.env.USERPROFILE || process.cwd(), 'Downloads', 'firetv-apks')));
  const dryRun = Boolean(args['dry-run']);
  const force = Boolean(args.force);
  const includeOptional = Boolean(args['include-optional']);
  const allowAlternateSearch = Boolean(args['allow-alternate-search']);
  const runDir = path.join(outputDir, '_runs', `download-${nowStamp()}`);

  ensureDir(outputDir);
  ensureDir(runDir);

  const validation = validateManifest(manifest, { includeOptional });
  if (validation.errors.length) {
    for (const error of validation.errors) console.error(`Manifest error: ${error}`);
    process.exitCode = 1;
    return;
  }

  let troypointArticle = '';
  if (manifest.troypointCodesUrl) {
    try {
      troypointArticle = await fetchText(manifest.troypointCodesUrl);
    } catch (error) {
      console.warn(`Warning: could not fetch Troypoint page for code validation: ${error.message}`);
    }
  }

  const report = {
    createdAt: new Date().toISOString(),
    dryRun,
    outputDir,
    manifest: manifest.__path,
    apps: []
  };

  for (const app of validation.selectedApps) {
    const entry = {
      id: app.id,
      name: app.name,
      category: app.category,
      required: app.required !== false,
      source: app.source,
      destination: appApkPath(app, outputDir),
      status: 'pending'
    };
    report.apps.push(entry);

    try {
      const existing = fs.existsSync(entry.destination);
      if (existing && !force) {
        entry.status = dryRun ? 'dry-run-existing' : 'existing';
        entry.sha256 = sha256File(entry.destination);
        entry.bytes = fs.statSync(entry.destination).size;
        continue;
      }
      if (app.source.type === 'manual') {
        if (!existing) throw new Error(`Manual APK is missing: ${entry.destination}`);
        entry.status = 'existing';
        entry.sha256 = sha256File(entry.destination);
        continue;
      }

      if (app.source.type === 'direct-url') {
        entry.resolvedUrl = app.source.url;
      } else if (app.source.type === 'troypoint-code') {
        entry.presentOnTroypointPage = findCodeNearApp(troypointArticle, app);
        if (dryRun) {
          entry.status = existing ? 'dry-run-existing' : 'dry-run-ready';
          if (existing) entry.sha256 = sha256File(entry.destination);
          continue;
        }
        entry.resolvedUrl = await resolveDownloaderCode(app.source.code);
      } else if (app.source.type === 'alternate-search') {
        if (!allowAlternateSearch) {
          throw new Error(`${app.name} requires --allow-alternate-search or a direct source override.`);
        }
        if (dryRun) {
          entry.status = existing ? 'dry-run-existing' : 'dry-run-needs-alternate-search';
          if (existing) entry.sha256 = sha256File(entry.destination);
          continue;
        }
        entry.resolvedUrl = await searchAlternateSource(app, manifest);
      } else {
        throw new Error(`Unsupported source type "${app.source.type}".`);
      }

      if (dryRun) {
        entry.status = existing ? 'dry-run-existing' : 'dry-run-ready';
        if (existing) entry.sha256 = sha256File(entry.destination);
        continue;
      }

      await downloadFile(entry.resolvedUrl, entry.destination);
      entry.status = 'downloaded';
      entry.sha256 = sha256File(entry.destination);
      entry.bytes = fs.statSync(entry.destination).size;
    } catch (error) {
      entry.status = 'failed';
      entry.error = error.message;
      console.error(`${app.name}: ${error.message}`);
      if (app.required !== false) process.exitCode = 1;
    }
  }

  const reportPath = path.join(runDir, dryRun ? 'download-dry-run.json' : 'download-report.json');
  writeJson(reportPath, report);
  console.log(`Report written to ${reportPath}`);
  console.log(`APK folder: ${outputDir}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
