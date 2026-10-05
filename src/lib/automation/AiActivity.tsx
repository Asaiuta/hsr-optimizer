import {
  Badge,
  Box,
  Button,
  Code,
  Collapse,
  Drawer,
  Flex,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import {
  IconCheck,
  IconRobot,
  IconX,
} from '@tabler/icons-react'
import { appendMirrorFeedEntry } from 'lib/automation/mirror'
import type {
  AutomationMirrorBroadcast,
  MirrorFeedEntry,
} from 'lib/automation/mirror'
import { Message } from 'lib/interactions/message'
import {
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'

/** Port of the MCP relay started by scripts/automation-mcp.mts (HSR_MIRROR_PORT). */
const MIRROR_PORT = 4176
const MIRROR_ORIGIN = `http://127.0.0.1:${MIRROR_PORT}`

type ActivityState = {
  entries: MirrorFeedEntry[],
  connected: boolean,
}

let activityState: ActivityState = { entries: [], connected: false }
const activityListeners = new Set<() => void>()
let activitySource: EventSource | undefined
let lastSeenSeq = 0

function setActivityState(patch: Partial<ActivityState>) {
  activityState = { ...activityState, ...patch }
  for (const listener of activityListeners) listener()
}

function connectAiActivity() {
  if (activitySource) return
  activitySource = new EventSource(`${MIRROR_ORIGIN}/events`)
  activitySource.onopen = () => setActivityState({ connected: true })
  activitySource.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as AutomationMirrorBroadcast
      // Replayed backlog after reconnects is already in the feed; keep only new events.
      if (typeof event.seq !== 'number' || event.seq <= lastSeenSeq) return
      lastSeenSeq = event.seq
      setActivityState({ entries: appendMirrorFeedEntry(activityState.entries, event) })
    } catch {
      // Ignore malformed events.
    }
  }
  activitySource.onerror = () => setActivityState({ connected: false })
}

function disconnectAiActivity() {
  activitySource?.close()
  activitySource = undefined
  setActivityState({ connected: false })
}

function useAiActivity(): ActivityState {
  return useSyncExternalStore(
    (onChange) => {
      activityListeners.add(onChange)
      return () => {
        activityListeners.delete(onChange)
      }
    },
    () => activityState,
  )
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function EntryRow({ entry }: { entry: MirrorFeedEntry }) {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  return (
    <Box
      onClick={() => setExpanded(!expanded)}
      style={{ cursor: 'pointer', borderBottom: '1px solid var(--mantine-color-dark-6)', padding: '6px 2px' }}
    >
      <Flex justify='space-between' align='center' gap={6} wrap='nowrap'>
        <Group gap={6} wrap='nowrap'>
          <ThemeIcon color={entry.ok ? 'green' : 'red'} variant='light' size='sm'>
            {entry.ok ? <IconCheck size={12} /> : <IconX size={12} />}
          </ThemeIcon>
          <Code style={{ fontSize: 12 }}>{entry.name}</Code>
          {entry.count > 1 && <Badge size='sm' variant='light' color='gray'>×{entry.count}</Badge>}
          {entry.errorCode && <Badge size='sm' variant='light' color='red'>{entry.errorCode}</Badge>}
        </Group>
        <Group gap={8} wrap='nowrap'>
          <Text size='xs' c='dimmed'>{formatDuration(entry.durationMs)}</Text>
          <Text size='xs' c='dimmed'>{new Date(entry.ts).toLocaleTimeString()}</Text>
        </Group>
      </Flex>
      <Collapse expanded={expanded}>
        <Stack gap={6} pt={8}>
          {entry.errorMessage && (
            <Text size='xs' c='red'>{entry.errorMessage}</Text>
          )}
          {entry.input !== undefined && Object.keys(entry.input as object).length > 0 && (
            <Box>
              <Text size='xs' c='dimmed' mb={2}>{t('AiActivityInput')}</Text>
              <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11 }}>{jsonText(entry.input)}</Code>
            </Box>
          )}
          {entry.data !== undefined && (
            <Box>
              <Text size='xs' c='dimmed' mb={2}>{t('AiActivityResult')}</Text>
              <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11 }}>{jsonText(entry.data)}</Code>
            </Box>
          )}
        </Stack>
      </Collapse>
    </Box>
  )
}

