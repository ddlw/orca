import { Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { Users } from 'lucide-react'
import { NativeChatPromptPill } from './NativeChatPromptPill'
import { agentReferenceToken } from '../../../../shared/orchestration-agent-reference'

function AgentReferencePill({ node, selected }: NodeViewProps): React.JSX.Element {
  return (
    <NodeViewWrapper
      as="span"
      className="inline"
      contentEditable={false}
      data-native-chat-agent-reference={node.attrs.address}
    >
      <NativeChatPromptPill icon={Users} label={String(node.attrs.label)} selected={selected} />
    </NodeViewWrapper>
  )
}

export const NativeChatAgentReference = Node.create({
  name: 'nativeChatAgentReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    label: { default: '' },
    address: { default: '' },
    hostKey: { default: '' }
  }),
  addNodeView: () => ReactNodeViewRenderer(AgentReferencePill),
  renderText: ({ node }) =>
    agentReferenceToken({
      label: String(node.attrs.label),
      address: String(node.attrs.address),
      hostKey: String(node.attrs.hostKey)
    }),
  renderHTML: ({ node }) => [
    'span',
    { 'data-native-chat-agent-reference': node.attrs.address },
    `@${node.attrs.label}`
  ]
})
