import { LocalMemoryPanel, type LocalMemoryPanelProps } from './memory/LocalMemoryPanel'

export function ProjectMemoryView(props: Omit<LocalMemoryPanelProps, 'personal'>) {
  return <LocalMemoryPanel {...props} />
}