export function AiActivityButton() {
  const { t } = useTranslation('common')
  const [opened, { open, close }] = useDisclosure(false)
  const { entries, connected } = useAiActivity()
  const [snapshot, setSnapshot] = useState<{ json: string, characters: number, relics: number } | undefined>()

  useEffect(() => {
    if (opened) connectAiActivity()
    return disconnectAiActivity
  }, [opened])

  const syncSnapshot = async () => {
    try {
      const response = await fetch(`${MIRROR_ORIGIN}/snapshot`)
      const body = await response.text()
      if (!response.ok) {
        let detail = `${response.status}`
        try {
          detail = JSON.parse(body).error?.message ?? detail
        } catch {
          // Keep the status code as detail.
        }
        throw new Error(detail)
      }
      const save = JSON.parse(body) as { characters?: unknown[], relics?: unknown[] }
      setSnapshot({ json: body, characters: save.characters?.length ?? 0, relics: save.relics?.length ?? 0 })
    } catch (error) {
      Message.error(`${t('AiActivitySyncUnavailable')}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const confirmSync = async () => {
    if (!snapshot) return
    const reply = await window.hsrAutomation.call('import_save', { json: snapshot.json })
    if (reply.ok) {
      Message.success(t('AiActivitySyncDone'))
    } else {
      Message.error(reply.error.message)
    }
    setSnapshot(undefined)
  }

  return (
    <>
      <Tooltip label={t('AiActivityButtonTooltip')}>
        <Button
          variant='subtle'
          color='gray'
          onClick={open}
          aria-label={t('AiActivityButtonTooltip')}
          px={8}
        >
          <IconRobot size={18} />
        </Button>
      </Tooltip>

      <Drawer
        opened={opened}
        onClose={close}
        position='right'
        size={460}
        title={t('AiActivityTitle')}
      >
        <Stack gap='sm' h='100%'>
          <Group justify='space-between' wrap='nowrap'>
            <Badge color={connected ? 'green' : 'gray'} variant='light'>
              {connected ? t('AiActivityLive') : t('AiActivityOffline')}
            </Badge>
            <Text size='xs' c='dimmed'>{MIRROR_ORIGIN}</Text>
          </Group>
          {!connected && (
            <Text size='sm' c='dimmed'>{t('AiActivityOfflineHint')}</Text>
          )}
          <Button variant='light' onClick={syncSnapshot}>
            {t('AiActivitySync')}
          </Button>
          <ScrollArea style={{ flex: 1 }} offsetScrollbars>
            {entries.length === 0
              ? <Text size='sm' c='dimmed' ta='center' pt={24}>{t('AiActivityEmpty')}</Text>
              : entries.map((entry) => <EntryRow key={entry.seq} entry={entry} />)}
          </ScrollArea>
        </Stack>
      </Drawer>

      <Modal
        opened={snapshot !== undefined}
        onClose={() => setSnapshot(undefined)}
        title={t('AiActivitySyncTitle')}
        centered
      >
        <Text size='sm'>
          {t('AiActivitySyncConfirm', { characters: snapshot?.characters ?? 0, relics: snapshot?.relics ?? 0 })}
        </Text>
        <Group justify='flex-end' mt='md'>
          <Button variant='default' onClick={() => setSnapshot(undefined)}>
            {t('Cancel')}
          </Button>
          <Button color='red' onClick={() => void confirmSync()}>
            {t('Confirm')}
          </Button>
        </Group>
      </Modal>
    </>
  )
}
