// Qtfm Podcast Scraper for GitHub Actions
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHANNEL_ID = process.env.CHANNEL_ID;
if (!CHANNEL_ID) { console.error('CHANNEL_ID required'); process.exit(1); }
const WORKER_BASE = process.env.WORKER_BASE || 'https://qtfm-podcast.general74110.workers.dev';
const OUT_DIR = process.env.OUT_DIR || 'novels';

function fetch(url) {
  return new Promise((ok, fail) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': 'https://m.qtfm.cn/'
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, data }));
    });
    req.on('error', fail);
    req.setTimeout(20000, () => { req.destroy(); fail(new Error('timeout')); });
  });
}

function fetchJSON(url, acceptJson) {
  const h = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36',
    'Origin': 'https://m.qtfm.cn',
    'Referer': 'https://m.qtfm.cn/'
  };
  if (acceptJson) h['Accept'] = 'application/json';
  return new Promise((ok, fail) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: h }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) fail(new Error('HTTP ' + res.statusCode));
        else ok(JSON.parse(data));
      });
    });
    req.on('error', fail);
    req.setTimeout(20000, () => { req.destroy(); fail(new Error('timeout')); });
  });
}

function extractInitStores(html) {
  const startMatch = html.match(/window\.__initStores\s*=\s*(\{)/);
  if (!startMatch) return null;
  const startIdx = startMatch.index + startMatch[0].length - 1;
  const str = html.slice(startIdx);
  let depth = 0, inString = false, escape = false, endIdx = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
  }
  if (endIdx === 0) return null;
  try { return JSON.parse(str.slice(0, endIdx)); }
  catch (e) { return null; }
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  return m + ':' + String(s).padStart(2,'0');
}

