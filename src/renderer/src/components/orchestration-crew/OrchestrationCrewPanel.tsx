import { useLayoutEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  MoreHorizontal,
  PanelRight,
  PanelRightClose
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type {
  OrchestrationCrewRow,
  OrchestrationCrewSnapshot
} from '../../../../shared/orchestration-crew'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useOrchestrationCrew } from '../native-chat/use-orchestration-crew'
import { openOrchestrationCrewAgent } from '@/lib/open-agent-message-sender'
import { cn } from '@/lib/utils'

function Avatar({ row }: { row: OrchestrationCrewRow }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground"
    >
      <AgentIcon agent={isTuiAgent(row.agentKind) ? row.agentKind : null} />
    </span>
  )
}
function Dot({ row }: { row: OrchestrationCrewRow }) {
  return (
    <span
      aria-label={row.status}
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        row.pendingQuestion || row.status === 'waiting' || row.status === 'blocked'
          ? 'bg-status-warning'
          : row.status === 'working'
            ? 'bg-status-success'
            : 'bg-muted-foreground'
      )}
    />
  )
}
function Time({ at }: { at?: string }) {
  if (!at) {
    return null
  }
  const date = new Date(at.includes('T') ? at : `${at.replace(' ', 'T')}Z`)
  return Number.isFinite(date.getTime()) ? (
    <time dateTime={date.toISOString()} className="shrink-0 text-2xs text-muted-foreground">
      {date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
    </time>
  ) : null
}
function IconButton({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function runningWorker(row: OrchestrationCrewRow): boolean {
  return Boolean(
    row.sendAddress &&
    row.task &&
    !['completed', 'failed'].includes(row.task.state) &&
    (row.task.state === 'dispatched' || ['working', 'waiting', 'blocked'].includes(row.status))
  )
}

type PanelProps = {
  target: RuntimeClientTarget
  party: string
  canMention: boolean
  mention: (rows: OrchestrationCrewRow[]) => void
}
export function OrchestrationCrewPanel(props: PanelProps): React.JSX.Element | null {
  const snapshot = useOrchestrationCrew(props.target, props.party)
  return <CrewPanelContent {...props} snapshot={snapshot} />
}

export function CrewPanelContent({
  target,
  canMention,
  mention,
  snapshot
}: PanelProps & { snapshot: OrchestrationCrewSnapshot }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const tab = useRef<HTMLButtonElement>(null)
  const collapse = useRef<HTMLButtonElement>(null)
  const restore = useRef(false)
  useLayoutEffect(() => {
    if (open) {
      collapse.current?.focus({ preventScroll: true })
    } else if (restore.current) {
      tab.current?.focus({ preventScroll: true })
    }
  }, [open])
  const { managedBy, managing, talkingWith } = snapshot.sections
  const all = [...managedBy, ...managing, ...talkingWith]
  if (snapshot.status !== 'ok' || all.length === 0) {
    return null
  }
  const pending = all.filter((row) => row.pendingQuestion).length
  const label = managing.length
    ? `${managing.length} workers`
    : managedBy.length
      ? `Managed by ${managedBy[0].label}`
      : `Talking with ${talkingWith[0].label}`
  const changeOpen = (value: boolean) => {
    restore.current = true
    setOpen(value)
  }
  const sections = [
    ['Managed by', managedBy],
    ['Managing', managing],
    ['Talking with', talkingWith]
  ] as const
  return (
    <div
      data-orchestration-crew
      data-pane-prevent-terminal-focus
      data-native-chat-typing-redirect-ignore="true"
      className="pointer-events-auto absolute inset-y-0 right-0 z-30 text-foreground"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          changeOpen(false)
        }
      }}
    >
      {open ? (
        <aside
          aria-label="Agent crew"
          className="flex h-full w-80 max-w-full flex-col border-l border-border bg-card text-card-foreground shadow-xs"
        >
          <div className="flex h-9 shrink-0 items-center justify-end border-b border-border px-2">
            <IconButton
              ref={collapse}
              label="Collapse crew panel"
              onClick={() => changeOpen(false)}
            >
              <PanelRightClose />
            </IconButton>
          </div>
          <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
            {sections.map(([title, rows]) =>
              rows.length > 0 ? (
                <section key={title} aria-label={title}>
                  <div className="flex items-center gap-1.5 px-3 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <span>{title}</span>
                    <span>{rows.length}</span>
                    {title === 'Managing' ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="ml-auto normal-case tracking-normal"
                        disabled={!canMention || !rows.some(runningWorker)}
                        onClick={() => mention(rows.filter(runningWorker))}
                      >
                        Mention all
                      </Button>
                    ) : null}
                  </div>
                  {rows.map((row) => (
                    <CrewRowView
                      key={row.partyKey}
                      row={row}
                      target={target}
                      canMention={canMention}
                      mention={() => mention([row])}
                    />
                  ))}
                </section>
              ) : null
            )}
          </div>
        </aside>
      ) : (
        <Button
          ref={tab}
          variant="outline"
          size="xs"
          className="absolute right-0 top-2 max-w-80 rounded-r-none bg-card text-card-foreground"
          aria-label={`Show crew: ${label}`}
          aria-expanded={false}
          onClick={() => changeOpen(true)}
        >
          <PanelRight />
          <span className="flex -space-x-2">
            {all.slice(0, 3).map((row) => (
              <Avatar key={row.partyKey} row={row} />
            ))}
          </span>
          <span className="truncate">{label}</span>
          <span className="flex gap-0.5">
            {managing.map((row) => (
              <Dot key={row.partyKey} row={row} />
            ))}
          </span>
          {pending > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="text-status-warning">
                  {pending}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{pending} waiting for you</TooltipContent>
            </Tooltip>
          ) : null}
        </Button>
      )}
    </div>
  )
}

