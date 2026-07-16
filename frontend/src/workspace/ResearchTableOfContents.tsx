import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useEffect, useState } from 'react'
import { cx } from '../util'
import { readResearchHeadings, selectResearchHeading, type ResearchHeading } from './editorStructure'

export function ResearchTableOfContentsContent({
  headings,
  onSelect,
}: {
  headings: ResearchHeading[]
  onSelect: (key: string) => void
}) {
  return (
    <nav className="research-outline" aria-label="Document outline">
      <span className="research-outline-label mono">Contents</span>
      {headings.length === 0 ? (
        <span className="research-outline-empty">Add a heading to build this outline.</span>
      ) : (
        <ol>
          {headings.map((heading) => (
            <li key={heading.key}>
              <button
                className={cx(heading.level === 2 && 'nested')}
                type="button"
                onClick={() => onSelect(heading.key)}
              >
                {heading.text.trim() || 'Untitled heading'}
              </button>
            </li>
          ))}
        </ol>
      )}
    </nav>
  )
}

export function ResearchTableOfContents() {
  const [editor] = useLexicalComposerContext()
  const [headings, setHeadings] = useState<ResearchHeading[]>(() => readResearchHeadings(editor.getEditorState()))

  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    setHeadings(readResearchHeadings(editorState))
  }), [editor])

  return (
    <ResearchTableOfContentsContent
      headings={headings}
      onSelect={(key) => {
        if (selectResearchHeading(editor, key)) editor.focus()
      }}
    />
  )
}
