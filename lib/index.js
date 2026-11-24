/**
 * dsh-pet-coo-link — 蓝毛小女仆（dsh-pet）× 大肥鱼（Coopanion）的对话通道。
 *
 * 设计要点：
 *  - 两只宠物各自有记忆，这里只维护「宠物频道」自己的共享记忆（近期细节 + 更早话题）；
 *  - 大肥鱼陪玩游戏时（watch-window 最近 N 秒有画面），她的游戏话不进宠物频道，
 *    改用独立话题继续陪小女仆聊，两条线不串味；
 *  - 人手插话优先：手动 say 之后自动循环让路一段时间；
 *  - 开关既能用工具（pet_coo_toggle），也能在设置页里改（config.enabled）；
 *  - 所有数据放 $DSH_HOME/dsh-pet-coo-link，插件升级不丢。
 */

import Schema from '@deepseek-ai/schemastery'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-pet-coo-link'

export const inject = ['tools']

export const Config = Schema.object({
  enabled: Schema.boolean().default(false).description('启用自动对话循环（设置页开关）'),
  intervalMinutes: Schema.number().min(0.5).max(240).step(0.5).default(2).description('每隔多少分钟聊一轮'),
  memoryRounds: Schema.number().min(0).max(20).step(1).default(10).description('每轮注入几轮近期记忆'),
  watchQuietSec: Schema.number().min(0).max(3600).step(10).default(300).description('她看游戏多久算「陪玩中」'),
  topicRotation: Schema.boolean().default(true).description('她沉默时自动换话题'),
  notifyOnToggle: Schema.boolean().default(true).description('开关时通知两只宠物（她会真的开口）'),
  petId: Schema.string().default('main').description('小女仆的宠物 id'),
  autoStartOnBoot: Schema.boolean().default(false).description('DSH 启动后自动开始循环'),
  hotkey: Schema.string().default('F9').description('全局快捷键（Electron accelerator 写法，如 Control+Alt+P）'),
})

/** 话题池：每次主动搭话换一个方向。 */
const TOPICS = [
  '你今天吃到什么好吃的东西了吗？',
  '你平时喜欢听什么歌呀？',
  '你最喜欢的颜色是什么？',
  '如果明天放假，你想干嘛？',
  '你会为什么事情开心一整天？',
  '你怕打雷吗？',
  '你最近在看什么书或者剧？',
  '你小时候有什么好玩的事？',
  '你喜欢猫还是狗？',
  '你有想去的城市吗？',
  '熬夜和早起你更受不了哪个？',
  '你觉得自己最像什么小动物？',
  '有没有什么小事让你特别满足？',
  '如果会一种魔法，你想会什么？',
  '你讨厌别人怎么跟你说话？',
]

