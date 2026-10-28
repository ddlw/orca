// @vitest-environment happy-dom
import { CrewPanelContent } from '../orchestration-crew/OrchestrationCrewPanel'
import { TooltipProvider } from '../ui/tooltip'
import { emptyCrew, type OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import { openOrchestrationCrewAgent } from '@/lib/open-agent-message-sender'
import { createRef } from 'react'
import { act, cleanup, render, renderHook, within, fireEvent } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../terminal-pane/pty-transport-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { agentReferenceToken } from '../../../../shared/orchestration-agent-reference'
import { serializeNativeChatAgentReferences } from './native-chat-agent-reference-send'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { useNativeChatComposerSubmit } from './use-native-chat-composer-submit'
import { sendNativeChatMessage } from './native-chat-runtime-send'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { captureTerminalDropTarget } from '../terminal-pane/terminal-drop-target'
import { insertTerminalCrewMention } from '../terminal-pane/terminal-crew-mention'
import { takeStructuredAgentSessionSendSlot } from './structured-agent-session-send-slot'
import { clearStructuredAgentSessionPendingSends } from './structured-agent-session-pending-sends'
import {
  attemptStructuredAgentSessionSend,
  noteStructuredAgentSessionFence
} from './structured-agent-session-send-attempt'

const queuedRuntime = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: queuedRuntime.call
}))

vi.mock('@/lib/open-agent-message-sender', () => ({ openOrchestrationCrewAgent: vi.fn() }))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(() => ({ cancel() {}, settleAfterMs: 0 })),
  sendNativeChatTypedCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: vi.fn()
}))
afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
  clearStructuredAgentSessionPendingSends('test-session')
  vi.restoreAllMocks()
})
const first = { label: 'Same name', address: 'term_first', hostKey: 'local' }
const second = { ...first, address: 'dispatch:ctx_second' }
function editor(scope: string, text = 'Hello ') {
  const ref = createRef<NativeChatComposerInput>()
  const view = render(
    <NativeChatPromptEditor
      scopeKey={scope}
      inputRef={ref}
      initialValue={text}
      disabled={false}
      placeholder="Message"
      onChange={vi.fn()}
      onSelect={vi.fn()}
    />
  )
  return {
    ...view,
    input: ref.current!,
    editor: promptEditor(within(view.container).getByRole('textbox'))
  }
}
function transport(): NativeChatStructuredComposerTransport {
  return {
    capturePresentation: () => () => true,
    send: vi.fn(() => 'queued'),
    dispatchCommand: vi.fn(async () => ({ accepted: true, error: null })),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'test-session',
    runtimeEnvironmentId: null
  }
}

it('keeps a split’s caret, duplicate-name identities, literal copy/recall and atomic undo', async () => {
  const left = editor('left')
  const right = editor('right', 'Other draft')
  await act(async () => {
    left.input.setSelectionRange(6, 6)
    right.input.focus()
    left.input.insertAgentReferences!([first, second])
  })
  const stored = `Hello ${agentReferenceToken(first)} ${agentReferenceToken(second)} `
  expect(left.input.value).toBe(stored)
  expect(right.input.value).toBe('Other draft')
  expect(left.container.querySelectorAll('[data-native-chat-agent-reference]')).toHaveLength(2)
  const doc = readNativeChatComposerDraft('left').document
  expect(serializeNativeChatAgentReferences(stored, doc)).toBe(
    'Hello @Same name @Same name \n\n[Orca agent "Same name": term_first — message it with orca orchestration send --to term_first]\n[Orca agent "Same name": dispatch:ctx_second — message it with orca orchestration send --to dispatch:ctx_second]'
  )
  expect(left.editor.getText()).toBe(stored)
  expect(serializeNativeChatAgentReferences('/model', doc)).toBe('/model')
  await act(async () => {
    left.input.setSelectionRange(6, 6 + agentReferenceToken(first).length)
    left.editor.commands.deleteSelection()
  })
  expect(left.container.querySelectorAll('[data-native-chat-agent-reference]')).toHaveLength(1)
  await act(async () => {
    left.editor.commands.undo()
  })
  expect(left.input.value).toBe(stored)
  await act(async () => {
    left.input.value = 'Old plain @Same name draft'
  })
  expect(left.container.querySelectorAll('[data-native-chat-agent-reference]')).toHaveLength(0)
  expect(
    serializeNativeChatAgentReferences(
      left.input.value,
      readNativeChatComposerDraft('left').document
    )
  ).toBe('Old plain @Same name draft')
})

