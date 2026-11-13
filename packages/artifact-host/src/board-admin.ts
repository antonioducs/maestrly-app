import { checkBoard, readBoard as outlineOf } from '@maestrly/whiteboard'
import type { BoardService } from './boards.js'
import { ArtifactHostError } from './errors.js'
import { isArtifactId, newArtifactId } from './ids.js'
import {
  type ApplyBoardInput,
  type ArtifactDetail,
  applyBoardInput,
  type BoardApply,
  type BoardCreated,
  type BoardRead,
  type CreateBoardInput,
  createBoardInput,
  parseInput,
  type ReadBoardOptions,
  readBoardOptions,
} from './schemas.js'
import type { ArtifactStore } from './store/artifact-store.js'
import type { SharingStore } from './store/sharing-store.js'
import type { WhiteboardViewer } from './whiteboard-viewer.js'

/** What the owner and their agents do with whiteboards. */
export interface BoardAdmin {
  /** A whiteboard drawn by the agent's ops, which people and agents then edit in place. */
  createBoard(input: CreateBoardInput): Promise<BoardCreated>
  /** An outline of a whiteboard, what changed on it after `since`, and what looks wrong on it. */
  readBoard(id: string, options?: ReadBoardOptions): Promise<BoardRead>
  /** Applies the agent's ops on top of the revision it read; what a person changed since then wins. */
  applyBoard(input: ApplyBoardInput): Promise<BoardApply>
}

export function createBoardAdmin(deps: {
  store: ArtifactStore
  sharing: SharingStore
  boards: BoardService
  clock: () => number
  viewer: WhiteboardViewer | null
  detail: (id: string) => ArtifactDetail | null
  /** Runs one write at a time with the admin's other writes. */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>
  onChange?: (artifactId: string) => void
}): BoardAdmin {
  const { store, boards, clock } = deps

  /** A whiteboard of this host, or why it is not one. */
  const whiteboard = (id: string) => {
    const artifact = isArtifactId(id) ? store.getArtifact(id) : null
    if (!artifact) throw new ArtifactHostError('not_found', 'Artifact not found')
    if (artifact.kind !== 'whiteboard')
      throw new ArtifactHostError('unsupported_type', 'This artifact is a page, not a whiteboard')
    return artifact
  }

  return {
    async createBoard(raw) {
      const input = parseInput(createBoardInput, raw)
      if (!deps.viewer)
        throw new ArtifactHostError('unsupported_type', 'This server cannot host whiteboards yet', {
          reason: 'no_whiteboards',
        })
      return deps.exclusive(async () => {
        const id = newArtifactId()
        const now = clock()
        store.createArtifact(
          {
            id,
            kind: 'whiteboard',
            title: input.title,
            description: input.description,
            ownerKind: input.owner.kind,
            ownerId: input.owner.id,
            workspaceId: input.origin.workspaceId,
            conversationId: input.origin.conversationId,
            conversationTitle: input.origin.conversationTitle,
            createdAt: now,
          },
          { entry: 'index.html', summary: '', createdBy: 'agent', createdAt: now, files: [] }
        )
        let drawn = { revision: 0, created: [] as string[] }
        try {
          if (input.ops) drawn = boards.init(id, input.ops, now)
        } catch (error) {
          store.deleteArtifact(id)
          boards.forget(id)
          throw error
        }
        deps.onChange?.(id)
        return { detail: deps.detail(id)!, ...drawn, warnings: checkBoard(boards.board(id)) }
      })
    },

    async readBoard(id, options = {}) {
      const { since, section } = parseInput(readBoardOptions, options)
      const artifact = whiteboard(id)
      const board = boards.board(id)
      return {
        id,
        title: artifact.title,
        revision: board.revision,
        editors: deps.sharing.getSharing(id)?.boardEditors ?? 'owner',
        outline: outlineOf(board, { since, section }),
        warnings: checkBoard(board),
      }
    },

    async applyBoard(raw) {
      const input = parseInput(applyBoardInput, raw)
      whiteboard(input.id)
      const result = boards.applyAgent(input.id, input, clock())
      deps.onChange?.(input.id)
      return { ...result, warnings: checkBoard(boards.board(input.id)) }
    },
  }
}
