import type { Settings } from './types'
import { streamChat, type ApiMessage } from './api/ollama'

/** The one streamed completion every generator goes through — settings plumbing lives HERE only. */
async function stream(
  settings: Settings,
  messages: ApiMessage[],
  opts?: { signal?: AbortSignal; onContent?: (delta: string) => void; onReasoning?: (delta: string) => void },
): Promise<string> {
  const { content } = await streamChat({
    baseUrl: settings.baseUrl,
    model: settings.model,
    messages,
    temperature: settings.temperature,
    topP: settings.topP,
    maxTokens: 0, // reasoning model: never cap, or content comes back empty
    signal: opts?.signal,
    handlers: { onContent: opts?.onContent, onReasoning: opts?.onReasoning },
  })
  return content
}

/** One completion with no live handlers; returns the answer content (reasoning discarded). */
const complete = (settings: Settings, messages: ApiMessage[], signal?: AbortSignal): Promise<string> =>
  stream(settings, messages, { signal })

// ----------------------------- Document generation (Typst → PDF) -----------------------------

const TYPST_SYSTEM = `You are a document-authoring engine. You write clean, professional documents in TYPST markup and output ONLY the Typst source — no explanations, no commentary, and no markdown code fences.

TYPST QUICK REFERENCE (use only what the document needs):
• Headings: "= Title" (h1), "== Section" (h2), "=== Subsection" (h3)
• Emphasis: *bold*, _italic_
• Lists: "- item" for bullets, "+ item" for numbered; indent nested items by two spaces
• Paragraph break: a blank line. Forced line break: end the line with a single backslash.
• Tables: #table(columns: 3, [A], [B], [C], [1], [2], [3])
• Inline math: $E = m c^2$ . Display math (keep the surrounding spaces): $ sum_(i=1)^n i = (n (n+1)) / 2 $
• Quote block: #quote(block: true)[ ... ]
• Page break: #pagebreak() . Horizontal rule: #line(length: 100%)
• Accent color on text: #text(fill: rgb("#5EEAD4"))[ ... ]

ALWAYS begin the document with exactly this preamble, then a title heading and the content:

#set page(margin: 2.2cm, numbering: "1")
#set text(font: "New Computer Modern", size: 11pt)
#set par(justify: true, leading: 0.72em)
#set heading(numbering: none)
#show heading: set text(fill: rgb("#241152"))

RULES:
• Output must be valid, self-contained Typst that compiles with NO external files, fonts, or images.
• Never use #image(...), #import, #include, or read any external path.
• Give the document real structure: a clear title ("= ..."), sections, and lists / tables / math where they help.
• Be accurate to the request and to any reference material. Do not attribute invented facts to the references.
• Output ONLY the Typst source, starting with the preamble above — no prose before or after.`

/** If the model wrapped its output in a ```...``` fence (often with prose around it),
 * extract the first fenced block; otherwise return the text as-is. */
export function stripCodeFences(s: string): string {
  const t = s.trim()
  const block = t.match(/```[a-zA-Z0-9+#-]*\s*\r?\n([\s\S]*?)\r?\n```/)
  if (block) return block[1].trim()
  return t
}

/** Layer an expert's persona (optional) over the format-enforcing instructions: the
 * expert shapes the content, the format rules govern the output. */
function composeSystem(persona: string | undefined, formatInstructions: string): string {
  const p = persona?.trim()
  if (!p) return formatInstructions
  return `${p}\n\n---\nYou are now producing a document. Apply your expertise and judgment to the CONTENT, but you MUST follow these output rules exactly:\n\n${formatInstructions}`
}

/** Generate a self-contained Typst document from a request (+ optional reference context). */
export async function generateTypstDoc(opts: {
  request: string
  context?: string
  persona?: string
  settings: Settings
  signal?: AbortSignal
  onContent?: (delta: string) => void
}): Promise<string> {
  const user = [
    `Create the following document:\n\n${opts.request.trim()}`,
    opts.context?.trim()
      ? `\n\nReference material to draw from (do not copy verbatim unless quoting is appropriate):\n\n${opts.context.trim()}`
      : '',
    '\n\nOutput only the Typst source.',
  ].join('')
  const content = await stream(
    opts.settings,
    [
      { role: 'system', content: composeSystem(opts.persona, TYPST_SYSTEM) },
      { role: 'user', content: user },
    ],
    { signal: opts.signal, onContent: opts.onContent },
  )
  return stripCodeFences(content)
}

/** Repair a Typst document that failed to compile, given the compiler error. */
export async function fixTypstDoc(opts: {
  source: string
  error: string
  settings: Settings
  signal?: AbortSignal
  onContent?: (delta: string) => void
}): Promise<string> {
  const user = `This Typst document failed to compile. Fix it so it compiles cleanly, changing as little as possible and preserving the content. Output ONLY the corrected Typst source.

--- Typst source ---
${opts.source}

--- Compiler error ---
${opts.error}`
  const content = await stream(
    opts.settings,
    [
      { role: 'system', content: TYPST_SYSTEM },
      { role: 'user', content: user },
    ],
    { signal: opts.signal, onContent: opts.onContent },
  )
  return stripCodeFences(content)
}

/** Generate the complete contents of a plain-text / code file (HTML, Java, Markdown, …). */
export async function generateTextDoc(opts: {
  request: string
  fileType: string
  context?: string
  persona?: string
  settings: Settings
  signal?: AbortSignal
  onContent?: (delta: string) => void
}): Promise<string> {
  const system = composeSystem(
    opts.persona,
    `You generate the complete contents of a single ${opts.fileType} file. Output ONLY the raw file contents — no explanations, no commentary, and no markdown code fences. The result must be complete, correct, and ready to save directly to a file that an IDE or editor can open and use.`,
  )
  const user = [
    `Create a ${opts.fileType} file for the following:\n\n${opts.request.trim()}`,
    opts.context?.trim() ? `\n\nReference material to draw from:\n\n${opts.context.trim()}` : '',
    `\n\nOutput only the ${opts.fileType} file contents.`,
  ].join('')
  const content = await stream(
    opts.settings,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { signal: opts.signal, onContent: opts.onContent },
  )
  return stripCodeFences(content)
}

/** Edit an existing document/file: apply an instruction to its current contents and
 * return the full updated file (Typst, HTML, code, …). */
export async function editDoc(opts: {
  current: string
  instruction: string
  fileType: string
  persona?: string
  settings: Settings
  signal?: AbortSignal
  onContent?: (delta: string) => void
}): Promise<string> {
  const base = `You are editing an existing ${opts.fileType} file. Apply the user's requested change and output the COMPLETE updated file contents — raw, with no explanations, no commentary, and no markdown code fences. Preserve everything the change doesn't touch. The result must be a valid, complete ${opts.fileType} file.`
  const system = composeSystem(opts.persona, base)
  const user = `Here is the current ${opts.fileType} file:\n\n${opts.current}\n\nRequested change:\n${opts.instruction}\n\nOutput the full updated file.`
  const content = await stream(
    opts.settings,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { signal: opts.signal, onContent: opts.onContent },
  )
  return stripCodeFences(content)
}

