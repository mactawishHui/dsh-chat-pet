/**
 * weather-solar.mjs — 轻量节气计算 + 免 Key 城市天气查询（零外部依赖 ESM）
 *
 * 供日常冲浪（daily-feed）、自主闲逛、夜间日记、以及实时语音通话异步旁路共同复用。
 * 天气查询支持任意中文/英文城市名，带 3 小时本地缓存；未配置城市时仅输出精确二十四节气与季节感知。
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CACHE_PATH = '/opt/qq-bridge/state/weather-cache.json';

// 二十四节气（按公历 1~12 月顺序，每月 2 个节气）及 21 世纪常数 C 值
const SOLAR_TERMS = [
  { name: '小寒', month: 1, c: 5.4055, vibe: '一年里最冷的时候，出门呼白气' },
  { name: '大寒', month: 1, c: 20.12, vibe: '腊月深冬，寒风刺骨' },
  { name: '立春', month: 2, c: 3.87, vibe: '虽然还冷但春意冒头了' },
  { name: '雨水', month: 2, c: 18.73, vibe: '气温回升，容易阴雨潮湿' },
  { name: '惊蛰', month: 3, c: 5.63, vibe: '春雷始动，天气开始变暖' },
  { name: '春分', month: 3, c: 20.646, vibe: '昼夜平分，春风舒服' },
  { name: '清明', month: 4, c: 4.81, vibe: '踏青好时节，常有小雨' },
  { name: '谷雨', month: 4, c: 20.1, vibe: '暮春多雨，温润舒服' },
  { name: '立夏', month: 5, c: 5.52, vibe: '开始有夏天的热气了' },
  { name: '小满', month: 5, c: 21.04, vibe: '初夏渐热，傍晚风挺舒服' },
  { name: '芒种', month: 6, c: 5.678, vibe: '闷热多雨，仲夏来了' },
  { name: '夏至', month: 6, c: 21.37, vibe: '白昼最长，暑热正式上线' },
  { name: '小暑', month: 7, c: 7.108, vibe: '伏天开始，空调续命季' },
  { name: '大暑', month: 7, c: 22.83, vibe: '一年最闷热，冰饮西瓜刚需' },
  { name: '立秋', month: 8, c: 7.5, vibe: '白天还晒，早晚开始带点风' },
  { name: '处暑', month: 8, c: 23.13, vibe: '暑气渐退，秋高气爽的前奏' },
  { name: '白露', month: 9, c: 7.646, vibe: '早晚明显凉了，该加件薄外套' },
  { name: '秋分', month: 9, c: 23.042, vibe: '昼夜平分，秋意正好' },
  { name: '寒露', month: 10, c: 8.318, vibe: '深秋转凉，风里带寒气' },
  { name: '霜降', month: 10, c: 23.438, vibe: '秋天最后一站，早晚冻手' },
  { name: '立冬', month: 11, c: 7.438, vibe: '正式入冬，火锅烤红薯的季节' },
  { name: '小雪', month: 11, c: 22.36, vibe: '气温明显往下掉，冬意很浓了' },
  { name: '大雪', month: 12, c: 7.18, vibe: '深冬降温，适合缩被窝' },
  { name: '冬至', month: 12, c: 21.94, vibe: '黑夜最长，饺子或汤圆安排上' }
];

function termDayOfMonth(year, c) {
  const y = year % 100;
  return Math.floor(y * 0.2422 + c) - Math.floor((y - 1) / 4);
}

/** 计算当前北京时间的节气状态（当天是否正值节气、当前所处节气、距下一节气天数） */
export function getSolarTermInfo(ts = Date.now()) {
  const bj = new Date(ts + 8 * 3600e3);
  const year = bj.getUTCFullYear();
  const month = bj.getUTCMonth() + 1;
  const day = bj.getUTCDate();
  const todayUtc = Date.UTC(year, month - 1, day);

  const list = [];
  for (const yr of [year - 1, year, year + 1]) {
    for (const st of SOLAR_TERMS) {
      const d = termDayOfMonth(yr, st.c);
      list.push({ ...st, year: yr, day: d, utc: Date.UTC(yr, st.month - 1, d) });
    }
  }
  list.sort((a, b) => a.utc - b.utc);

  let current = list[0];
  let next = list[list.length - 1];
  for (const item of list) {
    if (item.utc <= todayUtc) current = item;
    else { next = item; break; }
  }
  const daysSince = Math.round((todayUtc - current.utc) / 86400e3);
  const daysToNext = Math.round((next.utc - todayUtc) / 86400e3);
  const isToday = daysSince === 0;
  const text = isToday
    ? `今天正是「${current.name}」（${current.vibe}）`
    : daysToNext <= 2
      ? `当前「${current.name}」，过 ${daysToNext} 天就是「${next.name}」（${next.vibe}）`
      : `当前节气「${current.name}」（${current.vibe}）`;

  return { current: current.name, vibe: current.vibe, isToday, daysSince, next: next.name, daysToNext, text };
}

const WMO_ZH = {
  0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴', 45: '雾', 48: '冻雾',
  51: '小毛毛雨', 53: '毛毛雨', 55: '细雨', 61: '小雨', 63: '中雨', 65: '大雨',
  71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '中阵雨', 82: '强阵雨',
  85: '阵雪', 95: '雷阵雨', 96: '雷阵雨伴冰雹'
};

