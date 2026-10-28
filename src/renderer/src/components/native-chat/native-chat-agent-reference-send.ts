import type { JSONContent } from '@tiptap/react'
import { imageReferenceToken } from '../../../../shared/native-chat-image-reference'
import {
  agentReferenceToken,
  isPublicOrchestrationAddress,
  type OrchestrationAgentReference
} from '../../../../shared/orchestration-agent-reference'

/** Only the document matching this submission can contribute selected targets. */
export function serializeNativeChatAgentReferences(text: string, document?: JSONContent): string {
  const references = new Map<string, OrchestrationAgentReference>()
  const render = (node: JSONContent, wire: boolean): string => {
    if (node.type === 'nativeChatAgentReference') {
      const { label, address, hostKey } = node.attrs ?? {}
      if (typeof label !== 'string' || typeof address !== 'string' || typeof hostKey !== 'string') {
        return ''
      }
      const reference = { label, address, hostKey }
      if (wire && isPublicOrchestrationAddress(address)) {
        references.set(JSON.stringify([hostKey, address]), reference)
        return `@${label}`
      }
      return agentReferenceToken(reference)
    }
    if (node.type === 'hardBreak') {
      return '\n'
    }
    if (node.type === 'nativeChatImageReference') {
      return imageReferenceToken(String(node.attrs?.attachmentId))
    }
    if (node.text !== undefined) {
      return node.text
    }
    if (typeof node.attrs?.token === 'string') {
      return node.attrs.token
    }
    return (node.content ?? [])
      .map((child) => render(child, wire))
      .join(node.type === 'doc' ? '\n' : '')
  }
  if (!document || render(document, false) !== text) {
    return text
  }
  const wire = render(document, true)
  return `${wire}${
    references.size === 0
      ? ''
      : `\n\n${[...references.values()]
          .map(
            ({ label, address }) =>
              `[Orca agent "${label}": ${address} — message it with orca orchestration send --to ${address}]`
          )
          .join('\n')}`
  }`
}
