const fs = require('fs');
const path = require('path');

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const values = {};
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    values[key] = value;
    if (!process.env[key]) process.env[key] = value;
  }
  return values;
}

function redactSecret(value) {
  if (!value) return value;
  return `${String(value).slice(0, 4)}...${String(value).slice(-4)}`;
}

class GoldPanelClient {
  constructor(options = {}) {
    const envPath = options.envPath || path.join(__dirname, '..', '.env');
    loadEnv(envPath);
    this.apiUrl = options.apiUrl || process.env.GOLD_PANEL_API_URL || 'https://8k.cms-only.ru/api/api.php';
    this.apiKey = options.apiKey || process.env.GOLD_PANEL_API_KEY;
    if (!this.apiKey) throw new Error(`GOLD_PANEL_API_KEY is missing. Add it to ${envPath}.`);
  }

  async request(params) {
    const url = new URL(this.apiUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    url.searchParams.set('api_key', this.apiKey);

    const response = await fetch(url);
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Gold Panel returned non-JSON for action "${params.action}": ${text.slice(0, 300)}`);
    }
    if (!response.ok) throw new Error(`Gold Panel HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  }

  bouquets() {
    return this.request({ action: 'bouquet' });
  }

  reseller() {
    return this.request({ action: 'reseller' });
  }

  createM3u({ sub, pack, country, notes }) {
    return this.request({
      action: 'new',
      type: 'm3u',
      sub,
      pack,
      country,
      notes
    });
  }
}

function parseM3uUrl(value) {
  const url = new URL(value);
  return {
    serverUrl: `${url.protocol}//${url.host}`,
    username: url.searchParams.get('username') || '',
    password: url.searchParams.get('password') || '',
    playlistUrl: value
  };
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findBouquet(bouquets, wanted) {
  if (!Array.isArray(bouquets)) return null;
  const normalizedWanted = normalizeName(wanted);
  return bouquets.find((item) => normalizeName(item.name) === normalizedWanted)
    || bouquets.find((item) => normalizeName(item.name).includes(normalizedWanted))
    || bouquets.find((item) => normalizedWanted.includes(normalizeName(item.name)));
}

module.exports = {
  GoldPanelClient,
  findBouquet,
  loadEnv,
  parseM3uUrl,
  redactSecret
};
