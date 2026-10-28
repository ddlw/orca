import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'
import { STAGED_FILE_SAVE_LIMITS } from '../../../shared/staged-file-save'
import { StagedFileSaves } from './staged-file-saves'

const CHUNK = 384 * 1024

let root: string
let journal: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-staged-save-'))
  journal = join(root, 'journal.json')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const saves = (limits: Partial<typeof STAGED_FILE_SAVE_LIMITS> = {}) =>
  new StagedFileSaves({
    journalPath: () => journal,
    limits: { ...STAGED_FILE_SAVE_LIMITS, ...limits }
  })

async function send(staged: StagedFileSaves, owner: string, saveId: string, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    await staged.append(owner, saveId, offset, bytes.subarray(offset, offset + CHUNK))
  }
}

const temps = () => readdirSync(root).filter((name) => name.includes('.orca-save-'))

// E7: a 5 MB lockfile opened from a remote host could be edited but not saved (720 KB cap).
describe('a staged save', () => {
  const lockfile = '"node_modules/pkg": { "version": "1.0.0" },\n'.repeat(120_000)

  it('round-trips a 5 MB file through a temp beside it, leaving no temp or journal', async () => {
    const target = join(root, 'package-lock.json')
    writeFileSync(target, 'old\n')
    chmodSync(target, 0o640)
    const staged = saves()
    const bytes = Buffer.from(lockfile)
    const { saveId } = await staged.begin('conn-1', target, bytes.length)
    expect(temps()).toHaveLength(1)
    expect(existsSync(journal)).toBe(true)

    await send(staged, 'conn-1', saveId, bytes)
    await expect(
      staged.commit('conn-1', saveId, { expectedSignature: getDiskBaselineSignature('old\n') })
    ).resolves.toEqual({ ok: true })

    expect(readFileSync(target, 'utf8')).toBe(lockfile)
    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o777).toBe(0o640)
    }
    expect(temps()).toEqual([])
    expect(existsSync(journal)).toBe(false)
  })

  it('refuses the commit when the target changed meanwhile, and leaves it as it is', async () => {
    const target = join(root, 'package-lock.json')
    writeFileSync(target, 'old\n')
    const staged = saves()
    const { saveId } = await staged.begin('conn-1', target, 4)
    await staged.append('conn-1', saveId, 0, Buffer.from('new\n'))
    writeFileSync(target, 'someone else\n')

    await expect(
      staged.commit('conn-1', saveId, { expectedSignature: getDiskBaselineSignature('old\n') })
    ).resolves.toEqual({ ok: false, diskConflict: 'changed' })
    expect(readFileSync(target, 'utf8')).toBe('someone else\n')
    expect(temps()).toEqual([])
  })

  it('takes chunks only in order and within the declared size, and commits only when complete', async () => {
    const target = join(root, 'a.txt')
    const staged = saves()
    const { saveId } = await staged.begin('conn-1', target, 6)
    await expect(staged.append('conn-1', saveId, 3, Buffer.from('abc'))).rejects.toThrow(
      'staged_save_out_of_order'
    )
    await staged.append('conn-1', saveId, 0, Buffer.from('abc'))
    await expect(staged.append('conn-1', saveId, 0, Buffer.from('abc'))).rejects.toThrow(
      'staged_save_out_of_order'
    )
    await expect(staged.append('conn-1', saveId, 3, Buffer.from('defg'))).rejects.toThrow(
      'staged_save_out_of_order'
    )
    await expect(staged.commit('conn-1', saveId, undefined)).rejects.toThrow(
      'staged_save_incomplete'
    )
    expect(existsSync(target)).toBe(false)
  })

  it('never lets another connection continue or commit a save', async () => {
    const staged = saves()
    const { saveId } = await staged.begin('conn-1', join(root, 'a.txt'), 3)
    await expect(staged.append('conn-2', saveId, 0, Buffer.from('abc'))).rejects.toThrow(
      'staged_save_unknown'
    )
    await expect(staged.commit('conn-2', saveId, undefined)).rejects.toThrow('staged_save_unknown')
    await staged.abort('conn-2', saveId)
    expect(temps()).toHaveLength(1)
  })

  it('bounds the size per save, the saves and bytes per connection, and the saves per host', async () => {
    const staged = saves({
      maxBytesPerSave: 10,
      maxSavesPerConnection: 2,
      maxBytesPerConnection: 15,
      maxSavesPerHost: 3
    })
    const target = (name: string) => join(root, name)
    await expect(staged.begin('conn-1', target('a'), 11)).rejects.toThrow('staged_save_limit')
    await staged.begin('conn-1', target('a'), 10)
    await expect(staged.begin('conn-1', target('b'), 6)).rejects.toThrow('staged_save_limit')
    await staged.begin('conn-1', target('b'), 5)
    await expect(staged.begin('conn-1', target('c'), 1)).rejects.toThrow('staged_save_limit')
    await staged.begin('conn-2', target('c'), 1)
    await expect(staged.begin('conn-3', target('d'), 1)).rejects.toThrow('staged_save_limit')
  })

  it('drops a save no chunk touched within the idle window, with its temp', async () => {
    const staged = saves({ idleMs: 20 })
    const { saveId } = await staged.begin('conn-1', join(root, 'a.txt'), 3)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(temps()).toEqual([])
    await expect(staged.append('conn-1', saveId, 0, Buffer.from('abc'))).rejects.toThrow(
      'staged_save_unknown'
    )
  })

  it('removes at host start the temps a crashed run left, and nothing it did not name', async () => {
    const crashed = saves()
    await crashed.begin('conn-1', join(root, 'a.txt'), 3)
    const unrelated = join(root, 'notes.tmp')
    writeFileSync(unrelated, 'keep')
    writeFileSync(
      journal,
      JSON.stringify({ version: 1, temps: [...temps().map((name) => join(root, name)), unrelated] })
    )

    saves().sweepOrphans()
    expect(temps()).toEqual([])
    expect(existsSync(unrelated)).toBe(true)
    expect(existsSync(journal)).toBe(false)
  })
})
