/**
 * 口令池：一个插件实例内**唯一**的口令命名空间。
 *
 * 为什么要有它：这台机器上会有不止一把口令 —— 本机访问口令 + 每个租户各一把。它们
 * 是**身份**，不是名字，所以必须满足两条不变量：
 *
 *   1. **任意两把口令都不相同**（活跃的也好，以前用过又换掉的也好）。否则"以为换了
 *      其实没换"，或者两个人的口令撞在一起，一个人就能当另一个人用。
 *   2. **一把口令只属于一个上游**（本机 Harness，或某个租户自己的 Harness）。这是
 *      core/proxy.js 里"按口令解析出唯一上游"的地基；撞了口令这条路由就不再是单值映射。
 *
 * 实现上"查重"只比**指纹**（sha256 前 16 位），不存明文 —— 这个文件是可以被看见的，
 * 里面不该出现任何一把还能用的口令。历史是有上限的（默认 500 条，先进先出），所以
 * 这不是"永不忘却"，而是"近期不再复用"；真正的保证来自：活跃口令永远在池子里。
 *
 * 没有 file 时退化成纯内存池（测试与一次性 CLI 用），语义相同。
 *
 * @module dsh-plugin-remote-connect-beta/core/keypool
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { generateAccessKey } from './tenant.js'

/** 指纹长度（十六进制字符数）。够长到不会误撞，又短到可以贴进 issue/日志里说事。 */
export const FINGERPRINT_LENGTH = 16

/** 口令指纹：只用于查重与排障，**不可**反推出明文。 */
export function fingerprintKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, FINGERPRINT_LENGTH)
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/**
 * @param {object} [options]
 * @param {string} [options.file] 持久化文件（`keys-used.json`，0600）；省略则纯内存
 * @param {number} [options.cap=500] 历史保留条数（先进先出）
 * @param {(line: string) => void} [options.log]
 * @param {() => string} [options.generate] 口令生成器（默认 32 位 base64url ≈ 192 bit）
 * @param {() => string[]} [options.reserved] 当前**活跃**口令（本机口令 + 各租户口令）；
 *        由调用方惰性提供，避免和注册表/状态文件形成初始化环
 */
export function createKeyPool(options = {}) {
  const file = asString(options.file) === '' ? null : asString(options.file)
  const cap = Number.isSafeInteger(options.cap) && options.cap > 0 ? options.cap : 500
  const log = options.log ?? (() => {})
  const generate = typeof options.generate === 'function' ? options.generate : () => generateAccessKey()
  const reserved = typeof options.reserved === 'function' ? options.reserved : () => []

  /** 用过的口令指纹（含活跃与已退休）。Set 保持插入顺序，便于按 cap 裁掉最旧的。 */
  const used = new Set()
  /** 生成器连续撞车的上限：撞这么多次说明随机源或 cap 设置有问题，宁可报错也别死循环。 */
  const MAX_TRIES = 32

  function load() {
    if (file === null) return { loaded: 0 }
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') log('口令池读取失败（当作空池继续）：' + String(error?.message ?? error))
      return { loaded: 0 }
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      log('口令池不是合法 JSON（当作空池继续）：' + String(error?.message ?? error))
      return { loaded: 0 }
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.fingerprints) ? parsed.fingerprints : []
    let skipped = 0
    for (const item of list) {
      // 只收指纹：长度不对的条目（人为编辑过、或别的版本写的）直接跳过，不猜测
      if (typeof item !== 'string' || !new RegExp('^[0-9a-f]{' + String(FINGERPRINT_LENGTH) + '}$').test(item)) {
        skipped += 1
        continue
      }
      used.add(item)
    }
    if (skipped > 0) log('口令池里有 ' + String(skipped) + ' 条非法指纹被跳过')
    return { loaded: used.size }
  }

  function persist() {
    if (file === null) return
    const list = [...used].slice(-cap)
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = file + '.tmp-' + String(process.pid)
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), fingerprints: list }, null, 2) + '\n',
      { mode: 0o600 },
    )
    fs.renameSync(tmp, file)
  }

  /** 这个口令还能不能发出去？（历史里没有，且不等于任何活跃口令） */
  function isTaken(value) {
    const text = asString(value)
    if (text === '') return false
    if (used.has(fingerprintKey(text))) return true
    for (const active of reserved()) {
      const other = asString(active)
      if (other.length !== text.length) continue
      if (crypto.timingSafeEqual(Buffer.from(other), Buffer.from(text))) return true
    }
    return false
  }

  /** 把一个口令记进池子（发出去的那一刻就该记：活跃 = 已占用）。 */
  function remember(value) {
    const text = asString(value)
    if (text === '') return null
    const fp = fingerprintKey(text)
    const grew = !used.has(fp)
    used.add(fp)
    if (grew) persist()
    return fp
  }

  /**
   * 直接收养一批**指纹**（不是明文）：给"从旧状态文件迁移过来"的场景用。
   * 每个都要是 16 位十六进制，非法项直接丢掉 —— 宁可少查重，也不要把脏数据当指纹。
   * @param {string[]} fingerprints
   */
  function adopt(fingerprints) {
    if (!Array.isArray(fingerprints)) return 0
    const pattern = new RegExp('^[0-9a-f]{' + String(FINGERPRINT_LENGTH) + '}$')
    let added = 0
    for (const item of fingerprints) {
      if (typeof item !== 'string' || !pattern.test(item) || used.has(item)) continue
      used.add(item)
      added += 1
    }
    if (added > 0) persist()
    return added
  }

  /**
   * 取一把**全新**口令：与历史、与所有活跃口令都不同。
   * 注意它只是"生成"，不写入池子 —— 调用方在真正落地（写注册表/状态文件）之后再
   * `remember()`，这样"生成后失败"不会白白占用一个指纹。
   * @returns {{ value: string, fingerprint: string, tries: number }}
   */
  function issue() {
    for (let tries = 1; tries <= MAX_TRIES; tries += 1) {
      const value = asString(generate())
      if (value !== '' && !isTaken(value)) return { value, fingerprint: fingerprintKey(value), tries }
    }
    throw new Error(
      '连续生成 ' + String(MAX_TRIES) + ' 把口令都撞上了已用过的值，已放弃 —— 请检查随机源，或把 keys-used.json 归档后再试',
    )
  }

  load()

  return {
    file,
    cap,
    issue,
    isTaken,
    remember,
    adopt,
    /** 只读快照：排障用，元素是**指纹**。 */
    fingerprints: () => [...used],
    size: () => used.size,
  }
}
