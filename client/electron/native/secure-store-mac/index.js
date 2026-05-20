// 跨平台 entry。非 macOS 上不加载 native binary(node-gyp 在 OS!='mac' 时
// type:none 不出 .node 文件,require 会失败)。统一返回 isAvailable=false 的 stub。

'use strict';

if (process.platform !== 'darwin') {
  module.exports = {
    isAvailable: () => false,
    set: () => { throw new Error('secure-store-mac: not available on this platform'); },
    get: () => { throw new Error('secure-store-mac: not available on this platform'); },
    delete: () => { throw new Error('secure-store-mac: not available on this platform'); },
  };
} else {
  // build/Release/secure_store.node — node-gyp 默认输出位置
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  module.exports = require('./build/Release/secure_store.node');
}
