/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: 'build',
  // Self-contained server for the Docker image; `next start` (App Engine) still works.
  output: 'standalone',
}

module.exports = nextConfig
