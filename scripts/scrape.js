// ==Qtfm Podcast Scraper==
// 全量抓取蜻蜓FM频道节目并生成Apple播客RSS
// 在GitHub Action中运行
// ==/Scraper==

const https = require('https');
const fs = require('fs');
const path = require('path');

const CHANNEL_ID = process.env.CHANNEL_ID;
if (!CHANNEL_ID) { console.error('CHANNEL_ID required'); process.exit(1); }

const WORKER_BASE = process.env.WORKER_BASE || 'https://qtfm-podcast.general74110.workers.dev';
const OUT_DIR = process.env.OUT_DIR || 'novels';
const MAX_PROGRAMS = parseInt(process.env.MAX_PROGRAMS || '5000', 10); // 无限制

// ============================================================
// HTTP helpers
// ============================================================

function fetch(url, opt) {
  return new Promise((ok, fail) => {
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, {
      ...(opt?.headers || {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': 'https://m.qtfm.cn/'
      }),
      timeout: 15000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, data }));
    }).on('error', fail).on('timeout', function() { this.destroy(); fail(new Error('timeout')); });
  });
}

function fetchJSON(url, opt) {
  return fetch(url, {
    ...opt,
    headers: {
      ...(opt?.headers || {}),
      'Accept': 'application/json'
    }
  }).then(r => {
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return JSON.parse(r.data);
  });
}

// ============================================================
// 核心逻辑
// ============================================================

async function main() {
  const startedAt = Date.now();
  console.log(`[${CHANNEL_ID}] 🎧 开始全量抓取...`);

  // 1. 抓频道主页，获取元数据+版本hash
  const mainPage = await fetch(`https://m.qtfm.cn/vchannels/${CHANNEL_ID}/`);
  const initData = extractInitStores(mainPage.data);
  if (!initData?.VChannelStore?.channel) throw new Error('无法解析频道数据');

  const channel = initData.VChannelStore.channel;
  const version = channel.v || '';
  const title = channel.title || '未知';
  const description = (channel.description || title).replace(/<[^>]+>/g, '').trim();
  const coverUrl = channel.cover ? channel.cover + '!400' : '';
  const totalOnSite = channel.program_count || 0;

  console.log(`  📚 ${title} | 共 ${totalOnSite} 集 | version=${version}`);

  // 2. 通过API获取节目列表
  let programs = [];
  if (version) {
    try {
      const apiData = await fetchJSON(
        `https://webapi.qtfm.cn/api/mobile/channels/${CHANNEL_ID}/programs?version=${version}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36',
            'Origin': 'https://m.qtfm.cn',
            'Referer': 'https://m.qtfm.cn/'
          }
        }
      );
      if (apiData.programs) {
        programs = apiData.programs;
        console.log(`  📡 API: ${programs.length} 集 (total=${apiData.total})`);
      }
    } catch(e) {
      console.log(`  ⚠️ API失败: ${e.message}`);
    }
  }

  // fallback: SSR数据
  if (programs.length === 0) {
    programs = initData.VChannelStore.programs?.items || [];
    console.log(`  📋 SSR: ${programs.length} 集`);
  }

  if (programs.length === 0) throw new Error('无节目数据');

  // 3. 逐个抓取节目页面获取音频URL（真正的重体力活）
  console.log(`  🎯 开始获取音频URL (${programs.length} 集)...`);
  const audioUrls = {};
  let success = 0, fail = 0;

  for (let i = 0; i < programs.length && i < MAX_PROGRAMS; i++) {
    const p = programs[i];
    const pid = p.programId || p.program_id || p.id;
    if (!pid) { fail++; continue; }

    try {
      const progPage = await fetch(`https://m.qtfm.cn/vchannels/${CHANNEL_ID}/programs/${pid}/`);
      const audioMatch = progPage.data.match(/"audioUrl"\s*:\s*"([^"]+)"/);
      if (audioMatch) {
        const endpoint = audioMatch[1].replace(/\\u0026/g, '&');
        // 获取真实音频地址
        const redirectResp = await fetch(endpoint, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36',
            'Referer': 'https://m.qtfm.cn/'
          }
        });
        const hrefMatch = redirectResp.data.match(/href="([^"]+)"/);
        if (hrefMatch) {
          audioUrls[pid] = hrefMatch[1];
          success++;
        } else {
          audioUrls[pid] = endpoint;
          success++;
        }
      } else {
        fail++;
      }
    } catch(e) {
      fail++;
    }

    // 进度
    if ((i + 1) % 100 === 0 || i === programs.length - 1) {
      console.log(`  📊 进度: ${i+1}/${Math.min(programs.length, MAX_PROGRAMS)} | 成功: ${success} | 失败: ${fail}`);
    }

    // 防反爬延时
    if (i < programs.length - 1) await sleep(Math.random() * 100 + 50);
  }

  console.log(`  ✅ 音频获取完成: ${success} 成功, ${fail} 失败`);

  // 4. 生成RSS
  const now = new Date();
  const nowUTC = now.toUTCString();
  let items = '';

  for (const p of programs) {
    const pid = p.programId || p.program_id || p.id;
    if (!pid) continue;

    const audioUrl = audioUrls[pid] || `${WORKER_BASE}/audio/${CHANNEL_ID}/${pid}`;
    const durationStr = formatDuration(p.duration || 0);
    const pubDate = p.updateTime ? new Date(p.updateTime).toUTCString() : nowUTC;
    const progTitle = p.title || '未知';
    const progUrl = `https://m.qtfm.cn/vchannels/${CHANNEL_ID}/programs/${pid}/`;

    items += `    <item>
      <title>${xmlEscape(progTitle)}</title>
      <link>${xmlEscape(progUrl)}</link>
      <guid isPermaLink="false">qtfm-${CHANNEL_ID}-${pid}</guid>
      <description>${xmlEscape(progTitle)}</description>
      <enclosure url="${xmlEscape(audioUrl)}" length="0" type="audio/mpeg"/>
      <itunes:duration>${durationStr}</itunes:duration>
      <itunes:author>蜻蜓FM</itunes:author>
      <pubDate>${pubDate}</pubDate>
    </item>`;
  }

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0">
  <channel>
    <title>${xmlEscape(title)}</title>
    <link>https://m.qtfm.cn/vchannels/${CHANNEL_ID}/</link>
    <description>${xmlEscape(description)}</description>
    <language>zh-cn</language>
    <itunes:author>蜻蜓FM</itunes:author>
    <itunes:summary>${xmlEscape(description)}</itunes:summary>
    ${coverUrl ? `<itunes:image href="${xmlEscape(coverUrl)}"/>` : ''}
    <itunes:category text="有声书"/>
    <lastBuildDate>${nowUTC}</lastBuildDate>
    <pubDate>${nowUTC}</pubDate>