it('serializes before structured queue admission, PTY writes and goal submission; picker sends do not inherit atoms', async () => {
  const pane = editor('send')
  act(() => {
    pane.input.setSelectionRange(6, 6)
    pane.input.insertAgentReferences!([first, first, second])
  })
  const snapshot = readNativeChatComposerDraft('send')
  const wire = serializeNativeChatAgentReferences(snapshot.text, snapshot.document)
  const structured = transport()
  const structuredHook = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent: 'claude',
      draftScopeKey: 'send',
      imageAttachments: [],
      structuredTransport: structured,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn()
    })
  )
  await act(async () => {
    await structuredHook.result.current(snapshot.text)
  })
  expect(structured.send).toHaveBeenCalledWith(wire, [])
  expect(wire.match(/\[Orca agent/g)).toHaveLength(2)
  const queued = vi.mocked(structured.send).mock.calls[0][0]
  const entry = takeStructuredAgentSessionSendSlot({
    sessionId: 'test-session',
    text: queued,
    delivery: 'queue-if-active'
  })
  expect(entry).not.toBeNull()
  updateNativeChatComposerDraft('send', { text: 'new draft', document: undefined }, 'immediate')
  noteStructuredAgentSessionFence('test-session', 1)
  queuedRuntime.call.mockResolvedValue({
    ok: true,
    replayed: true,
    fence: 1,
    value: { clientMessageId: entry!.clientMessageId }
  })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await attemptStructuredAgentSessionSend({
      entry: entry!,
      target: { kind: 'local' },
      beforeIssue: vi.fn(),
      abandoned: () => false,
      reconcile: vi.fn()
    })
  }
  expect(queuedRuntime.call).toHaveBeenCalledTimes(2)
  for (const [, method, params] of queuedRuntime.call.mock.calls) {
    expect(method).toBe('agentSession.send')
    expect(params.body.blocks).toEqual([{ type: 'text', text: wire }])
    expect(params.delivery).toBe('queue-if-active')
    expect(params.envelope.clientOperationId).toBe(entry!.clientMessageId)
  }
  await act(async () => {
    await structuredHook.result.current('/compact')
  })
  expect(structured.dispatchCommand).toHaveBeenCalledWith('/compact')
  updateNativeChatComposerDraft('send', snapshot, 'immediate')
  const ptyHook = renderHook(() =>
    useNativeChatPtyComposerSend({
      agent: 'codex',
      draftScopeKey: 'send',
      draft: snapshot.text,
      imageAttachments: [],
      disabled: false,
      isDispatchingSessionOption: false,
      launchDraftResolved: true,
      resolveTarget: () => ({ ptyId: 'pty-left', settings: null }),
      classifySend: () => 'chat',
      sessionOptionsSurface: null,
      terminalTabId: 'tab-left',
      trackPendingSend: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice: vi.fn()
    })
  )
  act(() => ptyHook.result.current())
  expect(vi.mocked(sendNativeChatMessage).mock.calls.at(-1)?.slice(0, 2)).toEqual([
    'pty-left',
    wire
  ])
  const goalTransport = transport()
  goalTransport.threadGoal = { setObjective: vi.fn(async () => true) }
  const goalHook = renderHook(() =>
    useNativeChatComposerSubmit({
      structuredTransport: goalTransport,
      draftScopeKey: 'send',
      draft: snapshot.text,
      caret: 0,
      imageAttachments: [],
      disabled: false,
      sendPty: vi.fn(),
      sendStructured: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn()
    })
  )
  act(() =>
    goalHook.result.current.goalMode.interceptPick(vi.fn())({
      kind: 'command',
      id: 'goal',
      name: 'goal',
      token: '/goal',
      skillCollision: false
    })
  )
  updateNativeChatComposerDraft('send', snapshot, 'immediate')
  await act(async () => goalHook.result.current.send())
  expect(goalTransport.threadGoal.setObjective).toHaveBeenCalledWith(wire.trim())
})

