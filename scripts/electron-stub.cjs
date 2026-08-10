// electron-stub.cjs
// 仅测试用：在 tsx/纯 Node 环境下拦截 `require('electron')`。生产代码的 config-manager / paths
// value-import 了 electron 的 `app`/`safeStorage`/`Notification`，而 electron 包在非 Electron 进程里
// require 返回可执行路径字符串（app 为 undefined）。本 stub 提供这些 API 的最小实现，让
// runQuery seam 测试（review-v5 条件 3）能在 tsx 下驱动真实 runQuery/forwardEvent/DB。
//
// 安装方式：测试脚本顶部用 Module._resolveFilename hook 把 'electron' resolve 到本文件，且必须在
// require 任何主进程模块之前完成。userData 由 CLAUDE_LINK_TEST_USERDATA 环境变量指定（临时目录）。
const path = require('path');

function userData() {
  const dir = process.env.CLAUDE_LINK_TEST_USERDATA;
  if (!dir) throw new Error('electron-stub: CLAUDE_LINK_TEST_USERDATA 未设置');
  return dir;
}

class FakeNotification {
  static isSupported() {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  show() {}
}

module.exports = {
  app: {
    // 所有 getPath('xxx') 统一返回临时 userData（测试只需一个可写目录）。
    getPath: () => userData(),
    getName: () => 'claude-link-test',
    setAppUserModelId: () => {},
    isReady: () => true,
    on: () => {},
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
  Notification: FakeNotification,
};