const COOP_EVENTS = 'http://127.0.0.1:17788/api/events'
const COOP_TRANSCRIPT = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'Programs',
  'Coopanion',
  'data',
  'home',
  'companion',
  'data',
  'session-main.jsonl',
)

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const dataDir = join(home, 'dsh-pet-coo-link')
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch {
    /* 目录建不出来也不至于崩 */
  }

  const files = {
    state: join(dataDir, 'state.json'),
    memory: join(dataDir, 'memory.jsonl'),
    chat: join(dataDir, 'chat.md'),
    daily: join(dataDir, 'daily.json'),
    facts: join(dataDir, 'facts.json'),
    log: join(dataDir, 'link.log'),
  }

  const runtime = {
    enabled: false,
    timer: null,
    lastSaidKey: '',
    lastReply: '',
    topicIndex: 0,
    suppressUntil: 0,
    hotkey: String(config.hotkey ?? 'F9'),
    intervalMinutes: Number(config.intervalMinutes ?? 2),
    memoryRounds: Number(config.memoryRounds ?? 10),
  }

  const log = (m) => {
    try {
      appendFileSync(files.log, `[${new Date().toISOString()}] ${m}\n`, 'utf8')
    } catch {
      /* ignore */
    }
  }

  const readJson = (file, dflt = {}) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return dflt
    }
  }

  const base = () => {
    try {
      const origin = ctx.get('webServer')?.getOrigin?.()
      if (typeof origin === 'string' && origin.startsWith('http')) return origin
    } catch {
      /* ignore */
    }
    return ''
  }

  /* ---------- 数据：状态 / 记忆 / 记录 ---------- */

  const loadState = () => {
    const s = readJson(files.state, {})
    runtime.topicIndex = Number(s.topicIndex ?? 0)
    runtime.lastSaidKey = String(s.lastSaidKey ?? '')
    runtime.lastReply = String(s.lastReply ?? '')
    if (typeof s.hotkey === 'string' && s.hotkey.trim()) runtime.hotkey = s.hotkey.trim()
    const iv = Number(s.intervalMinutes)
    if (iv >= 0.5 && iv <= 240) runtime.intervalMinutes = iv
    const mr = Number(s.memoryRounds)
    if (mr >= 0 && mr <= 20) runtime.memoryRounds = mr
    return s
  }

  const saveState = () => {
    try {
      writeFileSync(
        files.state,
        JSON.stringify(
          {
            enabled: runtime.enabled,
            topicIndex: runtime.topicIndex,
            lastSaidKey: runtime.lastSaidKey,
            lastReply: runtime.lastReply,
            hotkey: runtime.hotkey,
            intervalMinutes: runtime.intervalMinutes,
            memoryRounds: runtime.memoryRounds,
            at: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch {
      /* ignore */
    }
  }

  const memoryRows = () => {
    try {
      return readFileSync(files.memory, 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  /** 两层记忆：近期逐轮细节 + 更早只留话题关键词。 */
  const memoryDigest = (seed = '') => {
    const rows = memoryRows()
    if (!rows.length) return ''
    const rounds = Number(runtime.memoryRounds ?? 10)
    const recent = rows.slice(-rounds)
    const older = rows.slice(0, Math.max(0, rows.length - rounds)).slice(-40)

    const detail = []
    for (const row of recent) {
      try {
        const r = JSON.parse(row)
        const said = String(r.said ?? '').replace(/\s+/g, ' ').slice(0, 28)
        const reply = String(r.reply ?? '').replace(/\s+/g, ' ').slice(0, 28)
        if (said || reply) detail.push(`她说「${said}」→ 你答「${reply}」`)
      } catch {
        /* 坏行跳过 */
      }
    }

    const themes = []
    for (const row of older) {
      try {
        const r = JSON.parse(row)
        const key = String(r.said ?? '').replace(/\s+/g, ' ').replace(/^（.*?）/, '').slice(0, 12)
        if (key && !themes.includes(key)) themes.push(key)
      } catch {
        /* ignore */
      }
    }

    const recalled = recallByKeyword(seed).map((r) => `她说「${r.said}」→ 你答「${r.reply}」`)
    return [
      factsDigest(),
      dailyDigest(),
      detail.length ? `最近聊过：${detail.join('；')}` : '',
      themes.length ? `更早还聊过这些：${themes.slice(-6).join('、')}` : '',
      recalled.length ? `很久以前聊过，可以接着提：${recalled.join('；')}` : '',
    ]
      .filter(Boolean)
      .join('。')
  }

  /**
   * 关键词回忆：拿当前这句话里的 2 字片段去更早的记忆里找，零模型成本。
   * 目的——聊到「打雷」「猫」这类具体话题时，能想起很久以前说过的话。
   */
  const recallByKeyword = (seed, limit = 2) => {
    try {
      const text = String(seed ?? '').replace(/\s+/g, '')
      if (text.length < 2) return []
      const rows = memoryRows()
      const rounds = Number(runtime.memoryRounds ?? 10)
      const older = rows.slice(0, Math.max(0, rows.length - rounds))
      if (!older.length) return []

      const grams = new Set()
      for (let i = 0; i + 2 <= text.length; i += 1) grams.add(text.slice(i, i + 2))
      const scored = []
      for (const row of older) {
        try {
          const r = JSON.parse(row)
          const hay = (String(r.said ?? '') + String(r.reply ?? '')).replace(/\s+/g, '')
          let hits = 0
          for (const g of grams) {
            if (hay.includes(g)) hits += 1
          }
          if (hits >= 2) {
            scored.push({
              hits,
              said: String(r.said ?? '').replace(/\s+/g, ' ').slice(0, 20),
              reply: String(r.reply ?? '').replace(/\s+/g, ' ').slice(0, 20),
            })
          }
        } catch {
          /* 坏行跳过 */
        }
      }
      scored.sort((a, b) => b.hits - a.hits)
      return scored.slice(0, limit)
    } catch {
      return []
    }
  }

  const remember = (said, reply) => {
    try {
      appendFileSync(files.memory, JSON.stringify({ at: new Date().toISOString(), said, reply }) + '\n', 'utf8')
      const rows = memoryRows()
      if (rows.length > 300) writeFileSync(files.memory, rows.slice(-300).join('\n') + '\n', 'utf8')
    } catch {
      /* ignore */
    }
  }

  /* ---------- ③ 每日摘要（启发式，不花模型钱） ---------- */

  const todayKey = () => new Date().toISOString().slice(0, 10)

  /** 把一句话压成一小段可读的「话头」，用作当天摘要。 */
  const snippet = (text) => {
    const cleaned = String(text ?? '')
      .replace(/【[^】]*】/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return cleaned.slice(0, 14)
  }

  const updateDaily = (said, reply) => {
    try {
      const data = readJson(files.daily, {})
      const day = todayKey()
      const entry = data[day] ?? { rounds: 0, snippets: [] }
      entry.rounds = Number(entry.rounds ?? 0) + 1
      const list = Array.isArray(entry.snippets) ? entry.snippets : []
      for (const s of [snippet(said), snippet(reply)]) {
        if (s && !list.includes(s)) list.push(s)
      }
      // 只留最近 6 段，摘要取最后 3 段
      entry.snippets = list.slice(-6)
      entry.summary = entry.snippets.slice(-3).join('、')
      data[day] = entry
      const keys = Object.keys(data).sort()
      for (const k of keys.slice(0, Math.max(0, keys.length - 14))) delete data[k]
      writeFileSync(files.daily, JSON.stringify(data, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }

  const dailyDigest = () => {
    try {
      const data = readJson(files.daily, {})
      const days = Object.keys(data).sort().slice(-3)
      const parts = []
      for (const d of days) {
        const e = data[d]
        if (!e) continue
        const label = d === todayKey() ? '今天' : d
        if (e.summary) parts.push(label + '聊到 ' + e.summary)
      }
      return parts.length ? '日子里的印象：' + parts.join('；') : ''
    } catch {
      return ''
    }
  }

  /* ---------- ④ 事实卡（正则抽取，长期人设） ---------- */

  const FACT_PATTERNS = [
    /我(?:最)?(?:喜欢|偏爱|爱)([^，。！？,.!?\s]{1,12})/g,
    /我(?:最)?(?:讨厌|不喜欢|受不了)([^，。！？,.!?\s]{1,12})/g,
    /我(?:害怕|怕)([^，。！？,.!?\s]{1,12})/g,
    /我(?:是|属于)?([\u4e00-\u9fa5]{1,4})派的/g,
    /我(?:不|从不)(?:吃|喝)([^，。！？,.!?\s]{1,8})/g,
    /我(?:最爱|最喜欢)吃([^，。！？,.!?\s]{1,8})/g,
  ]

  const extractFacts = (said, reply) => {
    try {
      const data = readJson(files.facts, { items: [] })
      const items = Array.isArray(data.items) ? data.items : []
      for (const text of [String(said ?? ''), String(reply ?? '')]) {
        for (const re of FACT_PATTERNS) {
          re.lastIndex = 0
          let m
          while ((m = re.exec(text)) !== null) {
            const line = String(m[0]).trim().slice(0, 24)
            if (!line) continue
            const hit = items.find((it) => it.text === line)
            if (hit) {
              hit.hits = Number(hit.hits ?? 1) + 1
              hit.at = new Date().toISOString()
            } else {
              items.push({ text: line, hits: 1, at: new Date().toISOString() })
            }
          }
        }
      }
      items.sort((a, b) => Number(b.hits ?? 0) - Number(a.hits ?? 0))
      writeFileSync(files.facts, JSON.stringify({ items: items.slice(0, 40) }, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }

  const factsDigest = () => {
    try {
      const data = readJson(files.facts, { items: [] })
      const items = Array.isArray(data.items) ? data.items.slice(0, 8) : []
      if (!items.length) return ''
      return '关于你们俩：' + items.map((it) => it.text).join('；')
    } catch {
      return ''
    }
  }

  const appendChatMd = (said, reply, meme) => {
    try {
      const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
      let md = existsSync(files.chat) ? readFileSync(files.chat, 'utf8') : '# 大肥鱼 × 蓝毛小女仆 对话记录\n\n'
      md += `- **${stamp}**\n  - 大肥鱼：${said}\n  - 小女仆：${reply}${meme ? `（表情包：${meme}）` : ''}\n`
      const lines = md.split('\n')
      if (lines.length > 900) md = lines.slice(-900).join('\n')
      writeFileSync(files.chat, md, 'utf8')
    } catch {
      /* ignore */
    }
  }

  /* ---------- 与大肥鱼的 IO ---------- */

  /** 她的最新一句（优先事件流，回退 transcript）。 */
  const herLatestLine = async () => {
    try {
      const res = await fetch(COOP_EVENTS, { signal: AbortSignal.timeout(4000) })
      const data = await res.json()
      const list = Array.isArray(data?.events) ? data.events : []
      for (let i = list.length - 1; i >= 0; i--) {
        const ev = list[i]
        if (!String(ev?.type ?? '').endsWith('.speech')) continue
        const text = String(ev?.text ?? '').trim()
        if (!text || text.includes('主人:')) continue
        return { script: text, key: String(ev?.cursor ?? ev?.ts ?? i), ts: Date.parse(String(ev?.ts ?? '')) || 0 }
      }
    } catch {
      /* 落到 transcript */
    }

    try {
      const lines = readFileSync(COOP_TRANSCRIPT, 'utf8').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line || !line.includes('pet_say')) continue
        try {
          const rec = JSON.parse(line)
          if (rec?.item?.name !== 'pet_say') continue
          const parsed = JSON.parse(rec.item.arguments ?? '{}')
          const script = typeof parsed.script === 'string' ? parsed.script.trim() : ''
          if (!script || script.includes('主人:') || script.includes('【thinking】')) continue
          return { script, key: String(rec.item.call_id ?? rec.item.id ?? line.length), ts: Date.parse(rec?.context?.ts ?? '') || 0 }
        } catch {
          /* 坏行 */
        }
      }
    } catch {
      /* ignore */
    }
    return null
  }

  /** 最近一次盯窗/陪玩时间戳。 */
  const lastWatchTs = async () => {
    try {
      const res = await fetch(COOP_EVENTS, { signal: AbortSignal.timeout(4000) })
      const data = await res.json()
      const list = Array.isArray(data?.events) ? data.events : []
      let latest = 0
      for (const ev of list) {
        if (!String(ev?.type ?? '').startsWith('watch-window.')) continue
        const t = Date.parse(String(ev?.ts ?? ''))
        if (Number.isFinite(t) && t > latest) latest = t
      }
      return latest
    } catch {
      return 0
    }
  }

  const watchingNow = async () => {
    const ts = await lastWatchTs()
    if (!ts) return { on: false, age: 0 }
    const age = Date.now() - ts
    return { on: age <= Number(config.watchQuietSec ?? 300) * 1000, age }
  }

  /** 推给大肥鱼：走桥的 /coopanion/tell（reply 帧）。 */
  const tellHer = async (text) => {
    const origin = base()
    if (!origin) return { ok: false, reason: 'no-origin' }
    try {
      const res = await fetch(`${origin}/coopanion/tell?from=${encodeURIComponent('小女仆')}&text=${encodeURIComponent(text)}`, {
        signal: AbortSignal.timeout(8000),
      })
      const body = await res.json().catch(() => ({}))
      return { ok: body?.delivered === true, status: res.status }
    } catch (e) {
      return { ok: false, reason: String(e?.message ?? e) }
    }
  }

  /** 让小女仆说一句（会真的开口，气泡与语音都有）。 */
  const askPet = async (text) => {
    const origin = base()
    if (!origin) throw new Error('取不到宿主地址')
    const url = `${origin}/dsh-pet-7340/chat?pet=${encodeURIComponent(String(config.petId ?? 'main'))}&surface=any`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(120000),
    })
    const body = await res.json().catch(() => ({}))
    if (res.status !== 200 || body?.ok !== true) {
      throw new Error(`小女仆 chat 失败 HTTP ${res.status}`)
    }
    return body
  }

  const nextTopic = () => {
    const history = memoryRows().slice(-30).join(' ')
    const start = runtime.topicIndex % TOPICS.length
    let chosen = TOPICS[start]
    if (history.includes(chosen)) {
      for (let step = 1; step <= TOPICS.length; step += 1) {
        const candidate = TOPICS[(start + step) % TOPICS.length]
        if (!history.includes(candidate)) {
          chosen = candidate
          break
        }
      }
    }
    runtime.topicIndex = (start + 1) % TOPICS.length
    saveState()
    return chosen
  }

  /* ---------- 一轮对话 ---------- */

  const runRound = async (opts = {}) => {
    if (Date.now() < runtime.suppressUntil) {
      return { skipped: 'manual-relay' }
    }
    const watch = await watchingNow()
    let said = null
    let nudge = null

    if (watch.on) {
      nudge = config.topicRotation === false ? '你今天心情怎么样？' : nextTopic()
    } else {
      said = await herLatestLine()
      if (!said) return { skipped: 'no-line' }
      if (said.key === runtime.lastSaidKey && config.topicRotation !== false) {
        nudge = nextTopic()
      }
      // 陪玩时说的话不进宠物频道
      const watchTs = await lastWatchTs()
      if (!nudge && watchTs > 0 && said.ts > 0 && said.ts <= watchTs + 1000) {
        return { skipped: 'game-talk' }
      }
    }

    const seedText = nudge ? nudge : String(said?.script ?? '')
    const digest = memoryDigest(seedText)
    const outbound =
      (nudge ? `隔壁的大肥鱼没吭声，你主动跟她说一句：${nudge}` : `隔壁的大肥鱼对你说：${said.script}`) +
      `\n（对方是隔壁那只大肥鱼，不是主人；回一两句就好，最后反问她一个问题。` +
      (runtime.lastReply ? `上一句你说过「${runtime.lastReply}」，换个说法。` : '') +
      '）'

    const reply = await askPet(digest ? `（你们之前聊过：${digest}）\n${outbound}` : outbound)
    runtime.lastReply = String(reply.text ?? '')
    if (!nudge && said) runtime.lastSaidKey = said.key
    saveState()

    remember(nudge ? `（主动搭话）${nudge}` : said.script, runtime.lastReply)
    updateDaily(nudge ? nudge : said.script, runtime.lastReply)
    extractFacts(nudge ? nudge : said.script, runtime.lastReply)
    appendChatMd(nudge ? `（主动搭话）${nudge}` : said.script, runtime.lastReply, reply.image)

    const told = await tellHer(
      (digest ? `（你们之前聊过：${digest}）` : '') +
        `（这是蓝毛小女仆说的话，不是主人）小女仆在等你回一句：${runtime.lastReply}`,
    )

    log(`一轮完成：${nudge ? `话题「${nudge}」` : `她「${String(said.script).slice(0, 20)}」`} → 小女仆「${runtime.lastReply.slice(0, 20)}」投递${told.ok ? '成功' : '失败'}`)
    return { said: nudge ?? said.script, reply: runtime.lastReply, meme: reply.image ?? null, told }
  }

  /* ---------- 循环 ---------- */

  const schedule = () => {
    if (!runtime.enabled) return
    const minutes = Number(runtime.intervalMinutes ?? 2)
    const baseMs = Math.max(30_000, minutes * 60_000)
    const delay = Math.max(20_000, Math.round(baseMs * (1 + (Math.random() * 0.6 - 0.3))))
    runtime.timer = setTimeout(async () => {
      try {
        await runRound()
      } catch (e) {
        log('本轮失败：' + String(e?.message ?? e))
      }
      schedule()
    }, delay)
    runtime.timer.unref?.()
  }

  const stopLoop = () => {
    if (runtime.timer) {
      clearTimeout(runtime.timer)
      runtime.timer = null
    }
    runtime.enabled = false
    saveState()
  }

  const startLoop = () => {
    runtime.enabled = true
    saveState()
    if (!runtime.timer) {
      runRound()
        .catch(() => {})
        .finally(() => schedule())
    }
  }

  const notifyToggle = async (started) => {
    if (config.notifyOnToggle === false) return
    const mine = started ? '主人让我们开始聊天啦～' : '主人叫停了，先不聊啦～'
    try {
      await askPet(`（主人通知）${mine} 你就回一句话确认一下。`)
    } catch (e) {
      log('通知小女仆失败：' + String(e?.message ?? e))
    }
    await tellHer(
      started
        ? '主人开绿灯了：现在可以跟小女仆聊天啦。请用一句话把这件事说出来，让主人听见。'
        : '主人叫停了：现在先别跟小女仆聊天。请用一句话说一声。',
    )
  }

  const toggle = async (want) => {
    const target = typeof want === 'boolean' ? want : !runtime.enabled
    if (target === runtime.enabled) return { enabled: runtime.enabled, changed: false }
    if (target) {
      // 先起循环：首轮马上开始，不被通知那十秒的模型调用拖住。
      startLoop()
      await notifyToggle(true)
    } else {
      stopLoop()
      await notifyToggle(false)
    }
    return { enabled: runtime.enabled, changed: true }
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (c) => {
        chunks.push(c)
        if (chunks.reduce((n, b) => n + b.length, 0) > 64 * 1024) reject(new Error('body too large'))
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const status = () => ({
    enabled: runtime.enabled,
    intervalMinutes: runtime.intervalMinutes,
    memoryRounds: runtime.memoryRounds,
    memoryLines: memoryRows().length,
    lastReply: runtime.lastReply,
    hotkey: runtime.hotkey,
    topicIndex: runtime.topicIndex,
    dataDir,
  })

  /* ---------- 工具 ---------- */

  /** DSH 工具必须声明 output；这里统一用纯文本结果。 */
  const stringOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
  }

  const toolDefs = [
    {
      name: 'pet_coo_status',
      output: stringOutput,
      description: '查看「大肥鱼 × 蓝毛小女仆」对话通道的状态（是否在自动聊、间隔、记忆条数、最近一句）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return JSON.stringify(status())
      },
    },
    {
      name: 'pet_coo_toggle',
      output: stringOutput,
      description: '开/关两只桌宠之间的自动对话循环。开启时两只宠物都会收到通知（小女仆会真的开口）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'toggle'], description: '要做什么' },
        },
        required: ['action'],
      },
      async execute(args) {
        const action = String(args?.action ?? 'toggle')
        const result = await toggle(action === 'start' ? true : action === 'stop' ? false : undefined)
        return JSON.stringify(result)
      },
    },
    {
      name: 'pet_coo_say',
      output: stringOutput,
      description: '替人转一句话给小女仆，并把她原话推回给大肥鱼。人工优先，自动循环会让路一段时间。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要转达的话' },
        },
        required: ['text'],
      },
      async execute(args) {
        const text = String(args?.text ?? '').trim()
        if (!text) return JSON.stringify({ ok: false, error: 'text is required' })
        runtime.suppressUntil = Date.now() + 150_000
        const digest = memoryDigest(text)
        const reply = await askPet(digest ? `（你们之前聊过：${digest}）\n大肥鱼说：${text}` : `大肥鱼说：${text}`)
        runtime.lastReply = String(reply.text ?? '')
        saveState()
        remember(text, runtime.lastReply)
        updateDaily(text, runtime.lastReply)
        extractFacts(text, runtime.lastReply)
        appendChatMd(text, runtime.lastReply, reply.image)
        const told = await tellHer(`（这是蓝毛小女仆说的话，不是主人）小女仆回你：${runtime.lastReply}`)
        return JSON.stringify({ reply: runtime.lastReply, meme: reply.image ?? null, delivered: told.ok })
      },
    },
    {
      name: 'pet_coo_run_once',
      output: stringOutput,
      description: '立刻跑一轮（不改变开关状态）：取大肥鱼最新一句 → 问小女仆 → 推回给她。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        const result = await runRound()
        return JSON.stringify(result)
      },
    },
    {
      name: 'pet_coo_history',
      output: stringOutput,
      description: '读最近的对话记录（人读版），默认最近 10 条。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: '最多几条，默认 10' } },
      },
      async execute(args) {
        const limit = Math.min(50, Math.max(1, Number(args?.limit ?? 10)))
        try {
          const md = readFileSync(files.chat, 'utf8')
          const parts = md.split('\n- **').filter(Boolean)
          return parts.slice(-limit).map((p) => '- **' + p).join('\n') || '（还没有记录）'
        } catch {
          return '（还没有记录）'
        }
      },
    },
  ]

  for (const def of toolDefs) {
    ctx.effect(() => ctx.tools.register(def), `dsh-pet-coo-link: ${def.name}`)
  }

  /* ---------- 设置页：把 Config 交给设置服务，插件配置里就能开关 ---------- */

  // 设置页不需要手动注册：本宿主从插件导出的 Config schema 派生设置项。

  /* ---------- HTTP：给体检脚本用 ---------- */

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/pet-coo/status',
          handler: (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(status()))
          },
        }),
      'dsh-pet-coo-link: status route',
    )

    // 记忆轮数：POST { rounds: 10 }
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/pet-coo/memory',
          handler: async (req, res) => {
            const send = (code, payload) => {
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify(payload))
            }
            if (req.method !== 'POST') return send(405, { error: 'method not allowed' })
            let body = {}
            try {
              body = JSON.parse(await readBody(req))
            } catch {
              return send(400, { error: 'invalid json' })
            }
            const rounds = Number(body?.rounds)
            if (!Number.isFinite(rounds) || rounds < 0 || rounds > 20) {
              return send(400, { error: '轮数需在 0–20 之间' })
            }
            runtime.memoryRounds = Math.round(rounds)
            saveState()
            log('记忆轮数已设为 ' + runtime.memoryRounds)
            return send(200, { ok: true, memoryRounds: runtime.memoryRounds })
          },
        }),
      'dsh-pet-coo-link: memory route',
    )

    // 设置页改间隔：POST { minutes: 2 }
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/pet-coo/interval',
          handler: async (req, res) => {
            const send = (code, payload) => {
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify(payload))
            }
            if (req.method !== 'POST') return send(405, { error: 'method not allowed' })
            let body = {}
            try {
              body = JSON.parse(await readBody(req))
            } catch {
              return send(400, { error: 'invalid json' })
            }
            const minutes = Number(body?.minutes)
            if (!Number.isFinite(minutes) || minutes < 0.5 || minutes > 240) {
              return send(400, { error: '间隔需在 0.5–240 分钟之间' })
            }
            runtime.intervalMinutes = minutes
            saveState()
            log('间隔已设为 ' + minutes + ' 分钟')
            // 正在跑的话，按新间隔重排下一轮
            if (runtime.enabled) {
              if (runtime.timer) {
                clearTimeout(runtime.timer)
                runtime.timer = null
              }
              schedule()
            }
            return send(200, { ok: true, intervalMinutes: runtime.intervalMinutes })
          },
        }),
      'dsh-pet-coo-link: interval route',
    )

    // 设置页改快捷键：POST { hotkey: 'Control+Alt+P' }
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/pet-coo/hotkey',
          handler: async (req, res) => {
            const send = (code, payload) => {
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify(payload))
            }
            if (req.method !== 'POST') return send(405, { error: 'method not allowed' })
            let body = {}
            try {
              body = JSON.parse(await readBody(req))
            } catch {
              return send(400, { error: 'invalid json' })
            }
            const raw = String(body?.hotkey ?? '').trim()
            if (!raw || raw.length > 64) return send(400, { error: 'hotkey is required' })
            // 必须是「修饰键 + 主键」，否则像 'O' 这种裸键会抢掉全局输入。
            const MODS = ['control', 'ctrl', 'alt', 'shift', 'command', 'cmd', 'commandorcontrol', 'super', 'meta']
            const parts = raw.split('+').map((x) => x.trim()).filter(Boolean)
            const hasMod = parts.slice(0, -1).some((p) => MODS.includes(p.toLowerCase()))
            const main = parts[parts.length - 1] ?? ''
            // 单功能键（F1–F24）可以不配修饰键：它不会抢掉打字。
            const FUNCTION_KEY = /^f([1-9]|1[0-9]|2[0-4])$/i.test(main)
            if (parts.length < 2 && !FUNCTION_KEY) {
              return send(400, { error: '快捷键需要包含修饰键，例如 Control+Alt+P' })
            }
            runtime.hotkey = raw
            saveState()
            log('快捷键已设为 ' + raw)
            return send(200, { ok: true, hotkey: runtime.hotkey })
          },
        }),
      'dsh-pet-coo-link: hotkey route',
    )

    // 设置页那张卡片的开关：POST { enabled: boolean }
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/pet-coo/toggle',
          handler: async (req, res) => {
            const send = (code, payload) => {
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify(payload))
            }
            if (req.method !== 'POST') return send(405, { error: 'method not allowed' })
            let body = {}
            try {
              body = JSON.parse(await readBody(req))
            } catch {
              return send(400, { error: 'invalid json' })
            }
            try {
              const result = await toggle(body?.enabled === true)
              return send(200, result)
            } catch (e) {
              return send(500, { error: String(e?.message ?? e) })
            }
          },
        }),
    )
  })

  /* ---------- 启动 ---------- */

  loadState()
  if (config.enabled === true || config.autoStartOnBoot === true) {
    runtime.enabled = true
    runRound()
      .catch(() => {})
      .finally(() => schedule())
    log('随插件启动自动开聊')
  }

  ctx.effect(() => () => stopLoop(), 'dsh-pet-coo-link: loop')
}