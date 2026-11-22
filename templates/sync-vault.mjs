import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BRIDGE_ROOT = '/opt/qq-bridge';
const VAULT_DIR = process.env.VAULT_DIR || '/opt/qq-vault-repo';
const MEME_DIR = path.join(BRIDGE_ROOT, 'audio', 'memes');
const DRAW_DIR = path.join(BRIDGE_ROOT, 'audio', 'images');

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function syncDirFiles(srcDir, dstDir, exts) {
  fs.mkdirSync(dstDir, { recursive: true });
  const srcFiles = fs.existsSync(srcDir)
    ? fs.readdirSync(srcDir).filter((f) => exts.has(path.extname(f).toLowerCase()))
    : [];
  const srcSet = new Set(srcFiles);

  // 复制新增或变更的文件
  for (const f of srcFiles) {
    const s = path.join(srcDir, f);
    const d = path.join(dstDir, f);
    const stS = fs.statSync(s);
    if (!stS.isFile()) continue;
    let needCopy = true;
    if (fs.existsSync(d)) {
      const stD = fs.statSync(d);
      if (stD.size === stS.size && Math.floor(stD.mtimeMs) === Math.floor(stS.mtimeMs)) {
        needCopy = false;
      }
    }
    if (needCopy) {
      fs.copyFileSync(s, d);
      fs.utimesSync(d, stS.atime, stS.mtime);
    }
  }

  // 清理已从源目录删除的文件
  for (const f of fs.readdirSync(dstDir)) {
    if (exts.has(path.extname(f).toLowerCase()) && !srcSet.has(f)) {
      try { fs.unlinkSync(path.join(dstDir, f)); } catch {}
    }
  }
  return srcFiles.sort();
}

function sanitizeSocialV2(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const clone = JSON.parse(JSON.stringify(raw));
  if (clone.conversations && typeof clone.conversations === 'object') {
    for (const conv of Object.values(clone.conversations)) {
      if (conv && typeof conv === 'object') {
        delete conv.agentToken;
      }
    }
  }
  return clone;
}

