#!/usr/bin/env node

import * as esbuild from 'esbuild'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdir } from 'fs/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const testSrcDir = join(__dirname, '../src')
const outputDir = join(__dirname, '../src/build')

await mkdir(outputDir, { recursive: true })

const modules = [
  {
    name: 'test-shim',
    input: join(testSrcDir, 'test-shim.mts'),
    output: join(outputDir, 'test-shim.bundle.js'),
  },
]

try {
  for (const module of modules) {
    await esbuild.build({
      entryPoints: [module.input],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2021',
      outfile: module.output,
      sourcemap: true,
      resolveExtensions: ['.mts', '.ts', '.js', '.mjs'],
      mainFields: ['module', 'main'],
      conditions: ['import', 'module', 'default'],
      define: {
        'chrome': 'globalThis.chrome',
      },
    })

    console.log(`✅ ${module.name} bundle created: ${module.output}`)
  }

  console.log('\n✅ All bundles created successfully')
  console.log('   You can now run: npm test')
} catch (error) {
  console.error('❌ Build failed:', error)
  process.exit(1)
}
