// safe-store.ts
// hb10-CFG-V01 + hb12-SMG-01（合并面）：electron-store 裸构造的公共 helper。
// 病根：config-manager 与 workspace-history 两处 getStore 同构裸构造——坏 JSON 抛错后
// 一处启动初始化链全跳（进程不死但 resetRunningTasks/附件清理/detectCli 全跳过，store 恒
// null 后续 getConfig 继续抛）、一处选目录全链 reject。
// 修法：try 构造 + 坏文件 renameSync 为 <name>.json.corrupt-<ts>.bak 物证 + 重建空 store +
// logger.error 留证。目录不可写等非 SyntaxError 异常按原抛错路径降级（不吞）。

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { logger } from './logger';

/** 带坏文件自愈的 electron-store 构造。坏 JSON：rename 留证后重建；其余异常原样抛出。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSafeStore<T>(options: { name: string; defaults: any }): T {
  const ElectronStoreModule = require('electron-store');
  const ElectronStore =
    (ElectronStoreModule as unknown as { default?: unknown }).default ?? ElectronStoreModule;
  const Ctor = ElectronStore as unknown as new (opts: unknown) => T;
  try {
    return new Ctor({
      name: options.name,
      projectName: app.getName(),
      defaults: options.defaults,
    });
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // 坏 JSON：把原文件挪走留证（.corrupt-<ts>.bak），再重建空 store。
    const file = path.join(app.getPath('userData'), `${options.name}.json`);
    try {
      const backup = `${file}.corrupt-${Date.now()}.bak`;
      fs.renameSync(file, backup);
      logger.error(`[safe-store] 配置文件损坏，已备份为 ${backup} 并重建空 store：${err.message}`);
    } catch (renameErr) {
      logger.error(`[safe-store] 配置文件损坏且备份失败：${renameErr instanceof Error ? renameErr.message : String(renameErr)}`);
    }
    return new Ctor({
      name: options.name,
      projectName: app.getName(),
      defaults: options.defaults,
    });
  }
}