function buildMemesMarkdown(kb) {
  const memes = Array.isArray(kb.memes) ? [...kb.memes].reverse() : [];
  const lines = [
    '# 梗知识库与梗图画廊',
    '',
    `> 共收录 **${memes.length}** 个梗，其中带梗图 **${memes.filter((m) => m.imageFile).length}** 个。更新时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '',
    '---',
    ''
  ];
  for (const m of memes) {
    const aliases = Array.isArray(m.aliases) && m.aliases.length ? `（别名：${m.aliases.join(' / ')}）` : '';
    lines.push(`## ${m.name}${aliases}`);
    lines.push('');
    lines.push(`- **来源**：\`${m.source || 'unknown'}\`　|　**ID**：\`${m.id || ''}\`　|　**情绪标签**：${(m.mood || []).join('、') || '玩梗'}`);
    if (m.origin) lines.push(`- **出处**：${m.origin}`);
    if (m.meaning) lines.push(`- **含义**：${m.meaning}`);
    if (m.usage) lines.push(`- **用法**：${m.usage}`);
    if (m.biliUrl) lines.push(`- **B站原视频**：${m.biliUrl}`);
    if (m.imageFile) {
      const rel = `memes/${path.basename(m.imageFile)}`;
      lines.push('');
      lines.push(`<img src="${rel}" alt="${m.name}" width="240" />`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

function buildDrawingsMarkdown(drawFiles) {
  const lines = [
    '# 绘画作品集',
    '',
    `> 共收录 **${drawFiles.length}** 张画作。更新时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    ''
  ];
  if (!drawFiles.length) {
    lines.push('暂无保存的绘画作品。');
  } else {
    for (const f of [...drawFiles].reverse()) {
      lines.push(`### ${f}`);
      lines.push('');
      lines.push(`<img src="drawings/${f}" alt="${f}" width="360" />`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function readJsonl(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

function buildDiaryMarkdown(entries) {
  const lines = [
    '# 小鲸鲸的日记',
    '',
    `> 共 **${entries.length}** 篇。每晚由她自己根据当天的见闻写成，发在 QQ 空间（仅好友可见）。更新时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    ''
  ];
  if (!entries.length) lines.push('还没有日记。');
  for (const e of [...entries].reverse()) {
    lines.push(`## ${e.day}${e.moodStyle ? ` · \`${e.moodStyle}\`` : ''}`);
    lines.push('');
    lines.push(String(e.content || '').trim());
    lines.push('');
    const imgs = Array.isArray(e.images) && e.images.length ? e.images : (e.image ? [e.image] : []);
    if (imgs.length) {
      const tags = imgs.map((im) => {
        const f = path.basename(im);
        const dir = im.includes('/memes/') ? 'memes' : 'drawings';
        return `<img src="${dir}/${f}" alt="${f}" width="320" />`;
      });
      lines.push(tags.join(' '));
      lines.push('');
    }
  }
  return lines.join('\n');
}

function buildReadme({ kb, feed, stickers, slang, memeFiles, drawFiles, diaryCount = 0 }) {
  const memes = Array.isArray(kb.memes) ? kb.memes : [];
  const hots = Array.isArray(feed.hotItems) ? feed.hotItems : [];
  const stickerCount = Array.isArray(stickers) ? stickers.length : (Array.isArray(stickers?.entries) ? stickers.entries.length : 0);
  const slangCount = Array.isArray(slang) ? slang.length : 0;

  const lines = [
    '# DSH Chat Pet · 私有知识与资产库',
    '',
    `> 自动由远程服务器增量同步（已脱敏，不含任何 API Key / Token / 密码）。最后同步：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '',
    '## 资产概览',
    '',
    '| 类别 | 数量 | 浏览入口 |',
    '| --- | ---: | --- |',
    `| 梗知识库 | ${memes.length} 条 | [MEMES.md](./MEMES.md) / [knowledge/meme-kb.json](./knowledge/meme-kb.json) |`,
    `| 梗图 / GIF | ${memeFiles.length} 张 | [MEMES.md](./MEMES.md) / [memes/](./memes) |`,
    `| 绘画作品 | ${drawFiles.length} 张 | [DRAWINGS.md](./DRAWINGS.md) / [drawings/](./drawings) |`,
    `| 日记（说说） | ${diaryCount} 篇 | [DIARY.md](./DIARY.md) / [memory/life-journal.jsonl](./memory/life-journal.jsonl) |`,
    `| QQ 收藏表情元数据 | ${stickerCount} 条 | [knowledge/stickers.json](./knowledge/stickers.json) |`,
    `| 群黑话候选/词典 | ${slangCount} 条 | [knowledge/slang.json](./knowledge/slang.json) |`,
    '| 长期印象与对话历史 | 实时同步 | [memory/social-v2.json](./memory/social-v2.json) |',
    '',
    '## 最新刷到的热点',
    ''
  ];
  for (const h of hots.slice(0, 10)) {
    lines.push(`- **[${h.tag || h.source}]** ${h.title} — ${h.gist}`);
  }
  if (!hots.length) lines.push('- 暂无热点记录');
  lines.push('');
  return lines.join('\n');
}

async function git(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: VAULT_DIR, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function main() {
  if (!fs.existsSync(path.join(VAULT_DIR, '.git'))) {
    throw new Error(`Vault git repo not initialized at ${VAULT_DIR}`);
  }

  const IMG_EXTS = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp']);
  const memeFiles = syncDirFiles(MEME_DIR, path.join(VAULT_DIR, 'memes'), IMG_EXTS);
  const drawFiles = syncDirFiles(DRAW_DIR, path.join(VAULT_DIR, 'drawings'), IMG_EXTS);

  const kbRaw = readJson(path.join(BRIDGE_ROOT, 'state', 'meme-kb.json'), { updatedAt: null, memes: [] });
  const kbPortable = {
    ...kbRaw,
    memes: (kbRaw.memes || []).map((m) => ({
      ...m,
      imageFile: m.imageFile ? `memes/${path.basename(m.imageFile)}` : null
    }))
  };
  const feed = readJson(path.join(BRIDGE_ROOT, 'state', 'daily-feed.json'), { updatedAt: null, hotItems: [], recentMemes: [] });
  const stickers = readJson(path.join(BRIDGE_ROOT, 'state', 'stickers.json'), []);
  const slang = readJson(path.join(BRIDGE_ROOT, 'state', 'slang.json'), []);
  const socialV2 = sanitizeSocialV2(readJson(path.join(BRIDGE_ROOT, 'state', 'social-v2.json'), {}));

  writeFile(path.join(VAULT_DIR, 'knowledge', 'meme-kb.json'), JSON.stringify(kbPortable, null, 2) + '\n');
  writeFile(path.join(VAULT_DIR, 'knowledge', 'daily-feed.json'), JSON.stringify(feed, null, 2) + '\n');
  writeFile(path.join(VAULT_DIR, 'knowledge', 'stickers.json'), JSON.stringify(stickers, null, 2) + '\n');
  writeFile(path.join(VAULT_DIR, 'knowledge', 'slang.json'), JSON.stringify(slang, null, 2) + '\n');
  writeFile(path.join(VAULT_DIR, 'memory', 'social-v2.json'), JSON.stringify(socialV2, null, 2) + '\n');

  writeFile(path.join(VAULT_DIR, 'MEMES.md'), buildMemesMarkdown(kbPortable));
  writeFile(path.join(VAULT_DIR, 'DRAWINGS.md'), buildDrawingsMarkdown(drawFiles));
  const diaries = readJsonl(path.join(BRIDGE_ROOT, 'state', 'diary.jsonl'));
  writeFile(path.join(VAULT_DIR, 'DIARY.md'), buildDiaryMarkdown(diaries));
  const journal = readJsonl(path.join(BRIDGE_ROOT, 'state', 'life-journal.jsonl'));
  writeFile(path.join(VAULT_DIR, 'memory', 'life-journal.jsonl'), journal.map((r) => JSON.stringify(r)).join('\n') + (journal.length ? '\n' : ''));
  const milestones = readJson(path.join(BRIDGE_ROOT, 'state', 'milestones.json'), null);
  if (milestones) writeFile(path.join(VAULT_DIR, 'memory', 'milestones.json'), JSON.stringify(milestones, null, 2) + '\n');
  const memArchive = readJsonl(path.join(BRIDGE_ROOT, 'state', 'memory-archive.jsonl'));
  if (memArchive.length) {
    writeFile(path.join(VAULT_DIR, 'memory', 'memory-archive.jsonl'), memArchive.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  writeFile(path.join(VAULT_DIR, 'README.md'), buildReadme({ kb: kbPortable, feed, stickers, slang, memeFiles, drawFiles, diaryCount: diaries.length }));

  await git(['add', '-A']);
  const status = await git(['status', '--porcelain']);
  if (!status) {
    console.log('[vault] 无新变更，跳过推送');
    return;
  }
  const ts = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const msg = `sync: ${ts} (memes=${kbPortable.memes.length}, imgs=${memeFiles.length}, draws=${drawFiles.length})`;
  await git(['commit', '-m', msg]);
  await git(['push', 'origin', 'main']);
  console.log(`[vault] 已同步推送到 GitHub 私有库：${msg}`);
}

main().catch((err) => {
  console.error('[vault] 同步失败:', err?.stderr || err?.message || err);
  process.exit(1);
});
