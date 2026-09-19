/**
 * 边缘凭证（Basic Auth 用户名 / 口令）的生成与设置指引。
 *
 * 为什么单独一个模块：这是公网入口**唯一一道**挡在你机器前面的门，
 * 而它偏偏最容易做错 —— 让用户"自己想一个强口令"，结果通常是 `dsh123456`。
 * 这里生成的是一句**能在手机上输进去**的短语，并直接把"在服务器上设置它"的命令一起给出来。
 *
 * 不做口令哈希：服务器侧用 `htpasswd` / `openssl passwd -apr1` 生成即可，
 * 插件不需要（也不应该）自创一套哈希格式。
 *
 * @module dsh-plugin-remote-connect-beta/core/credential
 */
import crypto from 'node:crypto'

/**
 * 词表：全小写 ASCII、4–7 字母、彼此不易听错/看错（刻意避开易混的写法）。
 * 64 个词 → 每词 6 bit。
 */
export const WORDS = [
  'amber', 'apple', 'arrow', 'bamboo', 'banjo', 'beach', 'berry', 'birch',
  'bison', 'bloom', 'brook', 'cabin', 'cactus', 'camel', 'candy', 'cedar',
  'chalk', 'chess', 'cider', 'cloud', 'cobalt', 'comet', 'coral', 'crane',
  'delta', 'denim', 'drift', 'dune', 'eagle', 'ember', 'fable', 'fabric',
  'fang', 'fern', 'flint', 'frost', 'ginger', 'glacier', 'grape', 'grove',
  'harbor', 'honey', 'ivory', 'jade', 'juniper', 'kettle', 'lantern', 'lemon',
  'lilac', 'mango', 'maple', 'marble', 'meadow', 'melon', 'mint', 'nectar',
  'oasis', 'olive', 'onyx', 'orbit', 'pebble', 'pepper', 'pilot', 'quartz',
]

/** 默认词数：64^6 ≈ 6.9e10（约 36 bit），再加 3 位数字 ≈ 46 bit 的在线口令强度。 */
export const DEFAULT_WORDS = 6

/** 从随机源取一个 32 位无符号整数。 */
function randomUint32(randomBytes) {
  const bytes = randomBytes(4)
  return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
}

/** 无偏取的 [0, max) 随机整数（拒绝采样；max 可以大于 256）。 */
function randomInt(max, randomBytes) {
  const limit = Math.floor(0x100000000 / max) * max
  for (;;) {
    const value = randomUint32(randomBytes)
    if (value < limit) return value % max
  }
}

/**
 * 生成一句好输入的口令：`cobalt-cabin-drift-jade-maple-mint-482`。
 * @param {object} [options]
 * @param {number} [options.words=6] 词数（4–10）
 * @param {number} [options.digits=3] 末尾数字位数（0–6）
 * @param {(size: number) => Buffer} [options.randomBytes] 测试用的确定性随机源
 * @returns {{ password: string, bits: number, words: number }}
 */
export function generatePassphrase(options = {}) {
  const randomBytes = options.randomBytes ?? ((size) => crypto.randomBytes(size))
  const words = Math.min(Math.max(Number(options.words ?? DEFAULT_WORDS), 4), 10)
  const digits = Math.min(Math.max(Number(options.digits ?? 3), 0), 6)
  const picked = []
  for (let index = 0; index < words; index += 1) picked.push(WORDS[randomInt(WORDS.length, randomBytes)])
  const tail = digits === 0 ? '' : '-' + String(randomInt(10 ** digits, randomBytes)).padStart(digits, '0')
  const bits = Math.round(words * Math.log2(WORDS.length) + digits * Math.log2(10))
  return { password: picked.join('-') + tail, bits, words }
}

/**
 * 纯随机口令（不强求好输入，追求强度）：默认 24 位 URL 安全字符 ≈ 143 bit。
 * @param {object} [options]
 * @param {number} [options.length=24]
 * @param {(size: number) => Buffer} [options.randomBytes]
 */
export function generateRandomPassword(options = {}) {
  const randomBytes = options.randomBytes ?? ((size) => crypto.randomBytes(size))
  const length = Math.min(Math.max(Number(options.length ?? 24), 16), 128)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_'
  const bytes = randomBytes(length * 2)
  let out = ''
  for (let index = 0; index < bytes.length && out.length < length; index += 1) {
    const value = bytes[index]
    if (value < 256 - (256 % alphabet.length)) out += alphabet[value % alphabet.length]
  }
  return { password: out, bits: Math.round(out.length * Math.log2(alphabet.length)), words: 0 }
}

/**
 * 在服务器上设置这条口令的命令（用户直接粘贴执行）。
 *
 * 口令通过 **stdin** 传给 htpasswd（`-i`），不出现在命令行参数里 ——
 * 也就不会进 `ps` 与 shell history。
 *
 * @param {object} options
 * @param {string} [options.user='dsh']
 * @param {string} [options.authFile='/etc/nginx/.htpasswd-dsh']
 * @param {string} options.password
 */
export function setupCommands(options) {
  const user = options.user ?? 'dsh'
  const authFile = options.authFile ?? '/etc/nginx/.htpasswd-dsh'
  const quoted = JSON.stringify(options.password)
  return {
    // -i 从 stdin 读口令（不进 argv/history）；-B 用 bcrypt（默认的 $apr1$ 太弱）；
    // 不加 -c：-c 是"重建文件"，会把里面别的用户清掉
    htpasswd: [
      'printf %s ' + quoted + ' | sudo htpasswd -i -B ' + authFile + ' ' + user,
      'sudo chmod 640 ' + authFile,
      '(sudo chown root:www-data ' + authFile + ' 2>/dev/null || true)',
    ].join(' && '),
    firstTime: [
      'printf %s ' + quoted + ' | sudo htpasswd -i -B -c ' + authFile + ' ' + user,
      'sudo chmod 640 ' + authFile,
    ].join(' && '),
    openssl: [
      '# openssl 只能做 $apr1$（比 bcrypt 弱）；能用 htpasswd -B 就别用这条',
      'HASH=$(printf %s ' + quoted + ' | openssl passwd -apr1 -stdin)',
      "printf '%s:%s\\n' " + JSON.stringify(user) + ' "$HASH" | sudo tee ' + authFile + ' >/dev/null',
      'sudo chmod 640 ' + authFile,
      'sudo nginx -t && sudo systemctl reload nginx',
    ].join(' && '),
    verify: "curl -sS -o /dev/null -w '%{http_code}\\n' https://<域名>/   # 期望 401",
    rotateNote: '改完不用 reload（nginx 每个请求都重读该文件），秒级生效',
  }
}
