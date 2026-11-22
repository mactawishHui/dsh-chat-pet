/**
 * meme-matcher.mjs — 零依赖中文拼音 + 近音空耳模糊梗库匹配引擎（ESM，平台无关）
 *
 * 供「普通 QQ 文字聊天 (surf-kb.mjs)」与「实时语音通话 (call-engine.mjs)」共用：
 *   1. 内置 411 个标准普通话音节 ICU 排序锚点（利用 Node/V8 原生 Intl.Collator zh-Hans-CN-u-co-pinyin），
 *      零 npm 依赖，~2μs/字将任意汉字转为标准拼音。
 *   2. 支持汉字精确匹配、全拼同音匹配（哈吉米→哈基米、窝腰烟牌→我要验牌、太酷啦→泰酷辣、你已疾苦→你已急哭）、
 *      近音滑窗模糊匹配（尊都假都→尊嘟假嘟、德学→哲学）以及 2 字短梗/英文梗词边界匹配。
 *   3. 内置常用口语停用词保护 + 韵母重叠校验，确保长句日常聊天零误触发。
 */

import fs from 'node:fs';

const PINYIN_COLLATOR = new Intl.Collator('zh-Hans-CN-u-co-pinyin');

// 411 标准普通话音节 ICU 拼音排序最小锚点表
const RAW_ANCHORS = '吖:a,哎:ai,安:an,肮:ang,凹:ao,丷:ba,挀:bai,扳:ban,邦:bang,勹:bao,卑:bei,奔:ben,伻:beng,屄:bi,边:bian,灬:biao,憋:bie,汃:bin,冫:bing,癶:bo,峬:bu,嚓:ca,偲:cai,参:can,仓:cang,撡:cao,冊:ce,嵾:cen,曽:ceng,叉:cha,芆:chai,辿:chan,伥:chang,抄:chao,车:che,抻:chen,阷:cheng,吃:chi,充:chong,抽:chou,出:chu,歘:chua,揣:chuai,巛:chuan,刅:chuang,吹:chui,旾:chun,逴:chuo,呲:ci,匆:cong,凑:cou,粗:cu,汆:cuan,崔:cui,邨:cun,搓:cuo,咑:da,呆:dai,丹:dan,当:dang,刀:dao,嘚:de,扥:den,灯:deng,氐:di,嗲:dia,敁:dian,刁:diao,爹:die,丁:ding,丟:diu,东:dong,吺:dou,厾:du,耑:duan,垖:dui,吨:dun,多:duo,妸:e,诶:ei,奀:en,鞥:eng,儿:er,发:fa,帆:fan,匚:fang,飞:fei,分:fen,丰:feng,覅:fiao,仏:fo,紑:fou,夫:fu,旮:ga,侅:gai,甘:gan,冈:gang,皋:gao,戈:ge,给:gei,根:gen,刯:geng,工:gong,勾:gou,估:gu,瓜:gua,乖:guai,关:guan,光:guang,归:gui,丨:gun,呙:guo,哈:ha,咍:hai,佄:han,夯:hang,茠:hao,诃:he,黒:hei,拫:hen,亨:heng,噷:hm,叿:hong,齁:hou,乎:hu,花:hua,怀:huai,欢:huan,巟:huang,灰:hui,昏:hun,吙:huo,丌:ji,加:jia,戋:jian,江:jiang,艽:jiao,阶:jie,巾:jin,坕:jing,冂:jiong,丩:jiu,凥:ju,姢:juan,噘:jue,军:jun,咔:ka,开:kai,刊:kan,忼:kang,尻:kao,匼:ke,剋:kei,肎:ken,劥:keng,空:kong,抠:kou,扝:ku,夸:kua,蒯:kuai,宽:kuan,匡:kuang,亏:kui,坤:kun,扩:kuo,垃:la,来:lai,兰:lan,啷:lang,捞:lao,仂:le,勒:lei,崚:leng,哩:li,俩:lia,奁:lian,良:liang,撩:liao,毟:lie,拎:lin,伶:ling,溜:liu,囖:lo,龙:long,瞜:lou,噜:lu,娈:luan,掠:lue,抡:lun,啰:luo,呣:m,妈:ma,埋:mai,嫚:man,牤:mang,猫:mao,嚒:me,呅:mei,椚:men,擝:meng,咪:mi,宀:mian,喵:miao,乜:mie,民:min,名:ming,谬:miu,摸:mo,哞:mou,毪:mu,拏:na,腉:nai,囡:nan,囔:nang,孬:nao,疒:ne,娞:nei,恁:nen,能:neng,嗯:ng,妮:ni,拈:nian,娘:niang,鸟:niao,捏:nie,囜:nin,宁:ning,妞:niu,农:nong,羺:nou,奴:nu,奻:nuan,疟:nue,黁:nun,郍:nuo,喔:o,讴:ou,妑:pa,拍:pai,眅:pan,乓:pang,抛:pao,呸:pei,喷:pen,匉:peng,丕:pi,囨:pian,剽:piao,氕:pie,姘:pin,乒:ping,钋:po,剖:pou,仆:pu,七:qi,掐:qia,千:qian,呛:qiang,悄:qiao,苆:qie,亲:qin,靑:qing,卭:qiong,丘:qiu,区:qu,奍:quan,炔:que,夋:qun,呥:ran,穣:rang,娆:rao,惹:re,人:ren,扔:reng,日:ri,戎:rong,厹:rou,邚:ru,挼:rua,堧:ruan,婑:rui,瞤:run,捼:ruo,仨:sa,毢:sai,三:san,桒:sang,掻:sao,閪:se,森:sen,僧:seng,杀:sha,筛:shai,山:shan,伤:shang,弰:shao,奢:she,谁:shei,申:shen,升:sheng,尸:shi,収:shou,书:shu,刷:shua,衰:shuai,闩:shuan,双:shuang,脽:shui,吮:shun,说:shuo,厶:si,忪:song,凁:sou,苏:su,狻:suan,夊:sui,孙:sun,唆:suo,他:ta,囼:tai,坍:tan,汤:tang,夲:tao,忑:te,熥:teng,剔:ti,天:tian,旫:tiao,帖:tie,厅:ting,囲:tong,偷:tou,凸:tu,湍:tuan,推:tui,吞:tun,乇:tuo,屲:wa,歪:wai,弯:wan,尢:wang,危:wei,昷:wen,翁:weng,挝:wo,乌:wu,夕:xi,呷:xia,仙:xian,乡:xiang,灱:xiao,些:xie,心:xin,星:xing,凶:xiong,休:xiu,吁:xu,吅:xuan,削:xue,坃:xun,丫:ya,恹:yan,央:yang,幺:yao,倻:ye,一:yi,囙:yin,应:ying,哟:yo,佣:yong,优:you,込:yu,囦:yuan,曰:yue,晕:yun,帀:za,災:zai,兂:zan,匨:zang,傮:zao,则:ze,贼:zei,怎:zen,増:zeng,扎:zha,夈:zhai,枬:zhan,张:zhang,佋:zhao,蜇:zhe,贞:zhen,凧:zheng,之:zhi,中:zhong,州:zhou,朱:zhu,抓:zhua,跩:zhuai,专:zhuan,妆:zhuang,隹:zhui,宒:zhun,拙:zhuo,乲:zi,宗:zong,邹:zou,租:zu,钻:zuan,厜:zui,尊:zun,嘬:zuo';
const ANCHORS = RAW_ANCHORS.split(',').map((item) => {
  const idx = item.indexOf(':');
  return [item.slice(0, idx), item.slice(idx + 1)];
});