${items}
  </channel>
</rss>`;

  // 5. 写入文件
  const outFile = path.join(OUT_DIR, `${CHANNEL_ID}.xml`);
  const infoFile = path.join(OUT_DIR, `${CHANNEL_ID}.json`);
  const indexFile = path.join(OUT_DIR, 'index.json');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outFile, rss, 'utf8');
  console.log(`  📝 RSS已写入: ${outFile} (${(rss.length/1024).toFixed(0)}KB)`);

  // 6. 写入元数据
  const meta = {
    channelId: CHANNEL_ID,
    title,
    description,
    coverUrl,
    programs: programs.length,
    audioSuccess: success,
    audioFail: fail,
    totalOnSite,
    generatedAt: nowUTC,
    duration: Math.round((Date.now() - startedAt) / 1000) + 's',
    workerBase: WORKER_BASE,
    subscribeUrl: `${WORKER_BASE}/${CHANNEL_ID}`
  };
  fs.writeFileSync(infoFile, JSON.stringify(meta, null, 2), 'utf8');

  // 7. 更新索引
  let index = [];
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch(_) {}
  const existing = index.find(i => i.channelId === CHANNEL_ID);
  if (existing) Object.assign(existing, meta);
  else index.push(meta);
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), 'utf8');

  console.log(`  ✅ 全部完成! ${programs.length}集, 耗时${meta.duration}`);
}

// ============================================================
// 工具函数
// ============================================================

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
    else if (ch === '}') {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }
  if (endIdx === 0) return null;
  try { return JSON.parse(str.slice(0, endIdx)); }
  catch (e) { return null; }
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function xmlEscape(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error('💥 错误:', e.message); process.exit(1); });