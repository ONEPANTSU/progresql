/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  distDir: '../app',
  assetPrefix: './',
  reactStrictMode: true,
  swcMinify: true,
  experimental: {
    esmExternals: false,
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;
