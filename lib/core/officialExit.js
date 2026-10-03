/**
 * 官方共享出口（默认出口）—— 全仓库**唯一**允许出现真实出口地址的地方。
 *
 * 为什么它可以写进公开仓库：产品定位是「装完即用」，默认出口是**公开的产品端点**，
 * 性质同 ngrok.com / trycloudflare.com —— 不是私有值。所以
 * test/no-private-values.sh 对 `dsh.lycheeledger.cn` 这一个子域单独放行；
 * 服务器 IP、私钥、本机绝对路径仍然一律禁止。
 *
 * ⚠️ 默认 = 官方出口，但它只是「不填时的默认值」，不是唯一入口。换出口有两条路，
 * 都不需要改代码：
 *   CLI/插件： --relay https://your-exit.example.com
 *   配置文件： public.relay.url: https://your-exit.example.com
 * 面板上会同时标出「官方 / 自定义」，用户始终看得见自己连的是谁。
 */
export const OFFICIAL_EXIT_URL = 'https://relay.dsh.lycheeledger.cn'

/**
 * 把用户给的出口写法归一成基址（无结尾斜杠）。
 * 空 / `official` / `default` 一律解析成官方出口 —— 这样 CLI 的
 * `--relay`（不带值）和配置里的空 url 都自动落到官方出口。
 */
export function resolveRelayUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  const lowered = value.toLowerCase()
  if (value === '' || lowered === 'official' || lowered === 'default') return OFFICIAL_EXIT_URL
  return value.replace(/\/+$/, '')
}

/** 这个地址是不是官方出口（结尾斜杠不影响判断）。 */
export function isOfficialExit(url) {
  return typeof url === 'string' && url.replace(/\/+$/, '') === OFFICIAL_EXIT_URL
}
