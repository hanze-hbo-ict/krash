/**
 * Read-only schema explorer: schemas → tables/views → columns with types and
 * key markers. Built from native <details>/<summary> for keyboard support.
 * No inline editing, no generated queries.
 */
import { useState } from 'react'
import type { SchemaNamespace, SchemaRelation } from '../db/protocol'

interface Props {
  schema: SchemaNamespace[] | null
  stale: boolean
  /** The database failed to start. */
  unavailable?: boolean
}

const KIND_LABEL: Record<SchemaRelation['kind'], string> = {
  table: 'table',
  view: 'view',
  'materialized view': 'mat. view',
  'partitioned table': 'part. table',
  'foreign table': 'foreign',
}

export function SchemaTree({ schema, stale, unavailable }: Props) {
  // Expanded state survives schema refreshes; schemas start open, tables closed.
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const isOpen = (key: string, dflt: boolean) => open[key] ?? dflt
  const toggle = (key: string, value: boolean) => setOpen((o) => (o[key] === value ? o : { ...o, [key]: value }))

  if (!schema) return <p className="schema-empty">{unavailable ? 'The database is not available.' : 'Waiting for the database…'}</p>

  return (
    <div className="schema-tree" aria-busy={stale || undefined}>
      {schema.map((ns) => {
        const nsKey = ns.name
        return (
          <details
            key={nsKey}
            className="schema-ns"
            open={isOpen(nsKey, true)}
            onToggle={(e) => toggle(nsKey, (e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>
              <span className="tree-name">{ns.name}</span>
              <span className="tree-meta">{ns.relations.length === 1 ? '1 relation' : `${ns.relations.length} relations`}</span>
            </summary>
            {ns.relations.length === 0 ? (
              <p className="schema-empty nested">No tables or views.</p>
            ) : (
              <ul className="schema-rels">
                {ns.relations.map((rel) => {
                  const key = `${ns.name}.${rel.name}`
                  return (
                    <li key={key}>
                      <details open={isOpen(key, false)} onToggle={(e) => toggle(key, (e.currentTarget as HTMLDetailsElement).open)}>
                        <summary>
                          <span className="tree-name">{rel.name}</span>
                          {rel.kind !== 'table' && <span className="tree-kind">{KIND_LABEL[rel.kind]}</span>}
                        </summary>
                        <ul className="schema-cols" aria-label={`Columns of ${rel.name}`}>
                          {rel.columns.map((c) => (
                            <li key={c.name}>
                              <span className="col-name">{c.name}</span>
                              <span className="col-type">{c.type}</span>
                              <span className="col-flags">
                                {c.isPrimaryKey && (
                                  <abbr className="flag flag-pk" title="Primary key">
                                    PK
                                  </abbr>
                                )}
                                {c.references && (
                                  <span className="flag flag-fk" title={`Foreign key to ${c.references}`}>
                                    <abbr title="Foreign key">FK</abbr> → {c.references}
                                  </span>
                                )}
                                {c.notNull && !c.isPrimaryKey && (
                                  <abbr className="flag flag-nn" title="NOT NULL">
                                    NN
                                  </abbr>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </li>
                  )
                })}
              </ul>
            )}
          </details>
        )
      })}
    </div>
  )
}