function xmlEscape(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('[' + CHANNEL_ID + '] Starting...');

  // 1. Get channel page
  const mainRes = await fetch('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/');
  if (mainRes.status !== 200) throw new Error('Channel page HTTP ' + mainRes.status);
  const initData = extractInitStores(mainRes.data);
  if (!initData || !initData.VChannelStore || !initData.VChannelStore.channel) {
    throw new Error('Cannot parse channel data');
  }

  const channel = initData.VChannelStore.channel;
  const version = channel.v || '';
  const title = channel.title || 'Unknown';
  const desc = (channel.description || title).replace(/<[^>]+>/g, '').trim();
  const cover = channel.cover ? channel.cover + '!400' : '';
  const total = channel.program_count || 0;
  console.log('Title: ' + title + ', Total: ' + total + ', Version: ' + version);

  // 2. Get program list via API
  let programs = [];
  if (version) {
    try {
      const apiData = await fetchJSON(
        'https://webapi.qtfm.cn/api/mobile/channels/' + CHANNEL_ID + '/programs?version=' + version,
        true
      );
      if (apiData.programs && apiData.programs.length > 0) {
        programs = apiData.programs;
        console.log('API: ' + programs.length + ' episodes');
      }
    } catch(e) {
      console.log('API failed: ' + e.message);
    }
  }

  if (programs.length === 0) {
    programs = initData.VChannelStore.programs?.items || [];
    console.log('Fallback SSR: ' + programs.length + ' episodes');
  }

  if (programs.length === 0) throw new Error('No program data');

  // 3. Fetch individual audio URLs
  console.log('Fetching audio URLs for ' + programs.length + ' episodes...');
  const audioUrls = {};
  let success = 0, fail = 0;

  for (let i = 0; i < programs.length; i++) {
    const pid = programs[i].programId;
    if (!pid) { fail++; continue; }
    try {
      const progRes = await fetch('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + pid + '/');
      const audioMatch = progRes.data.match(/"audioUrl"\s*:\s*"([^"]+)"/);
      if (audioMatch) {
        const endpoint = audioMatch[1].replace(/\\u0026/g, '&');
        try {
          const redirectRes = await fetch(endpoint);
          const hrefMatch = redirectRes.data.match(/href="([^"]+)"/);
          audioUrls[pid] = hrefMatch ? hrefMatch[1] : endpoint;
          success++;
        } catch(e) {
          audioUrls[pid] = endpoint;
          success++;
        }
      } else {
        fail++;
      }
    } catch(e) {
      fail++;
    }
    if ((i + 1) % 50 === 0 || i === programs.length - 1) {
      console.log('  Progress: ' + (i + 1) + '/' + programs.length + ' OK=' + success + ' FAIL=' + fail);
    }
    if (i < programs.length - 1) await sleep(80 + Math.floor(Math.random() * 40));
  }

  console.log('Audio: ' + success + ' OK, ' + fail + ' FAIL');

  // 4. Generate RSS
  const nowUTC = new Date().toUTCString();
  let items = '';
  for (const p of programs) {
    const pid = p.programId;
    if (!pid) continue;
    const audioUrl = audioUrls[pid] || WORKER_BASE + '/audio/' + CHANNEL_ID + '/' + pid;
    const dur = formatDuration(p.duration || 0);
    const date = p.updateTime ? new Date(p.updateTime).toUTCString() : nowUTC;
    const pTitle = p.title || '';
    const pUrl = 'https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + pid + '/';
    items += '    <item>\n';
    items += '      <title>' + xmlEscape(pTitle) + '</title>\n';
    items += '      <link>' + xmlEscape(pUrl) + '</link>\n';
    items += '      <guid isPermaLink="false">qtfm-' + CHANNEL_ID + '-' + pid + '</guid>\n';
    items += '      <description>' + xmlEscape(pTitle) + '</description>\n';
    items += '      <enclosure url="' + xmlEscape(audioUrl) + '" length="0" type="audio/mpeg"/>\n';
    items += '      <itunes:duration>' + dur + '</itunes:duration>\n';
    items += '      <itunes:author>蜻蜓FM</itunes:author>\n';
    items += '      <pubDate>' + date + '</pubDate>\n';
    items += '    </item>\n';
  }

  const rss = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0">\n' +
    '  <channel>\n' +
    '    <title>' + xmlEscape(title) + '</title>\n' +
    '    <link>https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/</link>\n' +
    '    <description>' + xmlEscape(desc) + '</description>\n' +
    '    <language>zh-cn</language>\n' +
    '    <itunes:author>蜻蜓FM</itunes:author>\n' +
    '    <itunes:summary>' + xmlEscape(desc) + '</itunes:summary>\n' +
    (cover ? '    <itunes:image href="' + xmlEscape(cover) + '"/>\n' : '') +
    '    <itunes:category text="有声书"/>\n' +
    '    <lastBuildDate>' + nowUTC + '</lastBuildDate>\n' +
    '    <pubDate>' + nowUTC + '</pubDate>\n' +
    items +
    '  </channel>\n' +
    '</rss>\n';

  // 5. Write files
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, CHANNEL_ID + '.xml'), rss, 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, CHANNEL_ID + '.json'),
    JSON.stringify({
      channelId: CHANNEL_ID, title, programs: programs.length,
      audioSuccess: success, audioFail: fail, totalOnSite: total,
      generatedAt: nowUTC,
      workerBase: WORKER_BASE
    }, null, 2), 'utf8');

  // Update index
  const indexPath = path.join(OUT_DIR, 'index.json');
  let index = [];
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch(_) {}
  const existing = index.find(i => i.channelId === CHANNEL_ID);
  const meta = { channelId: CHANNEL_ID, title, programs: programs.length, generatedAt: nowUTC };
  if (existing) Object.assign(existing, meta);
  else index.push(meta);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');

  console.log('Done: ' + programs.length + ' episodes, RSS: ' + (rss.length/1024).toFixed(0) + 'KB');
}

main().catch(e => {
  console.error('Error:', e.message || 'unknown');
  process.exit(1);
});