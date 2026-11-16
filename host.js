// 仅用于让本包以“包名”出现在组合树里。
// DSH 的浏览器 roster（dsh.client 客户端半边）按包名挂载：如果组合树里只有
// `dsh-context-kit/tuner` 这样的子路径入口，客户端面板不会被加载。
// 真正的宿主逻辑在 ./tuner.js（压缩阈值调优）；工具治理与上下文索引已迁到 dsh-token-trim。
export const name = 'dsh-context-kit'
export const inject = []

export function apply() {}