const CHAR_PY_CACHE = new Map();

export function charToPinyin(ch) {
  if (!ch) return '';
  const cached = CHAR_PY_CACHE.get(ch);
  if (cached !== undefined) return cached;
  const code = ch.charCodeAt(0);
  if (code < 0x4e00 || code > 0x9fff) return '';
  let lo = 0;
  let hi = ANCHORS.length - 1;
  let ans = '';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (PINYIN_COLLATOR.compare(ch, ANCHORS[mid][0]) >= 0) {
      ans = ANCHORS[mid][1];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  CHAR_PY_CACHE.set(ch, ans);
  return ans;
}

/**
 * 将中英混合文本拆成「拼音音节 + 英文词」Token 序列
 * 例："city不city" -> ["city", "bu", "city"]；"德学" -> ["de", "xue"]
 */
export function textToPinyinTokens(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];
  let asciiBuf = '';
  const flushAscii = () => {
    if (asciiBuf) {
      tokens.push(asciiBuf);
      asciiBuf = '';
    }
  };
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) {
      flushAscii();
      const py = charToPinyin(ch);
      if (py) tokens.push(py);
    } else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      asciiBuf += ch;
    } else {
      flushAscii();
    }
  }
  flushAscii();
  return tokens;
}

function fuzzyNormSyllable(s) {
  if (!s) return '';
  // 折叠常见南北方/路边 ASR 易混音：平翘舌(zh/ch/sh->z/c/s)、前后鼻音(ng->n)
  return s
    .replace(/^zh/, 'z')
    .replace(/^ch/, 'c')
    .replace(/^sh/, 's')
    .replace(/ng$/, 'n');
}

