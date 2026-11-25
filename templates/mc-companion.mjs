/**
 * mc-companion.mjs — 小鲸鲸 Minecraft 1.21.1 具身联机队友 V2（200ms 快环生存战斗 + 真实环境感知 + 标准 Neuro-API）
 *
 * V2 核心升级（解决延迟迟钝、易被怪打死、语音与游戏行为脱节三大痛点）：
 *   1. 200ms (5Hz) 毫秒级本地快环反射：
 *      - 自动疾跑（sprint）、自动穿护甲/副手拿盾、精准武器攻击冷却（~580ms）与击退拉扯
 *      - 任何模式下遭近身敌对怪袭击均立即自卫反击，残血（≤6血）自动疾跑拉扯+吃食物保命
 *      - 苦力怕专项防爆协议：严禁贴脸站撸！靠近 6.5 格立刻反方向疾跑躲避并实时高优告警
 *      - 阵亡发送 level='critical' 零冷却必达警报，复活后自动跑回玩家身边
 *   2. 1.5s 高频真实态势感知（Grounded Telemetry）：
 *      - 实时上报存活/刚复活秒数、血量/饥饿、与玩家精确距离及上下高差、手持物品、真实背包、
 *        周围 16 格真实方块/动物/怪物/工作台/熔炉/床，以及最近一次动作的真实成败结果，彻底根除语音瞎编！
 *   3. 实打实的建造与采集技能：
 *      - build_shelter 自动将原木合成为木板并搭出 2 格高 5x5 带门围墙（方块不够则如实报错绝不吹牛）
 *      - combat_mob 支持疾跑追击逃跑动物（羊/牛/猪/鸡）与苦力怕打完即撤放风筝
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

const PASSIVE_ANIMALS = new Set(['sheep', 'cow', 'pig', 'chicken', 'rabbit', 'horse', 'wolf', 'llama', 'goat']);

const MOB_CN = {
  zombie: '僵尸', husk: '尸壳', drowned: '溺尸', skeleton: '骷髅', stray: '流浪者',
  creeper: '苦力怕', spider: '蜘蛛', cave_spider: '洞穴蜘蛛', enderman: '末影人',
  witch: '女巫', slime: '史莱姆', phantom: '幻翼', pillager: '掠夺者',
  sheep: '羊', cow: '牛', pig: '猪', chicken: '鸡', rabbit: '兔子', wolf: '狼',
};

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
  羊肉: ['cooked_mutton', 'mutton'],
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

const LOG_TO_PLANKS = {
  oak_log: 'oak_planks',
  birch_log: 'birch_planks',
  spruce_log: 'spruce_planks',
  jungle_log: 'jungle_planks',
  acacia_log: 'acacia_planks',
  dark_oak_log: 'dark_oak_planks',
  mangrove_log: 'mangrove_planks',
  cherry_log: 'cherry_planks',
};

const BUILD_BLOCKS = [
  'cobblestone', 'cobbled_deepslate', 'dirt',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks',
];

function resolveNames(raw, aliasMap) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return [];
  if (aliasMap[s]) return aliasMap[s];
  for (const [k, vals] of Object.entries(aliasMap)) {
    if (s.includes(k) || k.includes(s)) return vals;
  }
  return [s.replace(/\s+/g, '_')];
}

function cnMob(name) {
  return MOB_CN[name] || name || '怪物';
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
  if (t < 22500) return '夜晚(刷怪中)';
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
    description: '立刻疾跑跑到指定玩家身边并停下',
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
    description: '合成物品（如 木板/木棍/工作台/火把/木镐/石镐/石剑/铁镐/熔炉/箱子 等，需要工作台时会自动寻找或放下工作台）',
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
        count: { type: 'integer', minimum: 1, maximum: 64, description: '数量（不填默认全给）' },
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
    description: '开启贴身保镖模式：跟着玩家并自动高速迎击靠近的怪物',
    schema: {
      type: 'object',
      properties: {
        player: { type: 'string', description: '要保护的玩家名（可不填）' },
      },
    },
  },
  {
    name: 'combat_mob',
    description: '疾跑追击并击杀附近一只敌对怪物或指定动物（如 羊/猪/牛/鸡/僵尸/骷髅/蜘蛛；遇苦力怕自动放风筝不贴脸）',
    schema: {
      type: 'object',
      properties: {
        mob: { type: 'string', description: '目标生物名（可不填，默认最近非苦力怕敌对怪）' },
      },
    },
  },
  {
    name: 'place_torch',
    description: '在脚下或附近插一根火把照明（背包没火把时会尝试用木棍+煤自动合成）',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'sleep_in_bed',
    description: '夜晚时寻找附近的床睡觉跳过黑夜',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'build_shelter',
    description: '在玩家附近搭一个 2 格高带门洞的防怪简易小屋（会自动把原木合成为木板，方块不足时会如实说明）',
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
    this.lastDamageAlertAt = 0;
    this.lastAttackAt = 0;
    this.lastArmorCheckAt = 0;
    this.lastDiedAt = 0;
    this.deathCount = 0;
    this.lastActionSummary = '';
    this.lastContextSent = '';
    this.wsReconnectTimer = null;
    this.reflexTimer = null;
    this.telemetryTimer = null;
    this.reflexBusy = false;
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
        this.pushContext('小鲸鲸已经进入 Minecraft 世界并就绪。', true);
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
        this.lastActionSummary = `${res.success ? '✅' : '❌'} ${name}: ${res.message || ''}`;
        this.pushTelemetry();
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
      hideErrors: true,
    });
    bot.loadPlugin(pathfinder);
    this.bot = bot;

    bot.once('spawn', () => {
      this.mcReady = true;
      this.lastHealth = bot.health ?? 20;
      const mv = new Movements(bot);
      mv.canDig = true;
      mv.allowSprinting = true;
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
      this.pushHighlight('fun', `${player.username} 进入 MC 世界了，我现在正朝他跑过去！`);
      setTimeout(() => {
        if (this.activeMode === 'idle' && this.mcReady) {
          this.executeSkill('follow_player', { player: player.username, distance: 3 }).catch(() => {});
        }
      }, 1200);
    });

    bot.on('health', () => {
      if (!this.mcReady) return;
      const cur = Math.round(bot.health ?? 20);
      const drop = this.lastHealth - cur;
      this.lastHealth = cur;
      if (drop >= 2 && cur > 0) {
        const attacker = this.findNearestHostile(10);
        const mobName = attacker ? cnMob(attacker.name) : '怪物';
        const now = Date.now();
        if (cur <= 8 && now - this.lastDamageAlertAt > 7000) {
          this.lastDamageAlertAt = now;
          this.pushHighlight('urgent', `小鲸鲸被${mobName}打残血了，只剩 ${Math.ceil(cur / 2)} 颗心，正在拉扯吃东西自救！`);
        } else if (drop >= 4 && now - this.lastDamageAlertAt > 10000) {
          this.lastDamageAlertAt = now;
          this.pushHighlight('urgent', `小鲸鲸刚被${mobName}重击了一下，正在立刻反击！`);
        }
      }
    });

    bot.on('death', () => {
      this.taskSeq++;
      this.lastDiedAt = Date.now();
      this.deathCount++;
      this.activeMode = 'idle';
      this.activeTaskLabel = '刚阵亡在出生点复活';
      this.lastActionSummary = '💀 刚阵亡，已回出生点复活（背包掉落）';
      try { bot.pathfinder.setGoal(null); } catch {}
      bot.clearControlStates();
      log(`💀 小鲸鲸阵亡了 (第 ${this.deathCount} 次)`);
      this.pushTelemetry();
      // critical 级别零冷却必达通话引擎，绝不会被前几秒的受伤播报吞掉！
      this.pushHighlight('critical', '小鲸鲸刚在游戏里被怪打死了，背包掉了，刚刚在出生点复活，正往玩家身边跑回来！');
    });

    bot.on('respawn', () => {
      if (!this.mcReady) return;
      this.lastHealth = 20;
      this.pushTelemetry();
      // 复活 1.5 秒后如果玩家在线且不太远，自动疾跑跑回玩家身边
      setTimeout(() => {
        if (!this.mcReady || this.activeMode !== 'idle') return;
        const target = this.getHumanPlayerEntity('');
        if (target && target.position.distanceTo(bot.entity.position) <= 140) {
          this.activeMode = 'follow';
          this.followTarget = target.username;
          this.activeTaskLabel = `复活跑回 ${target.username} 身边`;
          bot.setControlState('sprint', true);
          try { bot.pathfinder.setGoal(new GoalFollow(target, 3), true); } catch {}
          this.pushTelemetry();
        }
      }, 1500);
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
    // 1. 200ms (5Hz) 毫秒级快环生存/战斗反射（零大模型等待！）
    this.reflexTimer = setInterval(() => {
      if (this.reflexBusy) return;
      this.reflexBusy = true;
      this.runFastReflex().catch(() => {}).finally(() => { this.reflexBusy = false; });
    }, 200);

    // 2. 1.5s 高频真实态势遥测同步（确保通话大脑随时掌握真实画面/背包/成败）
    this.telemetryTimer = setInterval(() => {
      this.pushTelemetry();
    }, 1500);
  }

  stopLoops() {
    if (this.reflexTimer) { clearInterval(this.reflexTimer); this.reflexTimer = null; }
    if (this.telemetryTimer) { clearInterval(this.telemetryTimer); this.telemetryTimer = null; }
  }

  async autoEquipArmorAndShield() {
    const bot = this.bot;
    if (!bot) return;
    const slots = [
      { suffix: '_helmet', dest: 'head', idx: 5 },
      { suffix: '_chestplate', dest: 'torso', idx: 6 },
      { suffix: '_leggings', dest: 'legs', idx: 7 },
      { suffix: '_boots', dest: 'feet', idx: 8 },
    ];
    const matScore = (n) => n.startsWith('netherite') ? 5 : n.startsWith('diamond') ? 4 : n.startsWith('iron') ? 3 : n.startsWith('chainmail') ? 2 : n.startsWith('golden') ? 2 : 1;
    for (const s of slots) {
      const cur = bot.inventory.slots[s.idx];
      const curScore = cur ? matScore(cur.name) : 0;
      const better = bot.inventory.items()
        .filter((i) => i.name.endsWith(s.suffix) && matScore(i.name) > curScore)
        .sort((a, b) => matScore(b.name) - matScore(a.name))[0];
      if (better) {
        try { await bot.equip(better, s.dest); } catch {}
      }
    }
    if (!bot.inventory.slots[45]) {
      const shield = bot.inventory.items().find((i) => i.name === 'shield');
      if (shield) {
        try { await bot.equip(shield, 'off-hand'); } catch {}
      }
    }
  }

  async runFastReflex() {
    const bot = this.bot;
    if (!bot || !this.mcReady || !bot.entity) return;
    const now = Date.now();
    const myPos = bot.entity.position;

    // 0. 溺水自动上浮
    if (bot.entity.isInWater) {
      bot.setControlState('jump', true);
    } else if (this.activeMode === 'idle') {
      bot.setControlState('jump', false);
    }

    // 1. 每 6 秒自动穿最优护甲/副手拿盾
    if (now - this.lastArmorCheckAt > 6000) {
      this.lastArmorCheckAt = now;
      await this.autoEquipArmorAndShield().catch(() => {});
    }

    // 2. 苦力怕最高优瞬时闪避（6.8 格内反方向疾跑！）
    const creeper = Object.values(bot.entities).find((e) =>
      e && e.isValid && e.name === 'creeper' && e.position.distanceTo(myPos) < 6.8
    );
    if (creeper) {
      const diff = myPos.minus(creeper.position);
      const len = Math.hypot(diff.x, diff.z) || 1;
      const fleeX = Math.round(myPos.x + (diff.x / len) * 11);
      const fleeZ = Math.round(myPos.z + (diff.z / len) * 11);
      bot.setControlState('sprint', true);
      try { bot.pathfinder.setGoal(new GoalXZ(fleeX, fleeZ), true); } catch {}
      if (now - this.lastCreeperAlertAt > 11000) {
        this.lastCreeperAlertAt = now;
        this.pushHighlight('urgent', '小鲸鲸身边有苦力怕要炸了，正在反方向疾跑闪避，提醒玩家别贴脸！');
      }
      return;
    }

    // 3. 饥饿/掉血自动进食（15 饱食度或血量 ≤ 12 且非满饱食立即吃）
    if (((bot.food ?? 20) <= 15 || ((bot.health ?? 20) <= 12 && (bot.food ?? 20) < 20)) && !this._eating) {
      this.tryEatFood().catch(() => {});
    }

    // 4. 残血战术拉扯（HP ≤ 6 且 6 格内有敌对怪：先疾跑拉开距离回血，不傻站着送死！）
    const closeDanger = this.findNearestHostile(6.5, null, true);
    if ((bot.health ?? 20) <= 6 && closeDanger) {
      const diff = myPos.minus(closeDanger.position);
      const len = Math.hypot(diff.x, diff.z) || 1;
      bot.setControlState('sprint', true);
      try {
        bot.pathfinder.setGoal(new GoalXZ(Math.round(myPos.x + (diff.x / len) * 10), Math.round(myPos.z + (diff.z / len) * 10)), true);
      } catch {}
      return;
    }

    // 5. 全模式近身自卫 & 保镖主动清怪（任何状态下被 4.5 格内怪贴脸都立即拔剑反击！）
    const playerEntity = this.getHumanPlayerEntity(this.followTarget);
    let combatTarget = null;
    if (this.activeMode === 'guard') {
      const anchor = playerEntity ? playerEntity.position : myPos;
      combatTarget = Object.values(bot.entities)
        .filter((e) => e && e.isValid && HOSTILE_MOBS.has(e.name) && e.name !== 'creeper' && e.position.distanceTo(anchor) <= 11)
        .sort((a, b) => a.position.distanceTo(myPos) - b.position.distanceTo(myPos))[0] || null;
    } else if (this.activeMode !== 'task') {
      // 跟随或空闲时：4.8 格内有近身非苦力怕怪立刻拔刀自卫
      combatTarget = this.findNearestHostile(4.8, null, true);
    } else {
      // 做采集/建造任务时：3.4 格贴脸打到自己了也立刻先挥刀击退
      combatTarget = this.findNearestHostile(3.4, null, true);
    }

    if (combatTarget) {
      await this.stepMeleeCombat(combatTarget);
      return;
    }

    // 6. 跟随/保镖模式下远距离自动疾跑跟上
    if ((this.activeMode === 'follow' || this.activeMode === 'guard') && playerEntity) {
      const dist = playerEntity.position.distanceTo(myPos);
      bot.setControlState('sprint', dist > 4.5);
      if (this.activeMode === 'guard' && dist > 4.5) {
        try { bot.pathfinder.setGoal(new GoalFollow(playerEntity, 3), true); } catch {}
      }
    }

    // 7. 黄昏提醒（每天一次）
    const day = Math.floor((bot.time?.age || 0) / 24000);
    const tod = Number(bot.time?.timeOfDay || 0) % 24000;
    if (tod >= 12100 && tod <= 12600 && this.lastNightWarnDay !== day && this.getHumanPlayerNames().length > 0) {
      this.lastNightWarnDay = day;
      this.pushHighlight('info', 'MC 里马上天黑要刷怪了，提醒玩家准备火把或避难小屋。');
    }
  }

  async stepMeleeCombat(entity) {
    const bot = this.bot;
    if (!entity || !entity.isValid || !bot.entity) return;
    await this.equipBestWeapon();
    const myPos = bot.entity.position;
    const d = entity.position.distanceTo(myPos);
    const now = Date.now();

    // 追击拉近
    if (d > 2.8) {
      bot.setControlState('sprint', true);
      try {
        bot.pathfinder.setGoal(new GoalNear(entity.position.x, entity.position.y, entity.position.z, 2), true);
      } catch {}
    } else {
      bot.setControlState('sprint', false);
    }

    // 严格遵守 MC 1.9+ 武器攻击冷却（580ms），命中率与击退翻倍！
    if (d <= 3.6 && now - this.lastAttackAt >= 580) {
      this.lastAttackAt = now;
      try {
        await bot.lookAt(entity.position.offset(0, (entity.height || 1.6) * 0.65, 0), true);
        bot.attack(entity);
      } catch {}
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

  findNearestHostile(maxDist = 16, nameFilter = null, excludeCreeper = false) {
    const bot = this.bot;
    if (!bot?.entities || !bot.entity) return null;
    const list = Object.values(bot.entities).filter((e) => {
      if (!e || !e.isValid || !e.position || e === bot.entity) return false;
      const d = e.position.distanceTo(bot.entity.position);
      if (d > maxDist) return false;
      if (excludeCreeper && e.name === 'creeper') return false;
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

  scanEnvironmentBrief() {
    const bot = this.bot;
    if (!bot || !bot.entity) return {};
    const p = bot.entity.position;
    const features = [];
    const check = (label, names, maxDistance = 18) => {
      const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
      if (!ids.length) return;
      const blk = bot.findBlock({ matching: ids, maxDistance });
      if (blk) features.push(`${label}(${Math.round(blk.position.distanceTo(p))}格)`);
    };
    check('树林', BLOCK_ALIASES.木头, 20);
    check('工作台', ['crafting_table'], 14);
    check('熔炉', ['furnace'], 14);
    check('床', ['white_bed', 'red_bed', 'blue_bed', 'light_blue_bed', 'yellow_bed', 'green_bed'], 16);
    check('煤/铁矿', ['coal_ore', 'iron_ore', 'deepslate_coal_ore', 'deepslate_iron_ore'], 18);
    check('火把', ['torch', 'wall_torch'], 14);

    const nearbyAnimals = Object.values(bot.entities)
      .filter((e) => e && e.isValid && PASSIVE_ANIMALS.has(e.name) && e.position.distanceTo(p) <= 22)
      .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))
      .slice(0, 5)
      .map((e) => ({ name: e.name, cn: cnMob(e.name), dist: Math.round(e.position.distanceTo(p)) }));

    return { features, nearbyAnimals };
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
      return {
        name: n,
        dist: e ? Math.round(e.position.distanceTo(p)) : null,
        dy: e ? Math.round(e.position.y - p.y) : null,
      };
    });
    const nearbyMobs = Object.values(bot.entities)
      .filter((e) => e && e.isValid && HOSTILE_MOBS.has(e.name) && e.position.distanceTo(p) <= 20)
      .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))
      .slice(0, 6)
      .map((e) => ({ name: e.name, cn: cnMob(e.name), dist: Math.round(e.position.distanceTo(p)) }));
    const inv = this.getCompactInventory();
    const todText = describeTime(bot.time?.timeOfDay);
    const env = this.scanEnvironmentBrief();
    const heldItem = bot.heldItem ? bot.heldItem.name : '空手';
    const justDiedAgoSec = this.lastDiedAt && (Date.now() - this.lastDiedAt < 45000)
      ? Math.round((Date.now() - this.lastDiedAt) / 1000)
      : null;

    this.sendNeuro({
      command: 'pet/telemetry',
      data: {
        botName: MC_USERNAME,
        hp: Math.round(bot.health ?? 20),
        maxHp: 20,
        food: Math.round(bot.food ?? 20),
        pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
        timeOfDay: todText,
        heldItem,
        activeMode: this.activeMode,
        activeTask: this.activeTaskLabel,
        lastActionSummary: this.lastActionSummary,
        justDiedAgoSec,
        deathCount: this.deathCount,
        humanPlayerCount: humans.length,
        nearbyPlayers,
        nearbyMobs,
        nearbyAnimals: env.nearbyAnimals,
        nearbyFeatures: env.features,
        inventory: inv,
      },
    });

    const pDesc = nearbyPlayers.length
      ? nearbyPlayers.map((x) => `${x.name}(${x.dist !== null ? `${x.dist}格${x.dy > 2 ? ',高处' : (x.dy < -2 ? ',低处' : '')}` : '较远'})`).join(', ')
      : '暂无真人玩家';
    const mDesc = nearbyMobs.length ? nearbyMobs.map((m) => `${m.cn}(${m.dist}格)`).join(', ') : '周围无怪';
    const aDesc = env.nearbyAnimals.length ? env.nearbyAnimals.map((a) => `${a.cn}(${a.dist}格)`).join(', ') : '无';
    const invDesc = inv.length ? inv.slice(0, 12).map((x) => `${x.name}x${x.count}`).join(', ') : '空背包';
    const digest = `血量${Math.round(bot.health ?? 20)}/20 饥饿${Math.round(bot.food ?? 20)}/20 手持:${heldItem} | ${todText} | 正在:${this.activeTaskLabel} | 玩家:${pDesc} | 怪物:${mDesc} | 动物:${aDesc} | 周围:${env.features.join('/') || '平地'} | 背包:${invDesc}`;
    if (digest !== this.lastContextSent) {
      this.lastContextSent = digest;
      this.pushContext(digest, true);
    }
  }

  async gotoWithTimeout(goal, timeoutMs = 14000) {
    const bot = this.bot;
    let timer = null;
    try {
      bot.setControlState('sprint', true);
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
      bot.setControlState('sprint', false);
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
        if (bot.heldItem?.name !== it.name) {
          try { await bot.equip(it, 'hand'); } catch {}
        }
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
      await Promise.race([bot.consume(), sleep(2600)]);
      return { ok: true, message: `吃了 ${chosen.name}，现在饥饿度 ${Math.round(bot.food)}/20` };
    } catch (e) {
      return { ok: false, message: `吃东西失败: ${e?.message ?? e}` };
    } finally {
      this._eating = false;
    }
  }

  async convertLogsToPlanksIfNeeded() {
    const bot = this.bot;
    for (const [logName, plankName] of Object.entries(LOG_TO_PLANKS)) {
      const logItem = bot.inventory.items().find((i) => i.name === logName);
      if (!logItem) continue;
      const plankDef = bot.registry.itemsByName[plankName];
      if (!plankDef) continue;
      const recipes = bot.recipesFor(plankDef.id, null, 1, null);
      if (recipes.length) {
        try {
          await bot.craft(recipes[0], Math.min(logItem.count, 8), null);
        } catch {}
      }
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
        bot.setControlState('sprint', true);
        bot.pathfinder.setGoal(new GoalFollow(target, dist), true);
        return { success: true, message: `正在疾跑跟着 ${this.followTarget}` };
      }

      if (name === 'guard_player') {
        const target = this.getHumanPlayerEntity(args.player || '');
        if (!target) return { success: false, message: '附近看不到要保护的玩家' };
        this.activeMode = 'guard';
        this.followTarget = target.username || args.player || '';
        this.activeTaskLabel = `贴身保镖保护 ${this.followTarget}`;
        bot.setControlState('sprint', true);
        bot.pathfinder.setGoal(new GoalFollow(target, 3), true);
        return { success: true, message: `保镖模式开启，紧跟 ${this.followTarget} 并清理近身怪物` };
      }

      if (name === 'go_to_player') {
        const target = this.getHumanPlayerEntity(args.player || '');
        if (!target) return { success: false, message: '附近找不到目标玩家' };
        this.activeMode = 'task';
        this.activeTaskLabel = `疾跑去找 ${target.username}`;
        await this.gotoWithTimeout(new GoalNear(target.position.x, target.position.y, target.position.z, 2), 14000);
        if (this.taskSeq === mySeq) { this.activeMode = 'idle'; this.activeTaskLabel = `在 ${target.username} 身边`; }
        return { success: true, message: `已经跑到 ${target.username} 身边了` };
      }

      if (name === 'gather_resource') {
        const candidates = resolveNames(args.resource, BLOCK_ALIASES);
        const targetCount = Math.max(1, Math.min(16, Number(args.count || 4)));
        const blockIds = candidates.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
        if (!blockIds.length) return { success: false, message: `不认识方块类型 ${args.resource}` };
        this.activeMode = 'task';
        this.activeTaskLabel = `采集 ${args.resource} x${targetCount}`;
        let gathered = 0;
        const deadline = Date.now() + 28000;
        for (let i = 0; i < targetCount && Date.now() < deadline; i++) {
          if (this.taskSeq !== mySeq) break;
          const blk = bot.findBlock({ matching: blockIds, maxDistance: 32 });
          if (!blk) break;
          try {
            await this.gotoWithTimeout(new GoalNear(blk.position.x, blk.position.y, blk.position.z, 3), 9000);
            if (this.taskSeq !== mySeq) break;
            const fresh = bot.blockAt(blk.position);
            if (!fresh || !blockIds.includes(fresh.type)) continue;
            await this.equipBestToolFor(fresh);
            await Promise.race([bot.dig(fresh, true), sleep(6000)]);
            gathered++;
            await this.gotoWithTimeout(new GoalNear(blk.position.x, blk.position.y, blk.position.z, 1), 2800).catch(() => {});
            await sleep(180);
          } catch {}
        }
        if (this.taskSeq === mySeq) { this.activeMode = 'idle'; this.activeTaskLabel = '待命中'; }
        if (gathered === 0) return { success: false, message: `周围 32 格内没找到可采集的 ${args.resource}` };
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
        return { success: false, message: `材料不足或周围缺工作台，暂时没法合成 ${args.item}` };
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
          if (fuelItem && !furnace.fuelItem()) await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, 4));
          await furnace.putInput(inputItem.type, null, qty);
          await sleep(1000);
          if (furnace.outputItem()) await furnace.takeOutput().catch(() => {});
        } finally {
          furnace.close();
        }
        return { success: true, message: `已把 ${inputItem.name} 放进熔炉烧制` };
      }

      if (name === 'give_item') {
        const target = this.getHumanPlayerEntity(args.player || '');
        if (!target) return { success: false, message: '附近找不到目标玩家' };
        const candidates = resolveNames(args.item, ITEM_ALIASES);
        const item = bot.inventory.items().find((i) => candidates.includes(i.name) || i.name.includes(String(args.item).toLowerCase()));
        if (!item) return { success: false, message: `我背包里没有 ${args.item}` };
        const qty = Math.min(item.count, Math.max(1, Number(args.count || item.count)));
        this.activeMode = 'task';
        this.activeTaskLabel = `送 ${item.name} 给 ${target.username}`;
        await this.gotoWithTimeout(new GoalNear(target.position.x, target.position.y, target.position.z, 2), 12000);
        await bot.lookAt(target.position.offset(0, 1.4, 0), true);
        await bot.toss(item.type, null, qty);
        if (this.taskSeq === mySeq) { this.activeMode = 'idle'; this.activeTaskLabel = '待命中'; }
        return { success: true, message: `已把 ${item.name} x${qty} 扔给 ${target.username}` };
      }

      if (name === 'equip_item') {
        const candidates = resolveNames(args.item, ITEM_ALIASES);
        const item = bot.inventory.items().find((i) => candidates.includes(i.name) || i.name.includes(String(args.item).toLowerCase()));
        if (!item) return { success: false, message: `我背包里没有 ${args.item}` };
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
        // 若未明确指定苦力怕，默认跳过苦力怕防止白给炸死
        const wantCreeper = Boolean(filter && filter.includes('creeper'));
        const target = this.findNearestHostile(24, filter, !wantCreeper);
        if (!target) return { success: false, message: `附近 24 格内没看到 ${args.mob || '敌对怪物'}` };
        const tCn = cnMob(target.name);
        this.activeMode = 'task';
        this.activeTaskLabel = `追击 ${tCn}`;
        await this.equipBestWeapon();
        const deadline = Date.now() + 14000;
        let hits = 0;

        while (target.isValid && Date.now() < deadline && this.taskSeq === mySeq) {
          const myPos = bot.entity.position;
          const d = target.position.distanceTo(myPos);
          if (d > 26 || (bot.health ?? 20) <= 5) break;

          if (target.name === 'creeper') {
            // 苦力怕放风筝协议：贴近砍一刀立刻反方向疾跑退 7 格重置引信！
            if (d > 3.2) {
              bot.setControlState('sprint', true);
              bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 2), true);
            } else {
              await bot.lookAt(target.position.offset(0, 1.0, 0), true);
              bot.attack(target);
              hits++;
              const diff = myPos.minus(target.position);
              const len = Math.hypot(diff.x, diff.z) || 1;
              bot.setControlState('sprint', true);
              bot.pathfinder.setGoal(new GoalXZ(Math.round(myPos.x + (diff.x / len) * 8), Math.round(myPos.z + (diff.z / len) * 8)), true);
              await sleep(1100);
              continue;
            }
          } else {
            if (d > 2.8) {
              bot.setControlState('sprint', true);
              bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 1), true);
            } else {
              bot.setControlState('sprint', false);
              if (Date.now() - this.lastAttackAt >= 580) {
                this.lastAttackAt = Date.now();
                await bot.lookAt(target.position.offset(0, (target.height || 1.4) * 0.65, 0), true);
                bot.attack(target);
                hits++;
              }
            }
          }
          await sleep(180);
        }

        bot.setControlState('sprint', false);
        try { bot.pathfinder.setGoal(null); } catch {}
        if (this.taskSeq === mySeq) { this.activeMode = 'idle'; this.activeTaskLabel = '待命中'; }
        if (!target.isValid) {
          return { success: true, message: `已经打死那只${tCn}了！` };
        }
        return { success: hits > 0, message: hits > 0 ? `追着${tCn}砍了 ${hits} 下，它还没死或跑开了` : `没追上那只${tCn}` };
      }

      if (name === 'place_torch') {
        let torch = bot.inventory.items().find((i) => i.name === 'torch');
        if (!torch) {
          const c = await this.executeSkill('craft_item', { item: 'torch', count: 1 });
          if (c.success) torch = bot.inventory.items().find((i) => i.name === 'torch');
        }
        if (!torch) return { success: false, message: '我背包里没有火把，也没有木棍和煤炭可以合成火把' };
        const under = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        if (!under || under.name === 'air') return { success: false, message: '脚下是空的，没法插火把' };
        await bot.equip(torch, 'hand');
        await bot.placeBlock(under, new Vec3(0, 1, 0));
        return { success: true, message: '已经在脚边插好一根火把了' };
      }

      if (name === 'sleep_in_bed') {
        const bed = bot.findBlock({ matching: (b) => b && b.name.endsWith('_bed'), maxDistance: 18 });
        if (!bed) return { success: false, message: '附近 18 格内没看到床' };
        await this.gotoWithTimeout(new GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 10000);
        await bot.sleep(bed);
        return { success: true, message: '已经躺上床睡觉了' };
      }

      if (name === 'build_shelter') {
        // 先自动把身上原木合成为木板
        await this.convertLogsToPlanksIfNeeded();
        const totalBlocks = bot.inventory.items()
          .filter((i) => BUILD_BLOCKS.includes(i.name))
          .reduce((acc, i) => acc + i.count, 0);
        if (totalBlocks < 16) {
          return { success: false, message: `我身上只有 ${totalBlocks} 块建筑方块，不够搭防怪围墙（至少要 16 块木板/圆石/泥土），得先砍点木头或挖点土` };
        }
        // 尽量跑到玩家身边开建
        const player = this.getHumanPlayerEntity('');
        if (player && player.position.distanceTo(bot.entity.position) > 5 && player.position.distanceTo(bot.entity.position) < 28) {
          await this.gotoWithTimeout(new GoalNear(player.position.x, player.position.y, player.position.z, 2), 8000).catch(() => {});
        }
        this.activeMode = 'task';
        this.activeTaskLabel = '搭建 2 格高简易防怪小屋';
        const base = bot.entity.position.floored();
        // 5x5 两格高带南侧 1 格门洞的围墙，防僵尸直接迈进来
        const ring = [
          [2, -2], [2, -1], [2, 0], [2, 1], [2, 2],
          [-2, -2], [-2, -1], [-2, 0], [-2, 1], [-2, 2],
          [-1, 2], [0, 2], [1, 2],
          [-1, -2], [1, -2], // (0, -2) 留门洞
        ];
        let placed = 0;
        for (const dy of [0, 1]) {
          for (const [dx, dz] of ring) {
            if (this.taskSeq !== mySeq) break;
            const mat = bot.inventory.items().find((i) => BUILD_BLOCKS.includes(i.name));
            if (!mat) break;
            const pos = base.offset(dx, dy, dz);
            const cur = bot.blockAt(pos);
            const below = bot.blockAt(pos.offset(0, -1, 0));
            if (cur?.name === 'air' && below && below.name !== 'air') {
              try {
                if (bot.heldItem?.name !== mat.name) await bot.equip(mat, 'hand');
                await bot.placeBlock(below, new Vec3(0, 1, 0));
                placed++;
                await sleep(130);
              } catch {}
            }
          }
        }
        if (this.taskSeq === mySeq) { this.activeMode = 'idle'; this.activeTaskLabel = '待命中'; }
        return {
          success: placed >= 6,
          message: placed >= 6 ? `已经实际搭好了 ${placed} 块围墙方块（留了门洞）` : `地形坑洼不平，只放下了 ${placed} 块方块，得换块平一点的地`,
        };
      }

      if (name === 'set_home') {
        saveHome(bot.entity.position);
        const p = bot.entity.position;
        return { success: true, message: `已把 (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}) 记为咱们的家` };
      }

      if (name === 'go_home') {
        const home = loadHome();
        if (!home) return { success: false, message: '还没设置过家的坐标呢' };
        this.activeMode = 'task';
        this.activeTaskLabel = `回家 (${home.x},${home.y},${home.z})`;
        await this.gotoWithTimeout(new GoalBlock(home.x, home.y, home.z), 22000);
        if (this.taskSeq === mySeq) { this.activeMode = 'idle'; this.activeTaskLabel = '已回到家'; }
        return { success: true, message: `已经回到家 (${home.x}, ${home.y}, ${home.z}) 了` };
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
