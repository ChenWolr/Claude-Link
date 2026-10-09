// src/shared/build-info.ts
// 构建指纹（electron.vite.config.ts define 注入）。typeof 守卫防未注入时 ReferenceError；
// dev 与 build 均生效（electron-vite dev 同样走 define）。
declare const __CL_BUILD_REV__: string | undefined;
declare const __CL_BUILD_TIME__: string | undefined;

export const BUILD_REV: string = typeof __CL_BUILD_REV__ === 'string' ? __CL_BUILD_REV__ : 'unknown';
export const BUILD_TIME: string = typeof __CL_BUILD_TIME__ === 'string' ? __CL_BUILD_TIME__ : '';