function syllableFinal(s) {
  const m = String(s || '').match(/[aeiouüv]+.*$/);
  return m ? m[0] : s;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[lb];
}

function normalizePlain(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

// 防止极短日常口语误匹配短梗
const SHORT_STOPWORDS = new Set([
  '知道', '什么', '怎么', '没有', '不是', '可以', '真的', '这个', '那个', '现在',
  '今天', '明天', '晚上', '早上', '吃饭', '睡觉', '干嘛', '为啥', '为什么', '不错',
  '好的', '行吧', '哈哈', '呵呵', '嗯嗯', '是的', '对的', '问了', '笑了', '看看',
  '就是', '然后', '但是', '不过', '因为', '所以', '已经', '觉得', '感觉', '意思'
]);

function isAsciiWord(s) {
  return /^[a-z0-9]+$/.test(s);
}

function hasAsciiWordBoundary(haystackLower, word) {
  const escaped = word.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(haystackLower);
}

const MODAL_PARTICLES = new Set(['的', '了', '吗', '嘛', '呢', '吧', '啊', '呀', '哈', '哦', '噢', '啦', '呗', '咧', '么']);

function extractCharTokens(text) {
  const s = String(text || '').toLowerCase();
  const chars = [];
  let asciiBuf = '';
  const flush = () => { if (asciiBuf) { chars.push(asciiBuf); asciiBuf = ''; } };
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) { flush(); chars.push(ch); }
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) { asciiBuf += ch; }
    else { flush(); }
  }
  flush();
  return chars;
}

function syllableInitial(s) {
  const m = String(s || '').match(/^(zh|ch|sh|[bcdfghjklmnpqrstwxyz])/);
  return m ? m[1] : '';
}

