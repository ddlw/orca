/**
 * A text save too large for one remote request: the client sends it in chunks to a temp file the
 * host makes beside the target, and the commit replaces the target by rename under the same locks
 * and disk precondition as `files.writeIfUnchanged`. Bounded per save, per connection and per host;
 * an idle save is dropped, and a journal lets the next host start remove temps a crash left.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { appendFile, chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  FileWriteDiskPrecondition,
  FileWriteResult
} from '../../../shared/file-write-disk-precondition'
import { STAGED_FILE_SAVE_LIMITS } from '../../../shared/staged-file-save'
import { writeLocalFileGuarded } from '../../ipc/filesystem/local-disk-write-precondition'
import { windowsFsPath } from '../../wsl/wsl-unc-drive-fs-path'

const TEMP_NAME = /^\..+\.orca-save-[0-9a-f-]{36}\.tmp$/
const JOURNAL_VERSION = 1

type StagedSave = {
  owner: string
  targetPath: string
  tempPath: string
  totalBytes: number
  written: number
  idleTimer: ReturnType<typeof setTimeout>
}

export type StagedFileSavesDeps = {
  /** Where the temps this host has open are listed; null keeps no journal. */
  journalPath: () => string | null
  limits?: typeof STAGED_FILE_SAVE_LIMITS
}

export class StagedFileSaves {
  private readonly saves = new Map<string, StagedSave>()
  private readonly limits: typeof STAGED_FILE_SAVE_LIMITS
  private swept = false

  constructor(private readonly deps: StagedFileSavesDeps) {
    this.limits = deps.limits ?? STAGED_FILE_SAVE_LIMITS
  }

  /** `targetPath` is already authorized and local; the temp goes in its (real) folder. */
  async begin(owner: string, targetPath: string, totalBytes: number): Promise<{ saveId: string }> {
    this.sweepOrphans()
    const { maxBytesPerSave, maxSavesPerConnection, maxBytesPerConnection, maxSavesPerHost } =
      this.limits
    const mine = [...this.saves.values()].filter((save) => save.owner === owner)
    if (
      totalBytes > maxBytesPerSave ||
      mine.length >= maxSavesPerConnection ||
      mine.reduce((sum, save) => sum + save.totalBytes, 0) + totalBytes > maxBytesPerConnection ||
      this.saves.size >= maxSavesPerHost
    ) {
      throw new Error('staged_save_limit')
    }
    const fsTarget = windowsFsPath(targetPath)
    const saveId = randomUUID()
    const tempPath = join(dirname(fsTarget), `.${basename(fsTarget)}.orca-save-${saveId}.tmp`)
    // Exclusive create: a name collision never truncates someone else's file.
    await writeFile(tempPath, Buffer.alloc(0), { flag: 'wx' })
    const mode = await stat(fsTarget).then(
      (stats) => stats.mode & 0o7777,
      () => null
    )
    if (mode !== null) {
      await chmod(tempPath, mode).catch(() => {})
    }
    this.saves.set(saveId, {
      owner,
      targetPath,
      tempPath,
      totalBytes,
      written: 0,
      idleTimer: this.idleTimer(saveId)
    })
    this.writeJournal()
    return { saveId }
  }

  async append(owner: string, saveId: string, offset: number, bytes: Buffer): Promise<void> {
    const save = this.require(owner, saveId)
    // In order only: a retried or reordered chunk can't land twice or leave a gap.
    if (offset !== save.written || save.written + bytes.length > save.totalBytes) {
      throw new Error('staged_save_out_of_order')
    }
    this.touch(saveId, save)
    save.written += bytes.length
    try {
      await appendFile(save.tempPath, bytes)
    } catch (error) {
      await this.abort(owner, saveId)
      throw error
    }
  }

  async commit(
    owner: string,
    saveId: string,
    precondition: FileWriteDiskPrecondition | undefined
  ): Promise<FileWriteResult> {
    const save = this.require(owner, saveId)
    if (save.written !== save.totalBytes) {
      throw new Error('staged_save_incomplete')
    }
    clearTimeout(save.idleTimer)
    this.saves.delete(saveId)
    try {
      const content = (await readFile(save.tempPath)).toString('utf8')
      // Same locks and compare as a one-request save; the rename keeps the target whole.
      return await writeLocalFileGuarded(save.targetPath, content, precondition, (path) =>
        rename(save.tempPath, path)
      )
    } finally {
      await rm(save.tempPath, { force: true })
      this.writeJournal()
    }
  }

  async abort(owner: string, saveId: string): Promise<void> {
    const save = this.saves.get(saveId)
    if (!save || save.owner !== owner) {
      return
    }
    clearTimeout(save.idleTimer)
    this.saves.delete(saveId)
    await rm(save.tempPath, { force: true })
    this.writeJournal()
  }

  /** Host start: temps a crashed run left are removed, never a file this run did not name. */
  sweepOrphans(): void {
    if (this.swept) {
      return
    }
    this.swept = true
    const journal = this.deps.journalPath()
    if (!journal) {
      return
    }
    let listed: unknown
    try {
      listed = JSON.parse(readFileSync(journal, 'utf8'))
    } catch {
      return
    }
    const temps =
      listed && typeof listed === 'object' && 'temps' in listed && Array.isArray(listed.temps)
        ? listed.temps
        : []
    for (const temp of temps) {
      if (typeof temp === 'string' && TEMP_NAME.test(basename(temp))) {
        rmSync(temp, { force: true })
      }
    }
    this.writeJournal()
  }

  private require(owner: string, saveId: string): StagedSave {
    const save = this.saves.get(saveId)
    // Another connection's id reads as unknown, so ids can't be probed across clients.
    if (!save || save.owner !== owner) {
      throw new Error('staged_save_unknown')
    }
    return save
  }

  private touch(saveId: string, save: StagedSave): void {
    clearTimeout(save.idleTimer)
    save.idleTimer = this.idleTimer(saveId)
  }

  private idleTimer(saveId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const save = this.saves.get(saveId)
      if (save) {
        void this.abort(save.owner, saveId)
      }
    }, this.limits.idleMs)
    timer.unref?.()
    return timer
  }

  private writeJournal(): void {
    const journal = this.deps.journalPath()
    if (!journal) {
      return
    }
    const temps = [...this.saves.values()].map((save) => save.tempPath)
    try {
      if (temps.length === 0) {
        rmSync(journal, { force: true })
      } else {
        writeFileSync(journal, JSON.stringify({ version: JOURNAL_VERSION, temps }))
      }
    } catch (error) {
      console.warn('[files] Could not record staged saves:', error)
    }
  }
}