it('writes only revalidated split bytes, sanitizing controls without Enter and surfacing rejected acceptance', async () => {
  let leaf = 'leaf-left'
  const sendInput = vi.fn(() => true)
  const sendInputAccepted = vi.fn(async () => true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mention only reads pane id/leaf, never operates a terminal widget.
  const manager = { getPanes: () => [{ id: 1, leafId: leaf }] } as PaneManager
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing drop validator and writer only consume these four transport methods.
  const pty = {
    getPtyId: () => 'pty-left',
    isConnected: () => true,
    sendInput,
    sendInputAccepted
  } as unknown as PtyTransport
  const target = captureTerminalDropTarget({ id: 1, leafId: leaf }, pty)
  const transports = new Map([[1, pty]])
  expect(
    await insertTerminalCrewMention(manager, transports, target, [
      { ...first, label: 'Zoë\r\n\u001b[31m\u2028\u0085' }
    ])
  ).toBe(true)
  expect(sendInputAccepted).toHaveBeenCalledWith('Zoë  [31m  (Orca agent term_first) ', 'driving')
  expect(sendInput).not.toHaveBeenCalled()
  leaf = 'leaf-replaced'
  expect(await insertTerminalCrewMention(manager, transports, target, [first])).toBe(false)
  expect(sendInputAccepted).toHaveBeenCalledTimes(1)
  leaf = 'leaf-left'
  sendInputAccepted.mockResolvedValueOnce(false)
  expect(await insertTerminalCrewMention(manager, transports, target, [first])).toBe(false)
  expect(sendInputAccepted).toHaveBeenCalledTimes(2)
  expect(
    await insertTerminalCrewMention(manager, transports, target, [
      { ...first, address: 'term_bad\r' }
    ])
  ).toBe(false)
  expect(sendInputAccepted).toHaveBeenCalledTimes(2)
})

it('hides unknown hosts, starts collapsed and separates mention, navigation and disclosure hit targets', () => {
  const mention = vi.fn()
  const row: OrchestrationCrewRow = {
    partyKey: 'host+worker',
    role: 'worker',
    label: 'Worker',
    agentKind: 'codex',
    status: 'waiting',
    task: { title: 'Implement crew', state: 'blocked' },
    pendingQuestion: { preview: 'Choose A or B?', at: new Date(0).toISOString() },
    sendAddress: 'dispatch:ctx_worker'
  }
  const props = {
    target: { kind: 'local' } as const,
    party: 'term_coord',
    canMention: true,
    mention
  }
  const view = render(
    <TooltipProvider>
      <CrewPanelContent {...props} snapshot={emptyCrew('unknown')} />
    </TooltipProvider>
  )
  expect(view.container.querySelector('[data-orchestration-crew]')).toBeNull()
  const snapshot = emptyCrew('ok')
  snapshot.sections.managing.push(row)
  view.rerender(
    <TooltipProvider>
      <CrewPanelContent {...props} snapshot={snapshot} />
    </TooltipProvider>
  )
  expect(view.queryByRole('complementary')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Show crew: 1 workers' }))
  expect(view.getByText('Choose A or B?')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Mention all' }))
  expect(mention).toHaveBeenCalledWith([row])
  mention.mockClear()
  fireEvent.click(view.getByRole('button', { name: 'Open Worker' }))
  expect(openOrchestrationCrewAgent).toHaveBeenCalledWith(row, props.target)
  fireEvent.click(view.getByRole('button', { name: "Show Worker's task and latest message" }))
  expect(view.queryByText('Choose A or B?')).toBeNull()
  expect(mention).not.toHaveBeenCalled()
  fireEvent.keyDown(view.getByRole('complementary'), { key: 'Escape' })
  expect(view.queryByRole('complementary')).toBeNull()
  expect(document.activeElement).toBe(view.getByRole('button', { name: 'Show crew: 1 workers' }))
})
