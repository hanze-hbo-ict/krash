/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
  dependencies: Record<string, string>
}

/**
 * Restrictive Content Security Policy for the production build. Everything is
 * self-hosted; WebAssembly compilation needs 'wasm-unsafe-eval'; CodeMirror
 * injects <style> elements, hence 'unsafe-inline' for styles only.
 * Not applied in dev, where Vite injects inline scripts for HMR.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function cspPlugin(): Plugin {
  return {
    name: 'krash-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      )
    },
  }
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
}

export default defineConfig({
  base: './',
  // `vite preview` serves the build with the same headers as public/_headers,
  // so E2E tests also exercise the CSP inside the database worker.
  preview: { headers: SECURITY_HEADERS },
  plugins: [react(), cspPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  optimizeDeps: {
    // PGlite resolves its .wasm/.data files relative to its own module URL.
    exclude: ['@electric-sql/pglite'],
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
