import { $createHeadingNode, $createQuoteNode, $isHeadingNode, $isQuoteNode, HeadingNode, QuoteNode } from '@lexical/rich-text'
import { $createParagraphNode, $createTextNode, $getRoot, $isParagraphNode, $isTextNode, createEditor } from 'lexical'
import { describe, expect, it } from 'vitest'
import { $createPolicyBlockNode, $isPolicyBlockNode, PolicyBlockNode } from './nodes/PolicyBlockNode'

function editor() {
  return createEditor({
    namespace: 'research-formatting-fixture',
    nodes: [HeadingNode, QuoteNode, PolicyBlockNode],
    onError(error) { throw error },
  })
}

describe('research editor supported formatting fixture', () => {
  it('round-trips headings, paragraphs, quotes, policy identity, Unicode, and supported marks', () => {
    const source = editor()
    source.update(() => {
      const bold = $createTextNode('Bold evidence').toggleFormat('bold')
      const italic = $createTextNode(' italic').toggleFormat('italic')
      const underline = $createTextNode(' underline').toggleFormat('underline')
      $getRoot().append(
        $createHeadingNode('h1').append($createTextNode('Access policy — 研究')),
        $createParagraphNode().append(bold, italic, underline),
        $createQuoteNode().append($createTextNode('Quoted source “verbatim”.')),
        $createPolicyBlockNode('policy-access', 'review').append($createTextNode('Require documented approval.')),
      )
    }, { discrete: true })

    const serialized = source.getEditorState().toJSON()
    const restored = editor()
    restored.setEditorState(restored.parseEditorState(serialized))
    restored.getEditorState().read(() => {
      const [heading, paragraph, quote, policy] = $getRoot().getChildren()
      expect($isHeadingNode(heading) && heading.getTag()).toBe('h1')
      expect(heading.getTextContent()).toBe('Access policy — 研究')
      if (!$isParagraphNode(paragraph)) throw new Error('Paragraph fixture did not round-trip')
      const marks = paragraph.getChildren()
      expect($isTextNode(marks[0]) && marks[0].hasFormat('bold')).toBe(true)
      expect($isTextNode(marks[1]) && marks[1].hasFormat('italic')).toBe(true)
      expect($isTextNode(marks[2]) && marks[2].hasFormat('underline')).toBe(true)
      expect($isQuoteNode(quote)).toBe(true)
      expect(quote.getTextContent()).toBe('Quoted source “verbatim”.')
      expect($isPolicyBlockNode(policy) && { id: policy.getPolicyId(), status: policy.getStatus() }).toEqual({
        id: 'policy-access',
        status: 'review',
      })
    })
  })
})
