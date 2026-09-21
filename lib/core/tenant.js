/**
 * 租户模型与租户注册表（多租户网关的地基）。
 *
 * 为什么需要它：一个 Harness 实例本身就是**单用户**的（会话、凭据、设置、工作区、启动令牌
 * 都在它自己的 `DSH_HOME` 里）。所以"多租户"不是给单个实例加个开关，而是：
 *
 *     一个网关（本插件） ──按租户凭据路由──► 每个租户一个独立 Harness 实例
 *                                              （独立 DSH_HOME / 端口 / 令牌）
 *
 * 本模块只做三件事：校验租户定义、把定义持久化到注册表、按凭据或 id 查租户。
 * 实例的启动与看护在 core/instance.js，请求路由在 core/proxy.js。
 *
 * 注册表是 JSON 文件（默认 `<stateDir>/tenants.json`，0600），写入用「临时文件 + rename」，
 * 避免面板/CLI 同时改的时候留下半个文件。
 *
 * @module dsh-plugin-remote-connect-beta/core/tenant
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/** 租户 id：小写、数字、连字符；2–32 位；直接用作 DSH profile 名与目录名。 */
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/

/** 访问密钥形态：URL 安全字符，16–128 位（与 public.accessKey 同规则）。 */
export const ACCESS_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

/** 默认的租户根目录：每个租户的 DSH_HOME 放在它下面。 */
export function defaultTenantBaseDir(homeDir = os.homedir()) {
  return path.join(homeDir, 'DSH-tenants')
}

/** 生成一个租户访问密钥（32 字符 base64url ≈ 192 bit）。 */
export function generateAccessKey() {
  return crypto.randomBytes(24).toString('base64url')
}

