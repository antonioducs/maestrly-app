import { describe, expect, it } from 'vitest'
import {
  INITIAL_COMMIT_MAX_FILE_BYTES,
  isExcludedFromInitialCommit,
  isTooLargeForInitialCommit,
} from '../../src/main/project-setup/initial-commit-exclusions'

describe('initial commit exclusions', () => {
  it.each([
    'node_modules/pkg/index.js',
    'web/node_modules/pkg/index.js',
    '.venv/bin/python',
    'tools/venv/lib/site.py',
    'src/__pycache__/app.cpython-312.pyc',
    'Node_Modules/pkg/index.js',
    '.DS_Store',
    'docs/img/.DS_Store',
    'Thumbs.db',
    'docs/thumbs.db',
    '.env',
    'api/.env',
    '.ENV',
    '.env.local',
    '.env.production',
    '.env.example.bak',
    'config/.env.local.example',
    'cert.pem',
    'keys/server.KEY',
    'keys/bundle.p12',
    'keys/bundle.pfx',
    'id_rsa',
    'home/.ssh/id_rsa.pub',
    'id_ed25519',
    'home/.ssh/id_ed25519.pub',
  ])('leaves out %s', (file) => {
    expect(isExcludedFromInitialCommit(file)).toBe(true)
  })

  it.each([
    'app.py',
    'dados.txt',
    '.gitignore',
    '.env.example',
    '.env.sample',
    '.env.template',
    'api/.env.example',
    'api/.ENV.SAMPLE',
    'environment.md',
    'env/config.py',
    '.envrc',
    'keyboard.ts',
    'monkey.txt',
    'src/venv.ts',
    'src/node_modules.md',
    'docs/pem.md',
    'src/id_rsa_notes/readme.md',
    'sub/lib.py',
  ])('keeps %s', (file) => {
    expect(isExcludedFromInitialCommit(file)).toBe(false)
  })

  it('leaves out files of 50 MiB or more', () => {
    expect(INITIAL_COMMIT_MAX_FILE_BYTES).toBe(50 * 1024 * 1024)
    expect(isTooLargeForInitialCommit(0)).toBe(false)
    expect(isTooLargeForInitialCommit(INITIAL_COMMIT_MAX_FILE_BYTES - 1)).toBe(false)
    expect(isTooLargeForInitialCommit(INITIAL_COMMIT_MAX_FILE_BYTES)).toBe(true)
    expect(isTooLargeForInitialCommit(INITIAL_COMMIT_MAX_FILE_BYTES + 1)).toBe(true)
  })
})
