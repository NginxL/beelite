// 应用身份：生产包的 productName 为 BeeLite；测试包使用其他 productName（例如 BeeLite E2E），
// 其 userData 与 Sparkle 偏好随 productName / appId 自然隔离，不依赖环境变量（Sparkle 重启不会继承环境变量）。
// 0.1.7 起用户看到的品牌是「艾泽魔方 · AzerCube」；productName、appId、应用文件名与数据目录仍沿用 BeeLite，
// 这样已安装用户的设置、绑定与客户端更新信任链不需要迁移。

export const PRODUCTION_PRODUCT_NAME = 'BeeLite';

/** 用户可见的品牌名 */
export const BRAND_NAME = '艾泽魔方';
export const BRAND_NAME_EN = 'AzerCube';

/** 窗口、菜单、关于面板等处显示的应用名；测试包带上自己的 productName，与生产包可以区分 */
export function displayName(productName: string): string {
  return productName === PRODUCTION_PRODUCT_NAME ? `${BRAND_NAME} · ${BRAND_NAME_EN}` : `${BRAND_NAME} ${productName}`;
}

/**
 * 计算并固定 userData：在修改显示名之前取得默认路径（由 productName 决定），
 * 显式设置 BEELITE_USER_DATA_DIR 时（仅开发/测试）改用该目录。
 */
export function resolveUserData(defaultPath: string, override: string | undefined, resolve: (p: string) => string): string {
  return override ? resolve(override) : defaultPath;
}
