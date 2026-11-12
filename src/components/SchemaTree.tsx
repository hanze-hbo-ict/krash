/**
 * Read-only schema explorer: databases → schemas → tables/views → columns with
 * their type and icons for primary key, foreign key (the relation as tooltip)
 * and nullable. Only the connected database can be inspected (one
 * connection); clicking another listed database connects to it, like psql's \c.
 * Built from native <details>/<summary> for keyboard support. No inline
 * editing, no generated queries.
 */
import { useState } from 'react'
import type { SchemaInfo, SchemaRelation } from '../db/protocol'
import { shortType } from '../app/describe'
import { Icon } from './Icon'

interface Props {
  schema: SchemaInfo | null
  /** Databases to list (the connected one is always included). */
  databases: string[]
  stale: boolean
  /** Connect to another database; absent while switching is not possible. */
  onConnect?: (database: string) => void
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

export function SchemaTree({ schema, databases, stale, unavailable, onConnect }: Props) {
  // Expanded state survives schema refreshes; schemas start open, tables closed.
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const isOpen = (key: string, dflt: boolean) => open[key] ?? dflt
  const toggle = (key: string, value: boolean) => setOpen((o) => (o[key] === value ? o : { ...o, [key]: value }))

  if (!schema) return <p className="schema-empty">{unavailable ? 'The database is not available.' : 'Waiting for the database…'}</p>

  const shown = databases.includes(schema.database) ? databases : [...databases, schema.database]
  const namespaces = <Namespaces schema={schema} isOpen={isOpen} toggle={toggle} />

  return (
    <div className="schema-tree" aria-busy={stale || undefined}>
      {shown.map((name) =>
        name !== schema.database ? (
          <div key={name} className="schema-db schema-db-other">
            <button
              type="button"
              className="tree-db-button"
              disabled={!onConnect}
              onClick={() => onConnect?.(name)}
              title={`Connect to ${name}`}
              aria-label={`Connect to database ${name}`}
            >
              <span className="tree-name">{name}</span>
              <span className="tree-meta">connect</span>
            </button>
          </div>
        ) : (
          <details
            key={name}
            className="schema-db"
            open={isOpen(`db:${name}`, true)}
            onToggle={(e) => toggle(`db:${name}`, (e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>
              <span className="tree-name">{name}</span>
              <span className="tree-meta">{shown.length > 1 ? 'database · connected' : 'database'}</span>
            </summary>
            <div className="schema-db-body">{namespaces}</div>
          </details>
        ),
      )}
    </div>
  )
}

function Namespaces({
  schema,
  isOpen,
  toggle,
}: {
  schema: SchemaInfo
  isOpen: (key: string, dflt: boolean) => boolean
  toggle: (key: string, value: boolean) => void
}) {
  return (
    <>
      {schema.namespaces.map((ns) => {
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
                              <span className="col-type">{shortType(c.type)}</span>
                              <span className="col-flags">
                                {c.isPrimaryKey && <Flag kind="pk" icon="key" label="Primary key" />}
                                {c.references && <Flag kind="fk" icon="arrow" label={`References ${c.references}`} />}
                                {!c.notNull && !c.isPrimaryKey && <Flag kind="null" icon="empty-set" label="Nullable" />}
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
    </>
  )
}

/** A column property as a small icon, with the same tooltip as the buttons and a name for screen readers. */
function Flag({ kind, icon, label }: { kind: string; icon: string; label: string }) {
  return (
    <span className={`flag flag-${kind}`} role="img" aria-label={label} data-tooltip={label} data-tooltip-pos="end">
      <Icon name={icon} />
    </span>
  )
}
