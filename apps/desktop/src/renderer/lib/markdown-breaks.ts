interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
}

/**
 * Keeps each line break of the source as a line break, like the textarea the owner typed it in: Markdown alone joins
 * the lines of a paragraph. Code keeps its own lines and is left alone.
 */
export function remarkSoftBreaks() {
  return (tree: MdastNode) => splitLines(tree)
}

function splitLines(node: MdastNode): void {
  if (!node.children) return
  const children: MdastNode[] = []
  for (const child of node.children) {
    if (child.type !== 'text' || !child.value?.includes('\n')) {
      splitLines(child)
      children.push(child)
      continue
    }
    child.value.split(/\r?\n/).forEach((line, index) => {
      if (index > 0) children.push({ type: 'break' })
      if (line) children.push({ type: 'text', value: line })
    })
  }
  node.children = children
}