function CrewRowView({
  row,
  target,
  canMention,
  mention
}: {
  row: OrchestrationCrewRow
  target: RuntimeClientTarget
  canMention: boolean
  mention: () => void
}) {
  const [disclosure, setDisclosure] = useState<{ question?: string; expanded: boolean }>()
  const question = row.pendingQuestion?.at
  const expanded =
    disclosure?.question === question
      ? (disclosure?.expanded ?? Boolean(question))
      : Boolean(question)
  const open = () => {
    void openOrchestrationCrewAgent(row, target)
  }
  return (
    <div className="border-b border-border/50">
      <div className="flex items-center gap-1 px-2 py-2">
        <Button
          variant="ghost"
          className="h-auto min-w-0 flex-1 justify-start gap-2 px-1 py-1 text-left"
          disabled={!canMention || !row.sendAddress}
          onPointerDown={(event) => event.preventDefault()}
          onClick={mention}
        >
          <Avatar row={row} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <Dot row={row} />
              <span className="truncate text-sm font-medium">{row.label}</span>
            </span>
            <span className="block truncate text-2xs font-normal text-muted-foreground">
              {row.agentKind}
              {row.hostLabel ? ` · ${row.hostLabel}` : ''}
            </span>
            <span
              className={cn(
                'block truncate text-xs font-normal',
                row.pendingQuestion ? 'text-status-warning' : 'text-muted-foreground'
              )}
            >
              {row.pendingQuestion ? 'Waiting for you · ' : ''}
              {row.task?.title ?? 'No shared task'}
            </span>
          </span>
        </Button>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Time at={row.pendingQuestion?.at ?? row.latest?.at} />
          <div className="flex">
            <IconButton label={`Open ${row.label}`} onClick={open}>
              <ExternalLink />
            </IconButton>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={`More for ${row.label}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
                <DropdownMenuItem disabled={!canMention || !row.sendAddress} onSelect={mention}>
                  Mention in message
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={open}>Open its chat</DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!row.sendAddress}
                  onSelect={() => {
                    if (row.sendAddress) {
                      void window.api.ui
                        .writeTerminalClipboardText(row.sendAddress)
                        .then(() => toast.success(`Copied ${row.label}'s address`))
                    }
                  }}
                >
                  Copy address
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <IconButton
              label={`Show ${row.label}'s task and latest message`}
              aria-expanded={expanded}
              onClick={() => setDisclosure({ question, expanded: !expanded })}
            >
              {expanded ? <ChevronDown /> : <ChevronRight />}
            </IconButton>
          </div>
        </div>
      </div>
      {expanded ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 px-3 pb-3 text-xs">
          <dt className="text-muted-foreground">Task</dt>
          <dd>
            {row.task ? (
              <>
                <Badge variant="outline" className="mr-1 text-3xs">
                  {row.task.state}
                </Badge>
                {row.task.title}
              </>
            ) : (
              'No shared task'
            )}
          </dd>
          {row.progress ? (
            <>
              <dt className="text-muted-foreground">Progress</dt>
              <dd>{row.progress}</dd>
            </>
          ) : null}
          {row.pendingQuestion ? (
            <>
              <dt className="text-status-warning">Asks you</dt>
              <dd className="whitespace-pre-wrap break-words">{row.pendingQuestion.preview}</dd>
            </>
          ) : row.latest ? (
            <>
              <dt className="text-muted-foreground">Latest</dt>
              <dd className="min-w-0">
                <span className="text-2xs text-muted-foreground">
                  {row.latest.direction === 'to' ? 'To' : 'From'} {row.label} ·{' '}
                  <Time at={row.latest.at} />
                </span>
                <blockquote className="mt-1 whitespace-pre-wrap break-words border-l border-border pl-2">
                  {row.latest.preview}
                </blockquote>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  )
}
