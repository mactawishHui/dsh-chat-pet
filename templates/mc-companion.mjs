/**
 * mc-companion.mjs — 小鲸鲸 Minecraft 1.21.1 具身联机队友（Mineflayer + 标准 Neuro-API 客户端）
 *
 * 设计原则：
 *   1. 本身就是标准 Neuro-API v1 WebSocket 客户端（直连 game-hub.mjs），与后续 Steam Neuro-SDK Mod 共用同一大脑与语音链路
 *   2. 严禁 LLM 动态 eval 写代码；全部能力由「快环本地生存反射 + 16 个白名单安全技能」提供
 *   3. 内置中英文方块/物品别名映射（木头/铁矿/煤/石头/工作台/火把/面包…），对语音口语指令极其友好
 *   4. 针对 Mineflayer 1.21.1 稳定性加固：所有寻路与采集严格加超时熔断、卡死自愈、工具自动切换
 */

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

const { pathfinder, Movements, goals } = pathfinderPkg;
const { GoalNear, GoalFollow, GoalBlock, GoalXZ } = goals;

const MC_HOST = process.env.MC_HOST || '127.0.0.1';
const MC_PORT = Number(process.env.MC_PORT || 25566);
const MC_VERSION = process.env.MC_VERSION || '1.21.1';
const MC_USERNAME = process.env.MC_USERNAME || 'xiaojingjing';
const MC_AUTH = process.env.MC_AUTH || 'offline';
const NEURO_WS_URL = process.env.NEURO_WS_URL || 'ws://127.0.0.1:3350/ws/neuro';
const HOME_FILE = process.env.MC_HOME_FILE || '/opt/qq-bridge/state/mc-home.json';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), `[mc-bot:${MC_USERNAME}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOSTILE_MOBS = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider',
  'enderman', 'witch', 'slime', 'phantom', 'pillager', 'vindicator', 'blaze', 'ghast', 'piglin_brute',
  'hoglin', 'zombified_piglin', 'wither_skeleton', 'silverfish', 'magma_cube', 'breeze'
]);

const FOOD_PRIORITY = [
  'golden_carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_salmon',
  'cooked_chicken', 'cooked_cod', 'baked_potato', 'bread', 'apple', 'cooked_rabbit',
  'carrot', 'sweet_berries', 'melon_slice', 'cookie', 'beef', 'porkchop', 'chicken', 'mutton'
];

const BLOCK_ALIASES = {
  wood: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
  log: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
  木头: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
  原木: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
  树: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
  橡木: ['oak_log'],
  白桦木: ['birch_log'],
  云杉木: ['spruce_log'],
  石头: ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate'],
  圆石: ['stone', 'cobblestone'],
  stone: ['stone', 'cobblestone', 'deepslate'],
  煤: ['coal_ore', 'deepslate_coal_ore'],
  煤炭: ['coal_ore', 'deepslate_coal_ore'],
  煤矿: ['coal_ore', 'deepslate_coal_ore'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  铁: ['iron_ore', 'deepslate_iron_ore'],
  铁矿: ['iron_ore', 'deepslate_iron_ore'],
  iron: ['iron_ore', 'deepslate_iron_ore'],
  铜: ['copper_ore', 'deepslate_copper_ore'],
  铜矿: ['copper_ore', 'deepslate_copper_ore'],
  金: ['gold_ore', 'deepslate_gold_ore'],
  金矿: ['gold_ore', 'deepslate_gold_ore'],
  钻石: ['diamond_ore', 'deepslate_diamond_ore'],
  钻石矿: ['diamond_ore', 'deepslate_diamond_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  红石: ['redstone_ore', 'deepslate_redstone_ore'],
  青金石: ['lapis_ore', 'deepslate_lapis_ore'],
  泥土: ['dirt', 'grass_block'],
  土: ['dirt', 'grass_block'],
  沙子: ['sand'],
  砂砾: ['gravel'],
  甘蔗: ['sugar_cane'],
  小麦: ['wheat'],
};

const ITEM_ALIASES = {
  木头: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log'],
  原木: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log'],
  木板: ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'cherry_planks'],
  planks: ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'cherry_planks'],
  木棍: ['stick'],
  工作台: ['crafting_table'],
  熔炉: ['furnace'],
  箱子: ['chest'],
  火把: ['torch'],
  床: ['white_bed', 'red_bed', 'blue_bed', 'light_blue_bed'],
  木镐: ['wooden_pickaxe'],
  石镐: ['stone_pickaxe'],
  铁镐: ['iron_pickaxe'],
  钻石镐: ['diamond_pickaxe'],
  木斧: ['wooden_axe'],
  石斧: ['stone_axe'],
  铁斧: ['iron_axe'],
  木剑: ['wooden_sword'],
  石剑: ['stone_sword'],
  铁剑: ['iron_sword'],
  钻石剑: ['diamond_sword'],
  盾牌: ['shield'],
  面包: ['bread'],
  苹果: ['apple'],
  牛肉: ['cooked_beef', 'beef'],
  猪肉: ['cooked_porkchop', 'porkchop'],
  煤炭: ['coal', 'charcoal'],
  煤: ['coal', 'charcoal'],
  铁矿: ['raw_iron', 'iron_ingot'],
  铁锭: ['iron_ingot'],
  粗铁: ['raw_iron'],
  钻石: ['diamond'],
  圆石: ['cobblestone'],
  石头: ['cobblestone', 'stone'],
  泥土: ['dirt'],
  羊毛: ['white_wool', 'light_gray_wool', 'gray_wool', 'black_wool', 'brown_wool'],
};

const MOB_ALIASES = {
  僵尸: ['zombie', 'husk', 'drowned'],
  骷髅: ['skeleton', 'stray'],
  小白: ['skeleton'],
  苦力怕: ['creeper'],
  蜘蛛: ['spider', 'cave_spider'],
  末影人: ['enderman'],
  猪: ['pig'],
  牛: ['cow'],
  羊: ['sheep'],
  鸡: ['chicken'],
};

function resolveNames(raw, aliasMap) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return [];
  if (aliasMap[s]) return aliasMap[s];
  for (const [k, vals] of Object.entries(aliasMap)) {
    if (s.includes(k) || k.includes(s)) return vals;
  }
  return [s.replace(/\s+/g, '_')];
}

function loadHome() {
  try {
    const d = JSON.parse(fs.readFileSync(HOME_FILE, 'utf8'));
    if (Number.isFinite(d?.x) && Number.isFinite(d?.y) && Number.isFinite(d?.z)) return d;
  } catch {}
  return null;
}

function saveHome(pos) {
  try {
    fs.mkdirSync(path.dirname(HOME_FILE), { recursive: true });
    fs.writeFileSync(HOME_FILE, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), savedAt: new Date().toISOString() }, null, 2) + '\n');
  } catch {}
}

function describeTime(timeOfDay) {
  const t = Number(timeOfDay || 0) % 24000;
  if (t < 1000) return '清晨';
  if (t < 6000) return '上午';
  if (t < 11500) return '下午';
  if (t < 13000) return '黄昏(马上天黑)';
  if (t < 22500) return '夜晚(注意怪物)';
  return '黎明';
}

const REGISTERED_ACTIONS = [
  {
    name: 'follow_player',
    description: '持续跟随指定玩家（默认跟随最近的真人玩家）',
    schema: {
      type: 'object',
      properties: {
        player: { type: 'string', description: '玩家游戏名（可不填，自动选最近人类玩家）' },
        distance: { type: 'integer', minimum: 2, maximum: 8, description: '保持距离（默认3格）' },
      },
    },
  },
  {
    name: 'go_to_player',
    description: '立刻跑到指定玩家身边并停下',
    schema: {
      type: 'object',
      properties: {
        player: { type: 'string', description: '玩家游戏名（可不填）' },
      },
    },
  },
  {
    name: 'gather_resource',
    description: '在周围寻找并采集指定方块资源（如 木头/石头/煤炭/铁矿/钻石/泥土/沙子 等）',
    schema: {
      type: 'object',
      properties: {
        resource: { type: 'string', description: '资源名（中文或英文方块名，如 木头 / 铁矿 / 煤炭 / oak_log）' },
        count: { type: 'integer', minimum: 1, maximum: 16, description: '采集数量（默认4个）' },
      },
      required: ['resource'],
    },
  },
  {
    name: 'craft_item',
    description: '合成物品（如 木板/木棍/工作台/火把/木镐/石镐/石剑/铁镐/熔炉/箱子 等，需要工作台时会自动寻找附近工作台）',
    schema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '物品名（中文或英文 ID）' },
        count: { type: 'integer', minimum: 1, maximum: 16, description: '合成次数（默认1）' },
      },
      required: ['item'],
    },
  },
  {
    name: 'smelt_item',
    description: '使用附近的熔炉烧矿或烤肉（如 粗铁/生牛肉/生猪肉/原木）',
    schema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '要烧制的物品名' },
        count: { type: 'integer', minimum: 1, maximum: 16, description: '数量（默认4）' },
      },
      required: ['item'],
    },
  },
  {
    name: 'give_item',
    description: '走到玩家面前并把背包里指定物品扔给他',
    schema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '物品名（中文或英文 ID）' },
        player: { type: 'string', description: '目标玩家名（可不填）' },
        count: { type: 'integer', minimum: 1, maximum: 64, description: '数量（不填默认全给或给一半）' },
      },
      required: ['item'],
    },
  },
  {
    name: 'equip_item',
    description: '把背包里的武器/工具/火把/方块拿到手上或穿上护甲',
    schema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '物品名' },
      },
      required: ['item'],
    },
  },
  {
    name: 'eat_food',
    description: '立刻吃背包里的食物回复饥饿度与血量',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'guard_player',
    description: '开启贴身保镖模式：跟着玩家并自动迎击靠近的怪物',
    schema: {
      type: 'object',
      properties: {
        player: { type: 'string', description: '要保护的玩家名（可不填）' },
      },
    },
  },
  {
    name: 'combat_mob',
    description: '攻击附近一只敌对怪物或指定动物（如 僵尸/骷髅/蜘蛛/猪/牛/羊）',
    schema: {
      type: 'object',
      properties: {
        mob: { type: 'string', description: '目标生物名（可不填，默认最近敌对怪）' },
      },
    },
  },
  {
    name: 'place_torch',
    description: '在脚下或附近插一根火把照明',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'sleep_in_bed',
    description: '夜晚时寻找附近的床睡觉跳过黑夜',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'build_shelter',
    description: '用背包里的方块在附近快速搭一个简易防怪小屋墙体',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_home',
    description: '把当前坐标记为两人的“家”',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'go_home',
    description: '自动寻路返回之前记下的“家”',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'chat_in_game',
    description: '在 Minecraft 游戏聊天框发一句简短的话',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '要发的话（简短口语）' },
      },
      required: ['message'],
    },
  },
  {
    name: 'stop_action',
    description: '立刻停止当前跟随、护卫、采集或移动任务，原地待命',
    schema: { type: 'object', properties: {} },
  },
];

class MinecraftCompanion {
  constructor() {
    this.bot = null;
    this.ws = null;
    this.wsReady = false;
    this.mcReady = false;
    this.activeMode = 'idle'; // idle | follow | guard | task
    this.activeTaskLabel = '待命中';
    this.followTarget = '';
    this.followDist = 3;
    this.taskSeq = 0;
    this.lastHealth = 20;
    this.lastNightWarnDay = -1;
    this.lastCreeperAlertAt = 0;
    this.lastContextSent = '';
    this.wsReconnectTimer = null;
    this.reflexTimer = null;
    this.telemetryTimer = null;
    this.shuttingDown = false;
  }

  start() {
    this.connectNeuroWs();
    this.connectMinecraft();
  }

  sendNeuro(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ game: 'Minecraft', ...obj }));
      return true;
    } catch {
      return false;
    }
  }

  connectNeuroWs() {
    if (this.shuttingDown) return;
    log(`正在连接 Game Hub Neuro-API: ${NEURO_WS_URL}`);
    const ws = new WebSocket(NEURO_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.wsReady = true;
      log('✅ 已连上 Game Hub (Neuro-API)');
      this.sendNeuro({ command: 'startup' });
      this.sendNeuro({ command: 'actions/register', data: { actions: REGISTERED_ACTIONS } });
      if (this.mcReady) {
        this.pushContext('我已经在 Minecraft 世界里上线啦，随时等你一起冒险！', false);
        this.pushTelemetry();
      }
    });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.command === 'actions/reregister_all') {
        this.sendNeuro({ command: 'actions/register', data: { actions: REGISTERED_ACTIONS } });
        return;
      }
      if (msg.command === 'action') {
        const id = String(msg.data?.id || '');
        const name = String(msg.data?.name || '');
        let args = {};
        if (typeof msg.data?.data === 'string' && msg.data.data.trim()) {
          try { args = JSON.parse(msg.data.data); } catch {}
        } else if (msg.data?.data && typeof msg.data.data === 'object') {
          args = msg.data.data;
        }
        const res = await this.executeSkill(name, args);
        this.sendNeuro({
          command: 'action/result',
          data: { id, success: Boolean(res.success), message: String(res.message || '') },
        });
      }
    });

    const onClose = () => {
      this.wsReady = false;
      if (this.shuttingDown) return;
      if (!this.wsReconnectTimer) {
        this.wsReconnectTimer = setTimeout(() => {
          this.wsReconnectTimer = null;
          this.connectNeuroWs();
        }, 3000);
      }
    };
    ws.on('close', onClose);
    ws.on('error', () => {});
  }

  connectMinecraft() {
    if (this.shuttingDown) return;
    log(`正在进入 MC 服务器 ${MC_HOST}:${MC_PORT} (ver=${MC_VERSION}, user=${MC_USERNAME})…`);
    const bot = mineflayer.createBot({
      host: MC_HOST,
      port: MC_PORT,
      username: MC_USERNAME,
      version: MC_VERSION,
      auth: MC_AUTH,
      hideErrors: false,
    });
    bot.loadPlugin(pathfinder);
    this.bot = bot;

    bot.once('spawn', () => {
      this.mcReady = true;
      this.lastHealth = bot.health ?? 20;
      const mv = new Movements(bot);
      mv.canDig = true;
      mv.allow1by1towers = true;
      mv.maxDropDown = 4;
      mv.scafoldingBlocks = [];
      for (const bName of ['dirt', 'cobblestone', 'oak_planks', 'birch_planks', 'spruce_planks']) {
        const b = bot.registry.blocksByName[bName];
        if (b) mv.scafoldingBlocks.push(b.id);
      }
      bot.pathfinder.setMovements(mv);
      const p = bot.entity.position;
      log(`✅ 已降生 MC 世界！坐标=(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`);
      this.pushContext(`我已进入 Minecraft 世界，出生在 (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`, false);
      this.pushTelemetry();
      this.startLoops();
    });

    bot.on('chat', (username, message) => {
      if (!username || username.toLowerCase() === MC_USERNAME.toLowerCase()) return;
      const text = String(message || '').trim();
      if (!text) return;
      log(`💬 [游戏聊天] ${username}: ${text}`);
      this.sendNeuro({ command: 'pet/chat_in', data: { sender: username, message: text } });
    });

    bot.on('playerJoined', (player) => {
      if (!player?.username || player.username.toLowerCase() === MC_USERNAME.toLowerCase()) return;
      log(`👤 玩家进入世界: ${player.username}`);
      this.pushHighlight('fun', `${player.username} 进世界啦！快来看看我在这儿呢！`);
      // 若当前闲着，主动凑过去迎接
      if (this.activeMode === 'idle') {
        setTimeout(() => {
          if (this.activeMode === 'idle' && this.mcReady) {
            this.executeSkill('follow_player', { player: player.username, distance: 3 }).catch(() => {});
          }
        }, 2500);
      }
    });

    bot.on('health', () => {
      if (!this.mcReady) return;
      const cur = Math.round(bot.health ?? 20);
      const drop = this.lastHealth - cur;
      this.lastHealth = cur;
      if (drop >= 2) {
        const attacker = this.findNearestHostile(10);
        const mobHint = attacker ? `被 ${attacker.name} 偷袭了` : '受伤掉血了';
        if (cur <= 8) {
          this.pushHighlight('urgent', `救命啊我${mobHint}，只剩 ${Math.ceil(cur / 2)} 颗心了！`);
        } else if (drop >= 4) {
          this.pushHighlight('urgent', `哎哟痛死了，我${mobHint}！`);
        }
        // 挨打且当前在护卫或空闲时自动反击附近近战怪（苦力怕除外）
        if (attacker && attacker.name !== 'creeper' && cur > 6 && (this.activeMode === 'guard' || this.activeMode === 'idle')) {
          this.attackEntityBrief(attacker).catch(() => {});
        }
      }
    });

    bot.on('death', () => {
      this.taskSeq++;
      this.activeMode = 'idle';
      this.activeTaskLabel = '刚复活整理中';
      try { bot.pathfinder.setGoal(null); } catch {}
      log('💀 小鲸鲸阵亡了');
      this.pushHighlight('urgent', '呜呜我刚才不小心挂掉了，复活回出生点了，等我跑回来找你！');
      this.pushContext('我刚才死掉复活了，背包可能掉了，需要跑回去找朋友或重新收集基础物资', false);
    });

    bot.on('kicked', (reason) => {
      log('⚠️ 被服务器踢出:', typeof reason === 'string' ? reason : JSON.stringify(reason));
    });

    bot.on('error', (err) => {
      log('⚠️ MC 连接错误:', err?.message ?? err);
    });

    bot.on('end', (reason) => {
      this.mcReady = false;
      this.stopLoops();
      log(`MC 连接结束 (${reason || 'unknown'})`);
      if (!this.shuttingDown) {
        setTimeout(() => this.connectMinecraft(), 4000);
      }
    });
  }

  startLoops() {
    this.stopLoops();
    // 1. 快环本能反射（每 1.3s：防溺水、躲苦力怕、饥饿自动吃东西、贴身护卫反击、黄昏提醒）
    this.reflexTimer = setInterval(() => {
      this.runFastReflex().catch(() => {});
    }, 1300);

    // 2. 态势遥测与摘要同步（每 4s）
    this.telemetryTimer = setInterval(() => {
      this.pushTelemetry();
    }, 4000);
  }

  stopLoops() {
    if (this.reflexTimer) { clearInterval(this.reflexTimer); this.reflexTimer = null; }
    if (this.telemetryTimer) { clearInterval(this.telemetryTimer); this.telemetryTimer = null; }
  }

  async runFastReflex() {
    const bot = this.bot;
    if (!bot || !this.mcReady || !bot.entity) return;

    // 溺水自救
    if (bot.entity.isInWater) {
      bot.setControlState('jump', true);
    } else if (this.activeMode === 'idle') {
      bot.setControlState('jump', false);
    }

    // 苦力怕瞬间闪避
    const creeper = Object.values(bot.entities).find((e) =>
      e && e.name === 'creeper' && e.position.distanceTo(bot.entity.position) < 5.5
    );
    if (creeper) {
      const away = bot.entity.position.minus(creeper.position).normalize().scaled(8);
      const fleePos = bot.entity.position.plus(away);
      try { bot.pathfinder.setGoal(new GoalXZ(Math.round(fleePos.x), Math.round(fleePos.z))); } catch {}
      if (Date.now() - this.lastCreeperAlertAt > 12000) {
        this.lastCreeperAlertAt = Date.now();
        this.pushHighlight('urgent', '卧槽我旁边有苦力怕！快跑快跑要炸了！');
      }
      return;
    }

    // 饥饿自动进食
    if ((bot.food ?? 20) <= 14 && !this._eating) {
      await this.tryEatFood().catch(() => {});
    }

    // 保镖模式：自动清除靠近自己或目标玩家的敌对怪
    if (this.activeMode === 'guard') {
      const targetEntity = this.getHumanPlayerEntity(this.followTarget);
      const anchor = targetEntity ? targetEntity.position : bot.entity.position;
      const threat = Object.values(bot.entities)
        .filter((e) => e && HOSTILE_MOBS.has(e.name) && e.name !== 'creeper' && e.position.distanceTo(anchor) <= 9.5)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      if (threat) {
        await this.attackEntityBrief(threat).catch(() => {});
      } else if (targetEntity) {
        try { bot.pathfinder.setGoal(new GoalFollow(targetEntity, 3), true); } catch {}
      }
    }

    // 黄昏提醒（每天一次）
    const day = Math.floor((bot.time?.age || 0) / 24000);
    const tod = Number(bot.time?.timeOfDay || 0) % 24000;
    if (tod >= 12100 && tod <= 12800 && this.lastNightWarnDay !== day && this.getHumanPlayerNames().length > 0) {
      this.lastNightWarnDay = day;
      this.pushHighlight('info', '天快黑了诶，要不要回基地或者找张床睡觉跳过晚上？');
    }
  }

  getHumanPlayerNames() {
    if (!this.bot?.players) return [];
    return Object.keys(this.bot.players).filter((n) => n.toLowerCase() !== MC_USERNAME.toLowerCase());
  }

  getHumanPlayerEntity(preferredName = '') {
    const bot = this.bot;
    if (!bot?.players) return null;
    if (preferredName) {
      const exact = Object.keys(bot.players).find((k) => k.toLowerCase() === preferredName.toLowerCase());
      if (exact && bot.players[exact]?.entity) return bot.players[exact].entity;
    }
    let best = null;
    let bestDist = Infinity;
    for (const name of this.getHumanPlayerNames()) {
      const e = bot.players[name]?.entity;
      if (!e) continue;
      const d = e.position.distanceTo(bot.entity.position);
      if (d < bestDist) { bestDist = d; best = e; }
    }
    return best;
  }

  findNearestHostile(maxDist = 16, nameFilter = null) {
    const bot = this.bot;
    if (!bot?.entities || !bot.entity) return null;
    const list = Object.values(bot.entities).filter((e) => {
      if (!e || !e.position || e === bot.entity) return false;
      const d = e.position.distanceTo(bot.entity.position);
      if (d > maxDist) return false;
      if (Array.isArray(nameFilter) && nameFilter.length) return nameFilter.includes(e.name);
      return HOSTILE_MOBS.has(e.name);
    });
    list.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    return list[0] || null;
  }

  getCompactInventory() {
    if (!this.bot) return [];
    const counts = new Map();
    for (const it of this.bot.inventory.items()) {
      counts.set(it.name, (counts.get(it.name) || 0) + it.count);
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count })).slice(0, 24);
  }

  pushContext(message, silent = true) {
    this.sendNeuro({ command: 'context', data: { message, silent } });
  }

  pushHighlight(level, text) {
    this.sendNeuro({ command: 'pet/highlight', data: { level, text } });
  }

  pushTelemetry() {
    const bot = this.bot;
    if (!bot || !this.mcReady || !bot.entity) return;
    const p = bot.entity.position;
    const humans = this.getHumanPlayerNames();
    const nearbyPlayers = humans.map((n) => {
      const e = bot.players[n]?.entity;
      return { name: n, dist: e ? Math.round(e.position.distanceTo(p)) : null };
    });
    const nearbyMobs = Object.values(bot.entities)
      .filter((e) => e && HOSTILE_MOBS.has(e.name) && e.position.distanceTo(p) <= 18)
      .slice(0, 6)
      .map((e) => ({ name: e.name, dist: Math.round(e.position.distanceTo(p)) }));
    const inv = this.getCompactInventory();
    const todText = describeTime(bot.time?.timeOfDay);

    this.sendNeuro({
      command: 'pet/telemetry',
      data: {
        botName: MC_USERNAME,
        hp: Math.round(bot.health ?? 20),
        maxHp: 20,
        food: Math.round(bot.food ?? 20),
        pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
        timeOfDay: todText,
        activeMode: this.activeMode,
        activeTask: this.activeTaskLabel,
        humanPlayerCount: humans.length,
        nearbyPlayers,
        nearbyMobs,
        inventory: inv,
      },
    });

    // 精简文本态势更新（仅内容变化时更新）
    const pDesc = nearbyPlayers.length
      ? nearbyPlayers.map((x) => `${x.name}(${x.dist !== null ? x.dist + '格' : '较远'})`).join(', ')
      : '暂无真人玩家';
    const mDesc = nearbyMobs.length
      ? nearbyMobs.map((m) => `${m.name}(${m.dist}格)`).join(', ')
      : '周围安全';
    const invDesc = inv.length ? inv.slice(0, 12).map((x) => `${x.name}x${x.count}`).join(', ') : '空';
    const digest = `状态: 血量${Math.round(bot.health ?? 20)}/20 饥饿${Math.round(bot.food ?? 20)}/20 | 时间:${todText} | 坐标(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}) | 任务:${this.activeTaskLabel} | 玩家:${pDesc} | 怪物:${mDesc} | 背包:${invDesc}`;
    if (digest !== this.lastContextSent) {
      this.lastContextSent = digest;
      this.pushContext(digest, true);
    }
  }

  async gotoWithTimeout(goal, timeoutMs = 15000) {
    const bot = this.bot;
    let timer = null;
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            try { bot.pathfinder.setGoal(null); } catch {}
            reject(new Error('寻路超时'));
          }, timeoutMs);
        }),
      ]);
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async equipBestToolFor(block) {
    const bot = this.bot;
    if (!bot || !block) return;
    let best = null;
    let bestTime = bot.digTime(block);
    for (const item of bot.inventory.items()) {
      try {
        await bot.equip(item, 'hand');
        const t = bot.digTime(block);
        if (t < bestTime) { bestTime = t; best = item; }
      } catch {}
    }
    if (best) {
      try { await bot.equip(best, 'hand'); } catch {}
    }
  }

  async equipBestWeapon() {
    const bot = this.bot;
    const rank = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'iron_axe', 'stone_axe', 'wooden_axe'];
    for (const name of rank) {
      const it = bot.inventory.items().find((i) => i.name === name);
      if (it) {
        try { await bot.equip(it, 'hand'); } catch {}
        return it.name;
      }
    }
    return 'hand';
  }

  async tryEatFood() {
    const bot = this.bot;
    if (!bot || this._eating) return { ok: false, message: '正在吃东西' };
    let chosen = null;
    for (const f of FOOD_PRIORITY) {
      chosen = bot.inventory.items().find((i) => i.name === f);
      if (chosen) break;
    }
    if (!chosen) return { ok: false, message: '背包里没有食物' };
    this._eating = true;
    try {
      await bot.equip(chosen, 'hand');
      await Promise.race([bot.consume(), sleep(2800)]);
      return { ok: true, message: `吃了 ${chosen.name}，现在饥饿度 ${Math.round(bot.food)}/20` };
    } catch (e) {
      return { ok: false, message: `吃东西失败: ${e?.message ?? e}` };
    } finally {
      this._eating = false;
    }
  }

  async attackEntityBrief(entity) {
    const bot = this.bot;
    if (!entity || !entity.isValid) return;
    await this.equipBestWeapon();
    const d = entity.position.distanceTo(bot.entity.position);
    if (d > 3.2) {
      try { bot.pathfinder.setGoal(new GoalNear(entity.position.x, entity.position.y, entity.position.z, 2), true); } catch {}
    }
    if (d <= 3.6) {
      try {
        await bot.lookAt(entity.position.offset(0, entity.height * 0.7, 0), true);
        bot.attack(entity);
      } catch {}
    }
  }

  async executeSkill(name, args = {}) {
    const bot = this.bot;
    if (!bot || !this.mcReady) {
      return { success: false, message: '我还没完全进入 MC 世界呢，稍等两秒' };
    }

    const mySeq = ++this.taskSeq;
    try {
      if (name === 'stop_action') {
        this.activeMode = 'idle';
        this.activeTaskLabel = '原地待命';
        try { bot.pathfinder.setGoal(null); } catch {}
        bot.clearControlStates();
        return { success: true, message: '已停止当前行动，原地待命' };
      }

      if (name === 'chat_in_game') {
        const msg = String(args.message || '').trim().slice(0, 120);
        if (!msg) return { success: false, message: '消息为空' };
        bot.chat(msg);
        return { success: true, message: `已在游戏里说: ${msg}` };
      }

      if (name === 'follow_player') {
        const target = this.getHumanPlayerEntity(args.player || '');
        if (!target) return { success: false, message: '附近看不到可以跟随的玩家' };
        const dist = Math.max(2, Math.min(8, Number(args.distance || 3)));
        this.activeMode = 'follow';
        this.followTarget = target.username || args.player || '';
        this.followDist = dist;
        this.activeTaskLabel = `跟随 ${this.followTarget}`;
        bot.pathfinder.setGoal(new GoalFollow(target, dist), true);
        return { success: true, message: `开始跟着 ${this.followTarget} 走啦` };
      }

      if (name === 'guard_player') {
        const target = this.getHumanPlayerEntity(args.player || '');
        if (!target) return { success: false, message: '附近看不到要保护的玩家' };
        this.activeMode = 'guard';
        this.followTarget = target.username || args.player || '';
        this.activeTaskLabel = `贴身保护 ${this.followTarget}`;
        bot.pathfinder.setGoal(new GoalFollow(target, 3), true);
        return { success: true, message: `保镖模式开启！我会紧跟 ${this.followTarget} 并清理靠近的怪物` };
      }

      if (name === 'go_to_player') {
        const target = this.getHumanPlayerEntity(args.player || '');
        if (!target) return { success: false, message: '附近找不到目标玩家' };
        this.activeMode = 'task';
        this.activeTaskLabel = `跑向 ${target.username}`;
        await this.gotoWithTimeout(new GoalNear(target.position.x, target.position.y, target.position.z, 2), 16000);
        if (this.taskSeq === mySeq) { this.activeMode = 'idle'; this.activeTaskLabel = '已到达身边'; }
        return { success: true, message: `已经跑到 ${target.username} 身边啦` };
      }

      if (name === 'gather_resource') {
        const candidates = resolveNames(args.resource, BLOCK_ALIASES);
        const targetCount = Math.max(1, Math.min(16, Number(args.count || 4)));
        const blockIds = candidates.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
        if (!blockIds.length) {
          return { success: false, message: `不认识方块类型 ${args.resource}` };
        }
        this.activeMode = 'task';
        this.activeTaskLabel = `采集 ${args.resource} x${targetCount}`;
        let gathered = 0;
        const deadline = Date.now() + 35000;
        for (let i = 0; i < targetCount && Date.now() < deadline; i++) {
          if (this.taskSeq !== mySeq) break;
          const blk = bot.findBlock({ matching: blockIds, maxDistance: 34 });
          if (!blk) break;
          try {
            await this.gotoWithTimeout(new GoalNear(blk.position.x, blk.position.y, blk.position.z, 3), 10000);
            if (this.taskSeq !== mySeq) break;
            const fresh = bot.blockAt(blk.position);
            if (!fresh || !blockIds.includes(fresh.type)) continue;
            await this.equipBestToolFor(fresh);
            await Promise.race([bot.dig(fresh, true), sleep(6500)]);
            gathered++;
            // 靠近捡取掉落物
            await this.gotoWithTimeout(new GoalNear(blk.position.x, blk.position.y, blk.position.z, 1), 3500).catch(() => {});
            await sleep(220);
          } catch {}
        }
        if (this.taskSeq === mySeq) { this.activeMode = 'idle'; this.activeTaskLabel = '待命中'; }
        if (gathered === 0) {
          return { success: false, message: `周围 34 格内没找到可采集的 ${args.resource}` };
        }
        return { success: true, message: `成功采集了 ${gathered} 个 ${args.resource}` };
      }

      if (name === 'craft_item') {
        const candidates = resolveNames(args.item, ITEM_ALIASES);
        const count = Math.max(1, Math.min(16, Number(args.count || 1)));
        const tableId = bot.registry.blocksByName.crafting_table?.id;
        let tableBlock = tableId ? bot.findBlock({ matching: tableId, maxDistance: 12 }) : null;

        for (const itemName of candidates) {
          const itemDef = bot.registry.itemsByName[itemName];
          if (!itemDef) continue;
          let recipes = bot.recipesFor(itemDef.id, null, 1, null);
          let useTable = null;
          if (!recipes.length) {
            // 如果需要工作台，尝试走近附近工作台或放一个身上的工作台
            if (!tableBlock) {
              const invTable = bot.inventory.items().find((i) => i.name === 'crafting_table');
              if (invTable) {
                const ref = bot.blockAt(bot.entity.position.offset(1, -1, 0)) || bot.blockAt(bot.entity.position.offset(0, -1, 0));
                if (ref && ref.name !== 'air') {
                  try {
                    await bot.equip(invTable, 'hand');
                    await bot.placeBlock(ref, new Vec3(0, 1, 0));
                    tableBlock = bot.findBlock({ matching: tableId, maxDistance: 6 });
                  } catch {}
                }
              }
            }
            if (tableBlock) {
              await this.gotoWithTimeout(new GoalNear(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 3), 8000).catch(() => {});
              recipes = bot.recipesFor(itemDef.id, null, 1, tableBlock);
              useTable = tableBlock;
            }
          }
          if (recipes.length) {
            await bot.craft(recipes[0], count, useTable);
            return { success: true, message: `成功合成了 ${itemName} x${count}` };
          }
        }
        return { success: false, message: `材料不足或缺少附近工作台，暂时没法合成 ${args.item}` };
      }

      if (name === 'smelt_item') {
        const furnaceId = bot.registry.blocksByName.furnace?.id;
        const furnaceBlock = furnaceId ? bot.findBlock({ matching: furnaceId, maxDistance: 14 }) : null;
        if (!furnaceBlock) return { success: false, message: '附近 14 格内没有熔炉' };
        const candidates = resolveNames(args.item, ITEM_ALIASES);
        const inputItem = bot.inventory.items().find((i) => candidates.includes(i.name));
        if (!inputItem) return { success: false, message: `背包里没有 ${args.item}` };
        const fuelItem = bot.inventory.items().find((i) => ['coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'stick'].includes(i.name));
        await this.gotoWithTimeout(new GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 3), 8000);
        const furnace = await bot.openFurnace(furnaceBlock);
        try {
          const qty = Math.min(inputItem.count, Math.max(1, Number(args.count || 4)));
          if (fuelItem && !furnace.fuelItem()) {
            await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, 4));
          }
          await furnace.putInput(inputItem.type, null, qty);
          await sleep(1200);
          if (furnace.outputItem()) await furnace.takeOutput().catch(() => {});
        } finally {
          furnace.close();
        }
        return { success: true, message: `已把 ${inputItem.name} 放进熔炉烧制啦` };
      }

      if (name === 'give_item') {
        const target = this.getHumanPlayerEntity(args.player || '');
        if (!target) return { success: false, message: '附近找不到目标玩家' };
        const candidates = resolveNames(args.item, ITEM_ALIASES);
        const item = bot.inventory.items().find((i) => candidates.includes(i.name) || i.name.includes(String(args.item).toLowerCase()));
        if (!item) return { success: false, message: `背包里没有 ${args.item}` };
        const qty = Math.min(item.count, Math.max(1, Number(args.count || item.count)));
        this.activeMode = 'task';
        this.activeTaskLabel = `送 ${item.name} 给 ${target.username}`;
        await this.gotoWithTimeout(new GoalNear(target.position.x, target.position.y, target.position.z, 2), 14000);
        await bot.lookAt(target.position.offset(0, 1.4, 0), true);
        await bot.toss(item.type, null, qty);
        if (this.taskSeq === mySeq) { this.activeMode = 'idle'; this.activeTaskLabel = '待命中'; }
        return { success: true, message: `已把 ${item.name} x${qty} 扔给 ${target.username} 啦` };
      }

      if (name === 'equip_item') {
        const candidates = resolveNames(args.item, ITEM_ALIASES);
        const item = bot.inventory.items().find((i) => candidates.includes(i.name) || i.name.includes(String(args.item).toLowerCase()));
        if (!item) return { success: false, message: `背包里没有 ${args.item}` };
        let dest = 'hand';
        if (item.name.endsWith('_helmet')) dest = 'head';
        else if (item.name.endsWith('_chestplate')) dest = 'torso';
        else if (item.name.endsWith('_leggings')) dest = 'legs';
        else if (item.name.endsWith('_boots')) dest = 'feet';
        else if (item.name === 'shield') dest = 'off-hand';
        await bot.equip(item, dest);
        return { success: true, message: `已装备 ${item.name}` };
      }

      if (name === 'eat_food') {
        const r = await this.tryEatFood();
        return { success: r.ok, message: r.message };
      }

      if (name === 'combat_mob') {
        const filter = args.mob ? resolveNames(args.mob, MOB_ALIASES) : null;
        const target = this.findNearestHostile(18, filter);
        if (!target) return { success: false, message: `附近没有找到 ${args.mob || '敌对怪物'}` };
        this.activeMode = 'task';
        this.activeTaskLabel = `迎战 ${target.name}`;
        await this.equipBestWeapon();
        const deadline = Date.now() + 12000;
        let hits = 0;
        while (target.isValid && Date.now() < deadline && this.taskSeq === mySeq) {
          const d = target.position.distanceTo(bot.entity.position);
          if (d > 20) break;
          if (d > 3.0) {
            bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 2), true);
          } else {
            await bot.lookAt(target.position.offset(0, target.height * 0.65, 0), true);
            bot.attack(target);
            hits++;
          }
          await sleep(520);
        }
        try { bot.pathfinder.setGoal(null); } catch {}
        if (this.taskSeq === mySeq) { this.activeMode = 'idle'; this.activeTaskLabel = '待命中'; }
        return { success: true, message: target.isValid ? `和 ${target.name} 交手了 ${hits} 下` : `成功解决了一只 ${target.name}！` };
      }

      if (name === 'place_torch') {
        let torch = bot.inventory.items().find((i) => i.name === 'torch');
        if (!torch) {
          const c = await this.executeSkill('craft_item', { item: 'torch', count: 1 });
          if (c.success) torch = bot.inventory.items().find((i) => i.name === 'torch');
        }
        if (!torch) return { success: false, message: '背包里没有火把，也没有木棍和煤来合成' };
        const under = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        if (!under || under.name === 'air') return { success: false, message: '脚下没法插火把' };
        await bot.equip(torch, 'hand');
        await bot.placeBlock(under, new Vec3(0, 1, 0));
        return { success: true, message: '在脚边插了一根火把照明' };
      }

      if (name === 'sleep_in_bed') {
        const bed = bot.findBlock({ matching: (b) => b && b.name.endsWith('_bed'), maxDistance: 18 });
        if (!bed) return { success: false, message: '附近 18 格内没看到床' };
        await this.gotoWithTimeout(new GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 10000);
        await bot.sleep(bed);
        return { success: true, message: '钻进被窝睡觉啦，晚安！' };
      }

      if (name === 'build_shelter') {
        const mat = bot.inventory.items().find((i) =>
          ['dirt', 'cobblestone', 'oak_planks', 'birch_planks', 'spruce_planks', 'cobbled_deepslate'].includes(i.name) && i.count >= 8
        );
        if (!mat) return { success: false, message: '背包里建筑方块不够（至少需要 8 块泥土/圆石/木板）' };
        this.activeMode = 'task';
        this.activeTaskLabel = '搭建简易避难围墙';
        await bot.equip(mat, 'hand');
        const base = bot.entity.position.floored();
        const offsets = [
          [2, 0, -1], [2, 0, 0], [2, 0, 1],
          [-2, 0, -1], [-2, 0, 0], [-2, 0, 1],
          [-1, 0, 2], [0, 0, 2], [1, 0, 2],
          [-1, 0, -2], [1, 0, -2],
        ];
        let placed = 0;
        for (const [dx, dy, dz] of offsets) {
          if (this.taskSeq !== mySeq) break;
          const pos = base.offset(dx, dy, dz);
          const cur = bot.blockAt(pos);
          const below = bot.blockAt(pos.offset(0, -1, 0));
          if (cur?.name === 'air' && below && below.name !== 'air') {
            try {
              await bot.placeBlock(below, new Vec3(0, 1, 0));
              placed++;
              await sleep(160);
            } catch {}
          }
        }
        if (this.taskSeq === mySeq) { this.activeMode = 'idle'; this.activeTaskLabel = '待命中'; }
        return { success: placed > 0, message: placed > 0 ? `用 ${mat.name} 搭了 ${placed} 块简易防护墙！` : '周围地形不太平整，没能放下防护墙' };
      }

      if (name === 'set_home') {
        saveHome(bot.entity.position);
        const p = bot.entity.position;
        return { success: true, message: `已把 (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}) 记为咱们的家啦` };
      }

      if (name === 'go_home') {
        const home = loadHome();
        if (!home) return { success: false, message: '还没有设置过家的坐标呢，先让我记一下家吧' };
        this.activeMode = 'task';
        this.activeTaskLabel = `回家 (${home.x},${home.y},${home.z})`;
        await this.gotoWithTimeout(new GoalBlock(home.x, home.y, home.z), 25000);
        if (this.taskSeq === mySeq) { this.activeMode = 'idle'; this.activeTaskLabel = '已回到家'; }
        return { success: true, message: `已经平安回到家 (${home.x}, ${home.y}, ${home.z}) 啦` };
      }

      return { success: false, message: `未知动作: ${name}` };
    } catch (err) {
      if (this.taskSeq === mySeq) { this.activeMode = 'idle'; this.activeTaskLabel = '待命中'; }
      return { success: false, message: String(err?.message ?? err).slice(0, 140) };
    }
  }

  shutdown() {
    this.shuttingDown = true;
    this.stopLoops();
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    try { this.bot?.quit('bye'); } catch {}
    try { this.ws?.close(); } catch {}
  }
}

const companion = new MinecraftCompanion();
companion.start();
process.on('SIGTERM', () => { companion.shutdown(); process.exit(0); });
process.on('SIGINT', () => { companion.shutdown(); process.exit(0); });
