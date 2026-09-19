# Homebrew formula 模板（给愿意做 tap 的人）
#
# 用法：
#   1. npm publish 后，从 `npm pack` 或 registry 拿到 tarball 的 sha256：
#        curl -sL https://registry.npmjs.org/dsh-plugin-remote-connect/-/dsh-plugin-remote-connect-0.1.0.tgz | shasum -a 256
#   2. 把下面的 <owner> 与 <sha256> 换成实际值（version 同步改）
#   3. 放进你自己的 homebrew tap 仓库：Formula/dsh-remote.rb，然后 `brew install <owner>/tap/dsh-remote`
class DshRemote < Formula
  desc "Remote entry for DSH Harness: LAN/public reverse proxy, tunnel supervision, doctor"
  homepage "https://github.com/<owner>/dsh-plugin-remote-connect"
  url "https://registry.npmjs.org/dsh-plugin-remote-connect/-/dsh-plugin-remote-connect-0.1.0.tgz"
  sha256 "<sha256>"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "dsh-remote", shell_output("#{bin}/dsh-remote help")
  end
end