function matchPhraseScore(qPlain, qRawLower, qTokens, qFuzzy, qChars, candRaw, { strictForLongUtterance = false } = {}) {
  const cPlain = normalizePlain(candRaw);
  if (!cPlain || cPlain.length < 2) return { score: 0, type: '' };
  // 去掉模板占位符（如 "oo" / "xx"）太短的碎片
  const cClean = cPlain.replace(/(?:oo|xx)/g, '');
  if (cClean.length < 2) return { score: 0, type: '' };
  if (SHORT_STOPWORDS.has(cClean)) return { score: 0, type: '' };

  // 1. 精确文本命中
  if (qPlain === cPlain || qPlain === cClean) return { score: 100, type: 'exact' };

  // 2. 英文词边界精确命中（支持 "Man" / "Van" / "city" / "emo" 等 3+ 字母词）
  if (isAsciiWord(cClean)) {
    if (cClean.length >= 3 && hasAsciiWordBoundary(qRawLower, cClean)) {
      return { score: 84, type: 'ascii_word' };
    }
    return { score: 0, type: '' };
  }

  // 3. 汉字子串命中（放开 2 字非停用词短梗！）
  if (cClean.length >= 2 && qPlain.includes(cClean)) {
    return { score: cClean.length >= 3 ? 88 : 78, type: 'substring' };
  }
  if (!strictForLongUtterance && qPlain.length >= 2 && cClean.includes(qPlain)) {
    return { score: qPlain.length >= 3 ? 72 : 58, type: 'reverse_sub' };
  }

  // 4. 拼音音节匹配（同音空耳 & 近音滑窗模糊纠错）
  const cTokens = textToPinyinTokens(cClean);
  const cChars = extractCharTokens(cClean);
  const L = cTokens.length;
  if (L < 2 || qTokens.length < L) return { score: 0, type: '' };
  const cFuzzy = cTokens.map(fuzzyNormSyllable);
  const cFuzzyJoined = cFuzzy.join('');

  const edgeIsUnmatchedParticle = (startIdx) => {
    if (!strictForLongUtterance || qChars.length !== qTokens.length || cChars.length !== L) return false;
    const firstQ = qChars[startIdx];
    const lastQ = qChars[startIdx + L - 1];
    if (MODAL_PARTICLES.has(firstQ) && firstQ !== cChars[0]) return true;
    if (MODAL_PARTICLES.has(lastQ) && lastQ !== cChars[L - 1]) return true;
    return false;
  };

  // 4a. 完整拼音序列滑窗 100% 命中（如 哈吉米==哈基米，窝腰烟牌==我要验牌，太酷啦==泰酷辣）
  if (L >= 3 || qTokens.length <= 10 || !strictForLongUtterance) {
    for (let i = 0; i <= qTokens.length - L; i++) {
      let exactAll = true;
      let fuzzyAll = true;
      for (let k = 0; k < L; k++) {
        if (qTokens[i + k] !== cTokens[k]) exactAll = false;
        if (qFuzzy[i + k] !== cFuzzy[k]) { fuzzyAll = false; break; }
      }
      if (exactAll) return { score: L >= 3 ? 86 : 78, type: 'pinyin' };
      if (fuzzyAll && !edgeIsUnmatchedParticle(i) && (L >= 3 || !strictForLongUtterance || qTokens.length <= 7)) {
        return { score: L >= 3 ? 80 : 72, type: 'fuzzy_pinyin' };
      }
    }
  }

  // 4b. 近音编辑距离滑窗（如 尊都假都->尊嘟假嘟、德学->哲学；严格要求声/韵母重叠+语气助词防护）
  const allowEdit = L >= 3 || (!strictForLongUtterance && L === 2) || (L === 2 && qTokens.length <= 8);
  if (allowEdit && cFuzzyJoined.length >= 4) {
    let bestSim = 0;
    for (let i = 0; i <= qFuzzy.length - L; i++) {
      if (edgeIsUnmatchedParticle(i)) continue;
      let finalMatches = 0;
      let initMatches = 0;
      let winStr = '';
      for (let k = 0; k < L; k++) {
        winStr += qFuzzy[i + k];
        if (syllableFinal(qFuzzy[i + k]) === syllableFinal(cFuzzy[k])) finalMatches++;
        if (syllableInitial(qFuzzy[i + k]) === syllableInitial(cFuzzy[k])) initMatches++;
      }
      // 2 字词要求 2/2 韵母全一致（de xue vs ze xue）；3+ 字词允许韵母或声母高一致（如 尊都假都 vs 尊嘟假嘟 4/4 声母一致）
      const phoneticOk = L === 2
        ? (finalMatches === 2)
        : (finalMatches >= Math.ceil(L * 0.6) || (initMatches === L && finalMatches >= Math.floor(L * 0.5)));
      if (!phoneticOk) continue;
      const maxLen = Math.max(winStr.length, cFuzzyJoined.length);
      const dist = levenshtein(winStr, cFuzzyJoined);
      const sim = 1 - dist / maxLen;
      if (sim > bestSim) bestSim = sim;
    }
    const minSim = L === 2 ? 0.80 : 0.80;
    if (bestSim >= minSim) {
      return { score: Math.round(52 + bestSim * 26), type: 'fuzzy_pinyin' };
    }
  }

  return { score: 0, type: '' };
}