const EN_DESC_ZH = [
  [/thunder|storm/i, '雷阵雨'],
  [/heavy snow|blizzard/i, '大雪'],
  [/snow|sleet|flurries/i, '小雪'],
  [/heavy rain|torrential/i, '大雨'],
  [/moderate rain/i, '中雨'],
  [/rain|drizzle|shower/i, '小雨'],
  [/fog|mist/i, '有雾'],
  [/haze|smoke|smoky|dust|sand/i, '雾霾'],
  [/overcast/i, '阴天'],
  [/partly cloudy/i, '多云'],
  [/cloudy/i, '阴转多云'],
  [/sunny|clear/i, '晴']
];

function translateWeatherDesc(raw) {
  const s = String(raw || '').trim();
  if (!s) return '多云';
  if (/[\u4e00-\u9fa5]/.test(s)) return s;
  for (const [re, zh] of EN_DESC_ZH) {
    if (re.test(s)) return zh;
  }
  return s;
}

async function fetchViaWttr(city) {
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'curl/8.5.0', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(6500)
  });
  if (!res.ok) throw new Error(`wttr HTTP ${res.status}`);
  const j = await res.json();
  const cur = j?.current_condition?.[0];
  const d0 = j?.weather?.[0];
  const d1 = j?.weather?.[1];
  if (!cur || !d0) throw new Error('wttr empty');
  const desc = translateWeatherDesc(cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '晴');
  const curTemp = Number(cur.temp_C);
  const feels = Number(cur.FeelsLikeC);
  const min0 = Number(d0.mintempC);
  const max0 = Number(d0.maxtempC);
  const d1Desc = translateWeatherDesc(d1?.hourly?.[4]?.lang_zh?.[0]?.value || d1?.hourly?.[4]?.weatherDesc?.[0]?.value || '');
  const min1 = d1 ? Number(d1.mintempC) : null;
  const max1 = d1 ? Number(d1.maxtempC) : null;
  const windKmh = Number(cur.windspeedKmph || 0);
  const summary = `${city}现在${desc} ${curTemp}℃（体感${feels}℃），今天 ${min0}~${max0}℃${windKmh >= 20 ? `、风有点大(${windKmh}km/h)` : ''}${d1 ? `；明天${d1Desc || ''} ${min1}~${max1}℃` : ''}`;
  return {
    city,
    source: 'wttr.in',
    curTemp,
    feelsLike: feels,
    desc,
    todayMin: min0,
    todayMax: max0,
    tomorrowMin: min1,
    tomorrowMax: max1,
    tomorrowDesc: d1Desc,
    summary,
    fetchedAt: Date.now()
  };
}

async function fetchViaOpenMeteo(city) {
  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`,
    { signal: AbortSignal.timeout(6000) }
  );
  if (!geoRes.ok) throw new Error(`open-meteo geo HTTP ${geoRes.status}`);
  const geo = await geoRes.json();
  const loc = geo?.results?.[0];
  if (!loc) throw new Error(`找不到城市 ${city}`);
  const wRes = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Asia%2FShanghai&forecast_days=2`,
    { signal: AbortSignal.timeout(6000) }
  );
  if (!wRes.ok) throw new Error(`open-meteo forecast HTTP ${wRes.status}`);
  const w = await wRes.json();
  const c = w.current || {};
  const d = w.daily || {};
  const desc = WMO_ZH[c.weather_code] || '多云';
  const curTemp = Math.round(Number(c.temperature_2m ?? 0));
  const feels = Math.round(Number(c.apparent_temperature ?? curTemp));
  const min0 = Math.round(Number(d.temperature_2m_min?.[0] ?? curTemp));
  const max0 = Math.round(Number(d.temperature_2m_max?.[0] ?? curTemp));
  const min1 = d.temperature_2m_min?.[1] != null ? Math.round(Number(d.temperature_2m_min[1])) : null;
  const max1 = d.temperature_2m_max?.[1] != null ? Math.round(Number(d.temperature_2m_max[1])) : null;
  const d1Desc = d.weather_code?.[1] != null ? (WMO_ZH[d.weather_code[1]] || '') : '';
  const summary = `${loc.name || city}现在${desc} ${curTemp}℃（体感${feels}℃），今天 ${min0}~${max0}℃${min1 != null ? `；明天${d1Desc} ${min1}~${max1}℃` : ''}`;
  return {
    city: loc.name || city,
    source: 'open-meteo',
    curTemp,
    feelsLike: feels,
    desc,
    todayMin: min0,
    todayMax: max0,
    tomorrowMin: min1,
    tomorrowMax: max1,
    tomorrowDesc: d1Desc,
    summary,
    fetchedAt: Date.now()
  };
}

/** 查任意城市天气（带本地缓存，3 小时内直接命中；先 wttr.in，失败回退 open-meteo） */
export async function fetchCityWeather(city, { cachePath = DEFAULT_CACHE_PATH, ttlMs = 3 * 3600e3 } = {}) {
  const cleanCity = String(city || '').replace(/[市省区县\s]/g, '').trim();
  if (!cleanCity) return null;
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}
  const hit = cache[cleanCity];
  if (hit && Date.now() - Number(hit.fetchedAt || 0) < ttlMs) return hit;

  let result = null;
  try {
    result = await fetchViaWttr(cleanCity);
  } catch {
    try {
      result = await fetchViaOpenMeteo(cleanCity);
    } catch {
      return hit || null;
    }
  }
  if (result) {
    cache[cleanCity] = result;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    } catch {}
  }
  return result;
}

/** 获取完整的「节气 + 城市天气（如已配置）」自然语言短提示 */
export async function getWeatherAndSolarHint(city = '', opts = {}) {
  const solar = getSolarTermInfo();
  const weather = city ? await fetchCityWeather(city, opts) : null;
  const line = weather ? `${solar.text}｜${weather.summary}` : solar.text;
  return { solar, weather, line };
}
