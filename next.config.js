const { version: packageVersion } = require('./package.json')

// A release build (tag vX.Y.Z) shows X.Y.Z; any other build is marked as a dev build.
const release = (process.env.APP_VERSION || '').replace(/^v/, '')
const version = release || `${packageVersion}-dev`
const sha = (process.env.GIT_SHA || 'dev').slice(0, 7)

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: 'build',
  // Self-contained server for the Docker image; `next start` (App Engine) still works.
  output: 'standalone',
  // Shown in the page footer. APP_VERSION and GIT_SHA are build args set by the image workflow.
  env: {
    NEXT_PUBLIC_APP_VERSION: `${version} (${sha})`,
  },
}

module.exports = nextConfig
