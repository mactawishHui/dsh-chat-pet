import fs from 'node:fs';

const DEFAULT_KEY_PATH = '/opt/qq-bridge/state/serper-key.txt';

function readSerperKey(keyPath = DEFAULT_KEY_PATH) {
  if (process.env.SERPER_API_KEY && process.env.SERPER_API_KEY.trim()) {
    return process.env.SERPER_API_KEY.trim();
  }
  try {
    return fs.readFileSync(keyPath, 'utf8').trim();
  } catch {
    return '';
  }
}

function scoreVisualMatch(item) {
  const src = String(item?.source || '').toLowerCase();
  const link = String(item?.link || '').toLowerCase();
  const title = String(item?.title || '');
  let score = 0;
  if (link.includes('bilibili.com') || src.includes('bilibili')) score += 60;
  if (link.includes('moegirl') || src.includes('萌娘')) score += 55;
  if (link.includes('douyin.com') || link.includes('iesdouyin') || src.includes('抖音')) score += 45;
  if (link.includes('zhihu.com') || link.includes('xiaohongshu.com') || link.includes('weibo.com') || link.includes('tieba.baidu.com')) score += 40;
  if (link.includes('baike.baidu.com') || link.includes('douban.com') || link.includes('sina') || link.includes('sohu') || link.includes('ifeng') || link.includes('yangshipin')) score += 25;
  if (/[\u4e00-\u9fa5]/.test(title)) score += 20;
  if (/梗|表情包|名场面|台词|be like|鬼畜|原图|出自/.test(title)) score += 25;
  if (link.includes('taobao.com') || link.includes('jd.com') || link.includes('amazon.') || link.includes('ebay.')) score -= 30;
  return score;
}

export async function reverseImageSearch(imageUrl, { limit = 12, keyPath = DEFAULT_KEY_PATH } = {}) {
  const url = String(imageUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('图片 URL 无效');
  const apiKey = readSerperKey(keyPath);
  if (!apiKey) throw new Error('未配置 Serper API Key（/opt/qq-bridge/state/serper-key.txt）');

  const resp = await fetch('https://google.serper.dev/lens', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url, gl: 'cn', hl: 'zh-cn' }),
    signal: AbortSignal.timeout(18000)
  });
  if (!resp.ok) {
    throw new Error(`Serper Lens HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const organic = Array.isArray(data?.organic) ? data.organic : [];

  const ranked = organic
    .map((item, idx) => ({ item, score: scoreVisualMatch(item), idx }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx));

  const matches = ranked.slice(0, Math.max(1, limit)).map(({ item }) => {
    const link = String(item?.link || '');
    const bvMatch = link.match(/\/video\/(BV[0-9A-Za-z]+)/);
    return {
      source: String(item?.source || ''),
      title: String(item?.title || '').trim(),
      link,
      ...(bvMatch ? { bvid: bvMatch[1] } : {})
    };
  }).filter((m) => m.title || m.link);

  const bvids = [...new Set(matches.map((m) => m.bvid).filter(Boolean))];
  return {
    provider: 'serper-google-lens',
    totalMatches: organic.length,
    bvids,
    matches
  };
}

export async function serperGoogleSearch(query, { num = 8, tbs = '', keyPath = DEFAULT_KEY_PATH } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('查询词为空');
  const apiKey = readSerperKey(keyPath);
  if (!apiKey) throw new Error('未配置 Serper API Key');

  const body = { q, gl: 'cn', hl: 'zh-cn', num: Math.min(10, Math.max(1, num)) };
  if (tbs) body.tbs = tbs;

  const resp = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) {
    throw new Error(`Serper Search HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const results = [];
  if (data?.answerBox?.snippet || data?.answerBox?.answer) {
    results.push({
      title: String(data.answerBox.title || `摘要：${q}`),
      url: String(data.answerBox.link || 'https://google.com'),
      snippet: String(data.answerBox.answer || data.answerBox.snippet || '').slice(0, 400),
      date: ''
    });
  }
  if (data?.knowledgeGraph?.description) {
    results.push({
      title: String(data.knowledgeGraph.title || q),
      url: String(data.knowledgeGraph.descriptionLink || 'https://google.com'),
      snippet: String(data.knowledgeGraph.description || '').slice(0, 400),
      date: ''
    });
  }
  for (const item of (data?.organic || []).slice(0, num)) {
    if (!item?.title && !item?.link) continue;
    results.push({
      title: String(item.title || ''),
      url: String(item.link || ''),
      snippet: String(item.snippet || '').slice(0, 360),
      date: String(item.date || '')
    });
  }
  if (!results.length) throw new Error('Serper Search 返回空结果');
  return results;
}
