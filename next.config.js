const { version } = require('./package.json')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: 'build',
  // Self-contained server for the Docker image; `next start` (App Engine) still works.
  output: 'standalone',
  // Shown in the page footer. GIT_SHA is passed as a build arg by the image workflow.
  env: {
    NEXT_PUBLIC_APP_VERSION: `${version}+${(process.env.GIT_SHA || 'dev').slice(0, 7)}`,
  },
}

module.exports = nextConfig
