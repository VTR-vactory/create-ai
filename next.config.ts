import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  logging: {
    serverFunctions: true, // 开发时显示 Server Action 调用详情
    browserToTerminal: true, // 浏览器 console.log 转发到终端
  },
};

export default nextConfig;
