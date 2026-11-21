import fs from 'node:fs';
import crypto from 'node:crypto';

const CONFIG_PATH = '/opt/qq-bridge/config.json';
const DASHSCOPE_KEY_PATH = '/opt/qq-tts/apikey.txt';
const TEXT_ONLY_MODELS = new Set(['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner']);

const cache = new Map(); // sha256 -> description
const CACHE_MAX = 64;

export function shouldUseVisionBridge() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg?.visionBridge?.enabled === false) return false;
    if (cfg?.visionBridge?.enabled === true) return true;
    const model = String(cfg?.dsh?.model || '').trim().toLowerCase();
    return TEXT_ONLY_MODELS.has(model);
  } catch {
    return false;
  }
}

function getApiKey() {
  try {
    return fs.readFileSync(DASHSCOPE_KEY_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

export async function describeImageWithVL({ data, mimeType = 'image/jpeg', hint = '' }) {
  if (!data) return null;
  const hash = crypto.createHash('sha256').update(String(data)).digest('hex').slice(0, 24);
  if (cache.has(hash)) return cache.get(hash);

  const apiKey = getApiKey();
  if (!apiKey) return null;

  const safeMime = /^image\/(jpeg|jpg|png|webp|gif)$/i.test(mimeType) ? mimeType : 'image/jpeg';
  const prompt = [
    '请简洁、准确、客观地描述这张图片，供纯文本对话模型完整“看见”画面：',
    '1. 画面主体、人物/角色外貌、动作、神态情绪、场景背景（如为多格动图拼图，简述动作变化）；',
    '2. 图上所有文字逐字 OCR（务必准确，无文字写“无”）；',
    '3. 若是网络梗图/表情包/影视/动漫/游戏截图，指出最可能的角色、出处或梗关键词（不确定就如实说，不要瞎编）。',
    hint ? `补充上下文：${hint}` : ''
  ].filter(Boolean).join('\n');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen3-omni-flash',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${safeMime};base64,${data}` } },
            { type: 'text', text: prompt }
          ]
        }],
        max_tokens: 320,
        temperature: 0.2
      }),
      signal: ac.signal
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const desc = String(json?.choices?.[0]?.message?.content || '').trim();
    if (!desc) return null;
    cache.set(hash, desc);
    if (cache.size > CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    return desc;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
