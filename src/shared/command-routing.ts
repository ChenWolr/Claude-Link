// command-routing.ts
// 纯函数：识别 / 匹配 / 过滤 slash 命令，供 ChatInput 菜单与会话级路由共用。
//
// 铁训不变量：本模块只用于「识别 / 匹配 / 菜单」，绝不充当发送白名单——
// 用户手写的未知 /unknown 仍是 slash candidate，由现有 CHAT_SEND 原样发送（计划 §0.2-7、Task 7）。
// parseSlashInvocation 不 trim、不重建 rawText：原样发送铁训要求参数/空格/中文/引号/换行不被改写。

import type { SdkCommand } from './types/command';

/** 路由分类结果：slash 调用候选，或普通自然语言 prompt。 */
export type SlashInvocation =
  | { kind: 'slash'; commandName: string; rawText: string; argumentsText: string }
  | { kind: 'prompt'; rawText: string };

/**
 * 识别输入是否形如 `/name ...`。
 *
 * - 只看首个非空白字符是否为 '/'；普通文本中间的 '/' 一律视为 prompt（不触发命令逻辑）。
 * - 不 trim、不重建 rawText（原样返回，供发送链路保留）。
 * - commandName 去掉前导 '/' 后原样保留大小写（canonical 展示不强制小写）；纯 '/' 时 commandName 为空（菜单触发）。
 * - argumentsText 为 commandName token 之后的内容，仅去掉紧随的一个分隔空白，保留参数内部所有空白/引号/中文。
 * - 未知命令同样归为 slash（kind 不携带「拒绝发送」信号）。
 */
export function parseSlashInvocation(text: string): SlashInvocation {
  const rawText = text;
  const start = text.search(/\S/);
  if (start === -1) return { kind: 'prompt', rawText };
  if (text[start] !== '/') return { kind: 'prompt', rawText };

  // 从首个非空白字符起取 token：'/' + 紧跟的非空白序列（即命令名，可为空）。
  const restFromStart = text.slice(start);
  const m = restFromStart.match(/^(\S)([^\s]*)/);
  const commandName = m ? m[2] : '';
  const tokenEnd = start + 1 + commandName.length; // '/' 占 1 + name 长度
  const argumentsText = text.slice(tokenEnd).replace(/^\s/, '');
  return { kind: 'slash', commandName, rawText, argumentsText };
}

/**
 * 按 canonical name 或 alias 匹配命令，大小写不敏感。
 * 用于「用户手写 alias / canonical 时找到对应命令」与菜单高亮；找不到返回 undefined（不抛错）。
 */
export function findCommandByAlias(commands: readonly SdkCommand[], token: string): SdkCommand | undefined {
  if (!token) return undefined;
  const needle = token.toLowerCase();
  for (const c of commands) {
    if (typeof c.name === 'string' && c.name.toLowerCase() === needle) return c;
    if (Array.isArray(c.aliases) && c.aliases.some((a) => typeof a === 'string' && a.toLowerCase() === needle)) return c;
  }
  return undefined;
}

/**
 * 过滤出可渲染进 `/` 菜单的命令：name 非空、source==='sdk'、availability==='available'——removed/internal（hidden）与来源未知（unknown）均不展示。
 * 只决定菜单数据边界，不把隐藏命令从 SDK 执行能力中伪造删除（Task 2）。
 */
export function filterRenderableCommands(commands: readonly SdkCommand[]): SdkCommand[] {
  return commands.filter(
    (c): c is SdkCommand =>
      !!c &&
      typeof c.name === 'string' &&
      c.name.length > 0 &&
      c.source === 'sdk' &&
      c.availability === 'available',
  );
}
