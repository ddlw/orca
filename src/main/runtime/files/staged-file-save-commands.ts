import { join } from 'node:path'
import type {
  FileWriteDiskPrecondition,
  FileWriteResult
} from '../../../shared/file-write-disk-precondition'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { resolveRuntimeAuthorizedPath } from './chat-scratch-file-root'
import type { RuntimeFileCommandHost } from './file-command-host'
import { assertRuntimeFileMutationExpectation } from './file-mutation-expectation'
import { requireLocalRuntimeFileRoute, resolveFileExplorerPath } from './file-target'
import { StagedFileSaves } from './staged-file-saves'

const JOURNAL_FILE = 'staged-file-saves.json'

function profileJournalPath(): string | null {
  try {
    return join(getProfileUserDataPath(), JOURNAL_FILE)
  } catch {
    return null
  }
}

type StagedSaveTarget = {
  worktree: string
  relativePath: string
  totalBytes: number
  expectedExecutionHostId?: string
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
}

/** The runtime's staged saves: the target is resolved and authorized once, at begin. */
export class RuntimeStagedFileSaves {
  constructor(
    private readonly host: Pick<
      RuntimeFileCommandHost,
      'requireStore' | 'resolveRuntimeFileTarget'
    >,
    private readonly saves = new StagedFileSaves({ journalPath: profileJournalPath })
  ) {}

  async begin(owner: string, params: StagedSaveTarget): Promise<{ saveId: string }> {
    const target = await resolveFileExplorerPath(this.host, params.worktree, params.relativePath)
    assertRuntimeFileMutationExpectation(
      target.executionHostId,
      params.expectedExecutionHostId,
      params.expectedSshTargetId,
      params.expectedSshConnectionGeneration
    )
    requireLocalRuntimeFileRoute(target)
    const path = await resolveRuntimeAuthorizedPath(target.path, this.host.requireStore())
    return this.saves.begin(owner, path, params.totalBytes)
  }

  append(owner: string, saveId: string, offset: number, bytes: Buffer): Promise<void> {
    return this.saves.append(owner, saveId, offset, bytes)
  }

  commit(
    owner: string,
    saveId: string,
    precondition: FileWriteDiskPrecondition | undefined
  ): Promise<FileWriteResult> {
    return this.saves.commit(owner, saveId, precondition)
  }

  abort(owner: string, saveId: string): Promise<void> {
    return this.saves.abort(owner, saveId)
  }

  sweepOrphans(): void {
    this.saves.sweepOrphans()
  }
}
