import fs from "node:fs";

const CLICHE_RE = /好的[，,。！!]?我记|我记下|记着了[，,]?放心|我帮你盯|最戳我|最戳你|虽然.{1,40}但是|不是.{1,30}而是|归.{1,8}[，,]?但|写一封情书|真是感慨|一绝|张力拉满|[：:]\s*[^/\n]{4,}/;
const SKIP_CONTENT_RE = /https?:\/\/|```|\[语音|\[图片|\[表情|\[转发|ownerQQ|管理员在管理端/;

let cachedExamplesPath = null;
let cachedExamplesMtime = 0;
let cachedExamples = [];

function loadExamples(filePath) {
  if (!filePath) return [];
  try {
    const stat = fs.statSync(filePath);
    if (filePath === cachedExamplesPath && stat.mtimeMs === cachedExamplesMtime) {
      return cachedExamples;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(parsed)) {
      cachedExamples = parsed;
      cachedExamplesPath = filePath;
      cachedExamplesMtime = stat.mtimeMs;
      return cachedExamples;
    }
  } catch {
    // ignore missing or malformed examples file
  }
  return [];
}

function selectExamples(allExamples, queryText, maxCount = 5) {
  if (!allExamples.length) return [];
  const scored = allExamples.map((ex, idx) => {
    let score = 0;
    const kws = Array.isArray(ex.keywords) ? ex.keywords : [];
    for (const kw of kws) {
      if (kw && queryText.includes(kw)) score += 3;
    }
    if (queryText.length > 60 && ex.tag === "movie_discuss") score += 2;
    return { ex, score, idx };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  const picked = scored.slice(0, Math.max(1, maxCount)).map((s) => s.ex);
  return picked;
}

function readApiKey(cfg) {
  if (cfg.apiKey && String(cfg.apiKey).trim()) return String(cfg.apiKey).trim();
  if (cfg.apiKeyFile) {
    try {
      return fs.readFileSync(cfg.apiKeyFile, "utf8").trim();
    } catch {
      return "";
    }
  }
  return "";
}

function buildSystemPrompt(scene, examples) {
  const exBlock = examples.map((ex) => (
    `【场景】${ex.scene || scene}\n【对话】${ex.context}\n【草稿】${JSON.stringify(ex.draft)}\n【输出】${JSON.stringify(ex.output)}`
  )).join("\n\n");

  return [
    "你是熟人聊天口语转译器，负责把【草稿】改写成真人在 QQ 上随手打字的样子。",
    "",
    "铁律（绝对不能违反）：",
    "1. 严格忠于草稿的事实、立场和记忆点：绝不要脑补草稿里没提过的电影桥段、人物动作或没发生过的事；私聊里绝对不要提“发群/群里”。",
    "2. 彻底抹掉 AI/客服/影评腔：",
    "   - 禁冒号总分结构（如“xx：yy”）、禁工整对偶和转折（“虽然…但是…”“不是…而是…”“爽归爽，但…”）；",
    "   - 禁客服表态（“好的我记下了”“记着了，放心”“我帮你盯着”）、禁采访式反问（“最戳你的是哪段？”“你觉得呢？”）；",
    "   - 禁 emoji、禁波浪号“～”、禁感叹号堆砌、禁夹杂无意义英文单词、禁“写一封情书”“感慨万千”这类文艺腔。",
    "3. 保留信息量与长短弹性：",
    "   - 草稿本来就短，就改得利落随意（1~2 条短句）；",
    "   - 草稿在展开聊电影/观点/故事，就保留所有干货，用大白话自然拆成 2~5 条连贯消息，不要把内容砍成干巴巴的一句。",
    "4. 像真人打字：省略多余主语，句尾不加句号，口语松弛、有轻微停顿或小吐槽。",
    "5. 只输出合法的 JSON 字符串数组，例如 [\"第一条\", \"第二条\"]，不要输出 Markdown 代码块或任何解释。",
    "",
    exBlock ? `参考改写样例（只学松弛口吻和节奏，绝不照抄样例里的内容）：\n\n${exBlock}` : ""
  ].filter(Boolean).join("\n");
}

function parseJsonStringArray(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) return null;
    const cleaned = arr
      .map((x) => String(x ?? "").trim().replace(/。+$/g, ""))
      .filter(Boolean);
    return cleaned.length ? cleaned : null;
  } catch {
    return null;
  }
}

async function callOpenAICompatible(cfg, apiKey, systemPrompt, userPrompt, timeoutMs) {
  const baseUrl = String(cfg.baseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  const body = {
    model: cfg.model || "qwen-plus-latest",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : 0.82,
    presence_penalty: Number.isFinite(Number(cfg.presencePenalty)) ? Number(cfg.presencePenalty) : 0.35,
    max_tokens: Number(cfg.maxTokens) || 500
  };
  if (cfg.provider === "dashscope" || baseUrl.includes("dashscope")) {
    body.enable_thinking = false;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiNative(cfg, apiKey, systemPrompt, userPrompt, timeoutMs) {
  const baseUrl = String(cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const model = cfg.model || "gemini-4-hydrogen";
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : 0.85,
      maxOutputTokens: Number(cfg.maxTokens) || 500,
      responseMimeType: "application/json"
    }
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const opts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal
    };
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("") ?? "";
  } finally {
    clearTimeout(timer);
  }
}

export async function rewriteForHumanMouth({ key, messages, recentMessages = [], cfg = {}, maxMsgs = 8, maxChars = 500, sensitiveRe = null, log = () => {} }) {
  if (!cfg || cfg.enabled !== true) return { messages, rewritten: false };
  if (!Array.isArray(messages) || !messages.length) return { messages, rewritten: false };

  const joined = messages.join("\n");
  if (SKIP_CONTENT_RE.test(joined)) return { messages, rewritten: false };

  const skipShort = Number.isFinite(Number(cfg.skipShortChars)) ? Number(cfg.skipShortChars) : 8;
  if (messages.length === 1 && messages[0].length <= skipShort && !CLICHE_RE.test(messages[0])) {
    return { messages, rewritten: false };
  }

  const apiKey = readApiKey(cfg);
  if (!apiKey) return { messages, rewritten: false };

  const scene = String(key || "").startsWith("private:") ? "私聊" : "群聊";
  const tailCtx = (Array.isArray(recentMessages) ? recentMessages : [])
    .slice(-6)
    .map((m) => {
      const who = m?.isSelf ? "你刚才" : (m?.sender || "对方");
      const txt = String(m?.plain || m?.text || "").trim().slice(0, 120);
      return txt ? `${who}：${txt}` : "";
    })
    .filter(Boolean)
    .join("\n");

  const examples = selectExamples(loadExamples(cfg.examplesFile), `${tailCtx}\n${joined}`, Number(cfg.maxExamples) || 5);
  const systemPrompt = buildSystemPrompt(scene, examples);
  const userPrompt = [
    `【场景】${scene}`,
    tailCtx ? `【最近对话】\n${tailCtx}` : "",
    `【草稿】${JSON.stringify(messages)}`,
    "【输出】"
  ].filter(Boolean).join("\n");

  const timeoutMs = Math.max(1500, Math.min(15000, Number(cfg.timeoutMs) || 6000));
  const t0 = Date.now();
  try {
    const raw = cfg.provider === "gemini"
      ? await callGeminiNative(cfg, apiKey, systemPrompt, userPrompt, timeoutMs)
      : await callOpenAICompatible(cfg, apiKey, systemPrompt, userPrompt, timeoutMs);
    const parsed = parseJsonStringArray(raw);
    if (!parsed) {
      log(`[mouth] 跳过（输出无法解析）(${Date.now() - t0}ms)`);
      return { messages, rewritten: false };
    }
    const clamped = parsed.slice(0, maxMsgs).map((s) => s.slice(0, maxChars)).filter(Boolean);
    if (!clamped.length) return { messages, rewritten: false };
    if (sensitiveRe && clamped.some((s) => sensitiveRe.test(s))) {
      log(`[mouth] 拦截敏感词，回退原草稿 (${key})`);
      return { messages, rewritten: false };
    }
    log(`[mouth] ${key} (${Date.now() - t0}ms, ${cfg.model || "qwen-plus-latest"}): ${JSON.stringify(messages)} => ${JSON.stringify(clamped)}`);
    return { messages: clamped, rewritten: true };
  } catch (err) {
    log(`[mouth] 转译失败，回退原草稿 (${Date.now() - t0}ms): ${err?.message ?? err}`);
    return { messages, rewritten: false };
  }
}