/** 把用户输入的显示名收敛成合法 id（中文名等无法直接当目录名）。 */
export function slugifyId(value, fallback = 't') {
  const ascii = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  if (TENANT_ID_PATTERN.test(ascii)) return ascii
  // 全是非 ASCII（例如中文名）：用调用方给的兜底前缀 + 随机尾巴，保证唯一且合法
  const tail = crypto.randomBytes(3).toString('hex')
  const head = ascii.replace(/[^a-z0-9]/g, '').slice(0, 8) || fallback
  return (head + '-' + tail).slice(0, 32)
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/**
 * 校验并归一化一个租户定义。
 *
 * 语义与插件其它配置一致：**格式非法**报错（id 不合法、端口越界、home 不是绝对路径……），
 * "还没配好"（例如端口留空让系统分配）不算非法。
 *
 * @param {unknown} raw
 * @param {object} [options]
 * @param {string} [options.baseDir] 相对 home 的解析基准（默认 `~/DSH-tenants`）
 * @param {number} [options.port] 已是该租户占用的端口时允许重复（更新场景）
 * @returns {{ problems: string[], tenant: object }}
 */
export function normalizeTenant(raw, options = {}) {
  const input = asRecord(raw)
  const problems = []
  const baseDir = options.baseDir ?? defaultTenantBaseDir()

  const id = asString(input.id).trim()
  if (!TENANT_ID_PATTERN.test(id)) {
    problems.push('租户 id 必须是 2–32 位小写字母/数字/连字符：' + JSON.stringify(id))
  }

  const accessKey = asString(input.accessKey).trim()
  if (!ACCESS_KEY_PATTERN.test(accessKey)) {
    problems.push('租户 ' + (id || '?') + ' 的 accessKey 需为 16–128 位 URL 安全字符（[A-Za-z0-9_-]）')
  }

  const rawHome = asString(input.home).trim()
  const home = rawHome === '' ? path.join(baseDir, id || 'tenant') : path.resolve(rawHome.replace(/^~(?=\/|$)/, os.homedir()))
  if (!path.isAbsolute(home)) problems.push('租户 ' + (id || '?') + ' 的 home 必须是绝对路径')

  const profileRaw = asString(input.profile).trim()
  const profile = profileRaw === '' ? id : profileRaw
  if (!TENANT_ID_PATTERN.test(profile)) {
    problems.push('租户 ' + (id || '?') + ' 的 profile 名不合法（同 id 规则）：' + JSON.stringify(profile))
  }

  const portRaw = input.port === undefined || input.port === null || input.port === '' ? 0 : Number(input.port)
  if (!Number.isSafeInteger(portRaw) || portRaw < 0 || portRaw > 65535) {
    problems.push('租户 ' + (id || '?') + ' 的 port 必须是 0–65535（0 = 由系统分配）')
  }

  const name = asString(input.name).trim() || id
  const note = asString(input.note)

  return {
    problems,
    tenant: {
      id,
      name,
      accessKey,
      home,
      profile,
      port: Number.isSafeInteger(portRaw) ? portRaw : 0,
      // 默认自动拉起：多租户的意义就是"别人打开就能用"，不该还要房主手动开
      autostart: input.autostart !== false,
      enabled: input.enabled !== false,
      note,
      createdAt: asString(input.createdAt) || new Date().toISOString(),
    },
  }
}

/**
 * 租户注册表：一个 JSON 文件 + 内存缓存。
 *
 * @param {object} options
 * @param {string} options.file 注册表文件路径
 * @param {string} [options.baseDir] home 的默认父目录
 * @param {(line: string) => void} [options.log]
 * @param {object} [options.keyPool] 口令池（core/keypool.js）。给了它以后，这里发出的
 *        每一把密钥都必须在**全机**范围内没被用过（含本机访问口令与已退休的旧口令），
 *        而不只是"租户之间不重复"。没给就退化成旧行为（只在租户之间查重），便于单测。
 */
export function createRegistry(options) {
  const file = options.file
  const baseDir = options.baseDir ?? defaultTenantBaseDir()
  const log = options.log ?? (() => {})
  const keyPool = options.keyPool ?? null
  /** @type {Map<string, object>} */
  const tenants = new Map()

  function load() {
    tenants.clear()
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') log('租户注册表读取失败：' + String(error?.message ?? error))
      return { loaded: 0, dropped: [] }
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      log('租户注册表不是合法 JSON，已忽略：' + String(error?.message ?? error))
      return { loaded: 0, dropped: [] }
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tenants) ? parsed.tenants : []
    const dropped = []
    for (const item of list) {
      const { problems, tenant } = normalizeTenant(item, { baseDir })
      if (problems.length > 0) {
        dropped.push({ id: asString(asRecord(item).id, '?'), problems })
        continue
      }
      if (tenants.has(tenant.id)) {
        dropped.push({ id: tenant.id, problems: ['重复的 id，只保留第一条'] })
        continue
      }
      tenants.set(tenant.id, tenant)
    }
    if (dropped.length > 0) {
      log('租户注册表有 ' + String(dropped.length) + ' 条被忽略：' + dropped.map((d) => d.id + '（' + d.problems.join('；') + '）').join('，'))
    }
    return { loaded: tenants.size, dropped }
  }

  function persist() {
    const list = [...tenants.values()]
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = file + '.tmp-' + String(process.pid)
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tenants: list }, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
    return list
  }

  function list() {
    return [...tenants.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  function get(id) {
    return tenants.get(String(id)) ?? null
  }

  function findByKey(key) {
    if (typeof key !== 'string' || key === '') return null
    for (const tenant of tenants.values()) {
      if (tenant.accessKey.length === key.length && crypto.timingSafeEqual(Buffer.from(tenant.accessKey), Buffer.from(key))) {
        return tenant
      }
    }
    return null
  }

  /** 取一把新的访问密钥：有口令池就保证"全机没被用过"，没有就退化成纯随机。 */
  function nextKeyValue() {
    return keyPool === null ? generateAccessKey() : keyPool.issue().value
  }

  function add(raw) {
    // 没给密钥就自动生成：调用方（CLI / 面板 / 组合）不该为了拿一个密钥去拼 crypto
    const input = asRecord(raw)
    const candidate = asString(input.accessKey).trim() === '' ? { ...input, accessKey: nextKeyValue() } : input
    const { problems, tenant } = normalizeTenant(candidate, { baseDir })
    if (problems.length > 0) {
      const error = new Error(problems.join('；'))
      error.problems = problems
      throw error
    }
    if (tenants.has(tenant.id)) {
      const error = new Error('租户 ' + tenant.id + ' 已存在')
      error.problems = [error.message]
      throw error
    }
    // 密钥必须唯一：否则两个租户会互相串门
    if (findByKey(tenant.accessKey) !== null) {
      const error = new Error('该访问密钥已被别的租户占用')
      error.problems = [error.message]
      throw error
    }
    // 全机唯一：同一把口令不许既是本机口令又是某个人的口令，也不许复用任何用过的旧值
    if (keyPool !== null && keyPool.isTaken(tenant.accessKey)) {
      const error = new Error('这个口令已经被占用（本机不允许两处使用同一把口令，也不许复用旧口令），请换一个')
      error.problems = [error.message]
      throw error
    }
    tenants.set(tenant.id, tenant)
    persist()
    if (keyPool !== null) keyPool.remember(tenant.accessKey)
    return tenant
  }

  function update(id, patch) {
    const current = get(id)
    if (current === null) throw new Error('租户不存在：' + String(id))
    const { problems, tenant } = normalizeTenant({ ...current, ...asRecord(patch), id: current.id }, { baseDir })
    if (problems.length > 0) {
      const error = new Error(problems.join('；'))
      error.problems = problems
      throw error
    }
    const clash = findByKey(tenant.accessKey)
    if (clash !== null && clash.id !== current.id) throw new Error('该访问密钥已被别的租户占用')
    // 只在"真的换了密钥"时查口令池：更新备注/端口时不该因为自己那把已经在池子里而被拒
    const keyChanged = tenant.accessKey !== current.accessKey
    if (keyChanged && keyPool !== null && keyPool.isTaken(tenant.accessKey)) {
      throw new Error('这个口令已经被占用（本机不允许两处使用同一把口令，也不许复用旧口令）')
    }
    tenants.set(tenant.id, tenant)
    persist()
    if (keyChanged && keyPool !== null) keyPool.remember(tenant.accessKey)
    return tenant
  }

  function remove(id) {
    const current = get(id)
    if (current === null) return null
    tenants.delete(id)
    persist()
    return current
  }

  /**
   * 换一把访问密钥（旧链接与旧 Cookie 立刻失效）。
   * 旧值会被记进口令池退休区：它**不能**再被发给任何人（否则两个人拿到同一把口令）。
   */
  function rotateKey(id) {
    const current = get(id)
    if (current === null) throw new Error('租户不存在：' + String(id))
    const tenant = update(id, { accessKey: nextKeyValue() })
    if (keyPool !== null) keyPool.remember(current.accessKey)
    return tenant
  }

  return {
    file,
    baseDir,
    load,
    list,
    get,
    findByKey,
    add,
    update,
    remove,
    rotateKey,
    /** 仅测试/排障用：直接看内存里的原始映射。 */
    size: () => tenants.size,
  }
}
