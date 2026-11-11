/**
 * Answer tabs: one tab per answer script. Keyboard: Left/Right/Home/End move
 * between tabs, F2 renames, Delete asks to delete. Tabs are documents, not databases.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AnswerDoc } from '../workspace/types'
import { MAX_NAME_LENGTH } from '../workspace/names'
import { Icon } from './Icon'

interface Props {
  docs: AnswerDoc[]
  activeId: string
  onSelect: (id: string) => void
  onAdd: () => void
  onRename: (id: string, name: string) => void
  onRequestDelete: (id: string) => void
  /** id of the editor panel the tabs control */
  panelId: string
}

export function AnswerTabs({ docs, activeId, onSelect, onAdd, onRename, onRequestDelete, panelId }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  const startRename = (id: string) => {
    const doc = docs.find((d) => d.id === id)
    if (!doc) return
    setDraft(doc.name)
    setRenaming(id)
  }

  const commitRename = (save: boolean) => {
    const id = renaming
    setRenaming(null)
    if (id && save) onRename(id, draft)
    if (id) requestAnimationFrame(() => tabRefs.current.get(id)?.focus())
  }

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null
    if (e.key === 'ArrowRight') next = (index + 1) % docs.length
    else if (e.key === 'ArrowLeft') next = (index - 1 + docs.length) % docs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = docs.length - 1
    else if (e.key === 'F2') {
      e.preventDefault()
      startRename(docs[index]!.id)
      return
    } else if (e.key === 'Delete') {
      e.preventDefault()
      onRequestDelete(docs[index]!.id)
      return
    }
    if (next !== null) {
      e.preventDefault()
      const id = docs[next]!.id
      onSelect(id)
      tabRefs.current.get(id)?.focus()
    }
  }

  return (
    <div className="answer-tabs">
      <div className="tab-strip" role="tablist" aria-label="Answers">
        {docs.map((doc, i) =>
          renaming === doc.id ? (
            <form
              key={doc.id}
              className="tab-rename"
              onSubmit={(e) => {
                e.preventDefault()
                commitRename(true)
              }}
            >
              <label className="visually-hidden" htmlFor="tab-rename-input">
                New name for {doc.name}
              </label>
              <input
                id="tab-rename-input"
                ref={inputRef}
                value={draft}
                maxLength={MAX_NAME_LENGTH}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commitRename(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    commitRename(false)
                  }
                }}
              />
            </form>
          ) : (
            <button
              key={doc.id}
              ref={(el) => {
                if (el) tabRefs.current.set(doc.id, el)
                else tabRefs.current.delete(doc.id)
              }}
              type="button"
              role="tab"
              className="tab"
              id={`tab-${doc.id}`}
              aria-selected={doc.id === activeId}
              aria-controls={panelId}
              tabIndex={doc.id === activeId ? 0 : -1}
              onClick={() => onSelect(doc.id)}
              onDoubleClick={() => startRename(doc.id)}
              onKeyDown={(e) => onTabKey(e, i)}
              title={`${doc.name} — double-click or F2 to rename`}
            >
              <span className="tab-label">{doc.name}</span>
            </button>
          ),
        )}
      </div>
      <div className="tab-actions" role="group" aria-label="Answer tabs">
        <button type="button" className="icon-button" onClick={onAdd} aria-label="New answer tab" data-tooltip="New answer">
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => startRename(activeId)}
          aria-label="Rename current answer (F2)"
          data-tooltip="Rename (F2)"
        >
          <Icon name="pencil" />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => onRequestDelete(activeId)}
          aria-label="Delete current answer"
          data-tooltip="Delete answer"
          data-tooltip-pos="end"
        >
          <Icon name="trash" />
        </button>
      </div>
    </div>
  )
}
