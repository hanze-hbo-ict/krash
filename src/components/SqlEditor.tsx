/**
 * CodeMirror 6 SQL editor. Deliberately minimal: highlighting, line numbers,
 * selection, undo/redo, bracket matching. No autocompletion, linting, snippets,
 * auto-closing brackets or formatting.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { PostgreSQL, sql } from '@codemirror/lang-sql'
import { tags as t } from '@lezer/highlight'
import { statementAt } from '../db/sqlLexer'

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--syntax-keyword)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syntax-number)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syntax-string)' },
  { tag: [t.typeName, t.standard(t.name), t.function(t.variableName)], color: 'var(--syntax-name)' },
  { tag: [t.lineComment, t.blockComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: t.special(t.name), color: 'var(--syntax-name)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--panel)', color: 'var(--ink)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.7' },
  '.cm-content': { caretColor: 'var(--ink)', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--gutter)', color: 'var(--muted)', border: 'none', borderRight: '1px solid var(--line)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 12px', minWidth: '36px' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--soft)', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--ink)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-matchingBracket': { backgroundColor: 'var(--soft)', outline: '1px solid var(--line-strong)' },
  '.cm-krash-error-line': { backgroundColor: 'var(--error-bg)' },
})

export interface SqlEditorHandle {
  focus(): void
  /**
   * What to run, with its start offset: the selected text if there is any (for
   * both modes, as in pgAdmin), else the statement at the cursor ("statement")
   * or the whole document ("all").
   */
  getRunTarget(mode: RunMode): { sql: string; offset: number; docText: string }
  /** Place the cursor at an offset (used for "go to error position"). */
  moveTo(offset: number): void
}

interface Props {
  initialText: string
  label: string
  onChange: (text: string) => void
  onRun: (mode: RunMode) => void
}

export type RunMode = 'statement' | 'all'

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(
  { initialText, label, onChange, onRun },
  ref,
) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onRunRef = useRef(onRun)
  onChangeRef.current = onChange
  onRunRef.current = onRun

  const extensions = useRef<Extension[]>([
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    syntaxHighlighting(highlight),
    sql({ dialect: PostgreSQL, upperCaseKeywords: false }),
    Prec.highest(
      keymap.of([
        {
          key: 'Mod-Enter',
          preventDefault: true,
          run: () => {
            onRunRef.current('statement')
            return true
          },
        },
        {
          key: 'Shift-Mod-Enter',
          preventDefault: true,
          run: () => {
            onRunRef.current('all')
            return true
          },
        },
      ]),
    ),
    // Tab indents; Escape then Tab moves focus out of the editor (CodeMirror default).
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorState.tabSize.of(4),
    theme,
    EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off', 'aria-multiline': 'true' }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChangeRef.current(u.state.doc.toString())
    }),
  ]).current

  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({ state: EditorState.create({ doc: initialText, extensions }), parent: host.current })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // External replacement of the text (e.g. Clear): start a fresh state.
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== initialText) v.setState(EditorState.create({ doc: initialText, extensions }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialText])

  useEffect(() => {
    view.current?.contentDOM.setAttribute('aria-label', label)
  }, [label])

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    getRunTarget: (mode) => {
      const v = view.current
      if (!v) return { sql: '', offset: 0, docText: '' }
      const docText = v.state.doc.toString()
      const sel = v.state.selection.main
      if (!sel.empty && docText.slice(sel.from, sel.to).trim() !== '') {
        return { sql: docText.slice(sel.from, sel.to), offset: sel.from, docText }
      }
      if (mode === 'statement') {
        const st = statementAt(docText, sel.head)
        if (st) return { sql: docText.slice(st.start, st.end), offset: st.start, docText }
      }
      return { sql: docText, offset: 0, docText }
    },
    moveTo: (offset: number) => {
      const v = view.current
      if (!v) return
      const pos = Math.max(0, Math.min(offset, v.state.doc.length))
      v.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
      v.focus()
    },
  }))

  return <div className="editor-host" ref={host} />
})