export function scoreMemeEntry(meme, queryText, { strictForLongUtterance = false } = {}) {
  const qRawLower = String(queryText || '').trim().toLowerCase();
  const qPlain = normalizePlain(qRawLower);
  if (!qPlain || qPlain.length < 2) return { score: 0, matchType: '', matchedPhrase: '' };
  const qTokens = textToPinyinTokens(qRawLower);
  const qFuzzy = qTokens.map(fuzzyNormSyllable);
  const qChars = extractCharTokens(qRawLower);

  if (meme.id && String(meme.id).toLowerCase() === qRawLower) {
    return { score: 100, matchType: 'id', matchedPhrase: meme.id };
  }

  let best = { score: 0, matchType: '', matchedPhrase: '' };
  const tryCand = (phrase, weight) => {
    if (!phrase) return;
    const r = matchPhraseScore(qPlain, qRawLower, qTokens, qFuzzy, qChars, phrase, { strictForLongUtterance });
    const weighted = Math.round(r.score * weight);
    if (weighted > best.score) {
      best = { score: weighted, matchType: r.type, matchedPhrase: phrase };
    }
  };

  tryCand(meme.name, 1.0);
  if (meme.wikiTitle && meme.wikiTitle !== meme.name) tryCand(meme.wikiTitle, 0.98);
  for (const a of (Array.isArray(meme.aliases) ? meme.aliases : [])) tryCand(a, 0.94);
  for (const k of (Array.isArray(meme.searchKeywords) ? meme.searchKeywords : [])) {
    if (String(k).length <= 14) tryCand(k, 0.82);
  }
  for (const rep of (Array.isArray(meme.replies) ? meme.replies : [])) {
    const cleanRep = String(rep || '').replace(/[（(][^）)]*[）)]/g, '').trim();
    if (cleanRep.length >= 3 && cleanRep.length <= 12) tryCand(cleanRep, 0.80);
  }

  // 非实时长句模式（如文字主动查梗）再兜底搜释义/来源文本
  if (!strictForLongUtterance && best.score < 35) {
    for (const tag of [...(meme.mood || []), ...(meme.imageTags || [])]) {
      const tl = String(tag || '').toLowerCase();
      if (tl && (tl.includes(qRawLower) || qRawLower.includes(tl))) {
        best = { score: Math.max(best.score, 24), matchType: 'tag', matchedPhrase: tag };
      }
    }
    const desc = `${meme.origin || ''} ${meme.meaning || ''} ${meme.usage || ''} ${meme.imageTitle || ''}`.toLowerCase();
    if (qRawLower.length >= 2 && desc.includes(qRawLower)) {
      best = { score: Math.max(best.score, 18), matchType: 'desc', matchedPhrase: meme.name };
    }
  }
  return best;
}

export function matchMemesInKb(memes, queryText, { strictForLongUtterance = false, minScore = 1 } = {}) {
  if (!Array.isArray(memes) || !memes.length) return [];
  const results = [];
  for (const meme of memes) {
    const m = scoreMemeEntry(meme, queryText, { strictForLongUtterance });
    if (m.score >= minScore) results.push({ meme, ...m });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── 0ms 内存 mtime 缓存快速查梗（供实时通话引擎每轮直接调用） ──────────────────
const KB_CACHE = new Map();

export function lookupLocalMemeFast(utterance, memeKbPath = '/opt/qq-bridge/state/meme-kb.json', { minScore = 62 } = {}) {
  const text = String(utterance || '').trim();
  if (!text || text.length < 2) return null;
  try {
    const st = fs.statSync(memeKbPath);
    let cached = KB_CACHE.get(memeKbPath);
    if (!cached || cached.mtimeMs !== st.mtimeMs) {
      const kb = JSON.parse(fs.readFileSync(memeKbPath, 'utf8'));
      cached = { mtimeMs: st.mtimeMs, memes: Array.isArray(kb?.memes) ? kb.memes : [] };
      KB_CACHE.set(memeKbPath, cached);
    }
    const hits = matchMemesInKb(cached.memes, text, { strictForLongUtterance: true, minScore });
    if (!hits.length) return null;
    const top = hits[0];
    return {
      name: top.meme.name,
      meaning: top.meme.meaning || '',
      replies: Array.isArray(top.meme.replies) ? top.meme.replies.slice(0, 4) : [],
      imageId: top.meme.imageId || null,
      score: top.score,
      matchType: top.matchType,
      matchedPhrase: top.matchedPhrase,
    };
  } catch {
    return null;
  }
}
