// 应用身份：生产包的 productName 为 BeeLite；测试包使用其他 productName（例如 BeeLite E2E），
// 其 userData 与 Sparkle 偏好随 productName / appId 自然隔离，不依赖环境变量（Sparkle 重启不会继承环境变量）。

export const PRODUCTION_PRODUCT_NAME = 'BeeLite';

/** 窗口、菜单等处显示的应用名 */
export function displayName(productName: string): string {
  return productName === PRODUCTION_PRODUCT_NAME ? '蜂简 BeeLite' : `蜂简 ${productName}`;
}

/**
 * 计算并固定 userData：在修改显示名之前取得默认路径（由 productName 决定），
 * 显式设置 BEELITE_USER_DATA_DIR 时（仅开发/测试）改用该目录。
 */
export function resolveUserData(defaultPath: string, override: string | undefined, resolve: (p: string) => string): string {
  return override ? resolve(override) : defaultPath;
}
