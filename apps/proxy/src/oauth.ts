/**
 * oauth.ts — OAuth 内存态中转（M3 里程碑）。
 *
 * 占位：M3 实现 native PKCE（/auth/native/{authorize,token,refresh} 中转 +
 * httpOnly cookie 存 token set，进程内存态、重启即失效）。本文件 M2 不参与构建。
 */
export const OAUTH_STATUS = 'm3-placeholder' as const
