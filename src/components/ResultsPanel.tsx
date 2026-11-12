/**
 * Results of the last run: one view per statement that
 * produced a result, plus a text "Messages" view. Data is rendered with safe
 * text nodes only, and in bounded pages.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ExecuteOutcome, StatementResult } from '../db/protocol'
import type { RunRecord } from '../app/runTypes'
import { describeOutcome, describeStatement, NUMERIC_OIDS } from '../app/describe'

const PAGE = 200

interface Props {
  run: RunRecord | null
  onGoToError: (offset: number) => void
  /** Shown instead of results, e.g. when the database cannot start. */
  blocking?: ReactNode
}

export function ResultsPanel({ run, onGoToError, blocking }: Props) {
  const outcome = run?.outcome ?? null
  const results = outcome?.results ?? []
  // Statements that returned rows (or COPY output) get their own view.
  const views = useMemo(() => results.filter((r) => r.columns !== null || r.copyText !== null), [results])
  const [selected, setSelected] = useState<string>('messages')
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())

  // New run: select the last result by default (or Messages if there is none).
  useEffect(() => {
    const last = views[views.length - 1]
    setSelected(last ? `r${last.index}` : 'messages')
  }, [run?.id, run?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  const tabs = [...views.map((r) => ({ key: `r${r.index}`, label: tabLabel(r, views.length) })), { key: 'messages', label: messagesLabel(run) }]

  const onKey = (e: KeyboardEvent, i: number) => {
    let n: number | null = null
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = tabs.length - 1
    if (n === null) return
    e.preventDefault()
    const key = tabs[n]!.key
    setSelected(key)
    tabRefs.current.get(key)?.focus()
  }

  const current = views.find((r) => `r${r.index}` === selected) ?? null

  return (
    <section className="panel results-panel" aria-labelledby="results-title">
      <div className="panel-header results-header">
        <h2 id="results-title">Results</h2>
        {run && (
          <div className="result-tabs" role="tablist" aria-label="Statement results">
            {tabs.map((t, i) => (
              <button
                key={t.key}
                ref={(el) => {
                  if (el) tabRefs.current.set(t.key, el)
                  else tabRefs.current.delete(t.key)
                }}
                type="button"
                role="tab"
                className="result-tab"
                aria-selected={selected === t.key}
                tabIndex={selected === t.key ? 0 : -1}
                aria-controls="results-body"
                onClick={() => setSelected(t.key)}
                onKeyDown={(e) => onKey(e, i)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        {run?.outcome && <span className="run-meta">{runMeta(run)}</span>}
      </div>
      <div className="results-body" id="results-body" role="tabpanel" tabIndex={0} aria-label="Result details">
        {blocking}
        {run?.status === 'running' && <p className="placeholder">Running…</p>}
        {run && <ErrorBox run={run} onGoToError={onGoToError} />}
        {run && outcome && selected === 'messages' && <Messages run={run} outcome={outcome} />}
        {run && outcome && current && <StatementView key={`${run.id}-${current.index}`} result={current} />}
      </div>
    </section>
  )
}

function tabLabel(r: StatementResult, count: number): string {
  const n = r.copyText !== null ? 'COPY' : `${r.totalRows} ${r.totalRows === 1 ? 'row' : 'rows'}`
  return count === 1 ? `Result · ${n}` : `${r.index} · ${n}`
}

function messagesLabel(run: RunRecord | null): string {
  const n = run?.outcome?.notices.length ?? 0
  return n > 0 ? `Messages (${n})` : 'Messages'
}

function runMeta(run: RunRecord): string {
  const o = run.outcome!
  const parts = [run.isSelection ? 'Selection' : 'Query', `${o.durationMs} ms`]
  return parts.join(' · ')
}

function ErrorBox({ run, onGoToError }: { run: RunRecord; onGoToError: (offset: number) => void }) {
  if (run.failure) {
    return (
      <div className="error-box" role="alert">
        <p className="error-title">
          <strong>{run.failure.kind === 'cancelled' ? 'Stopped' : run.failure.kind === 'crash' ? 'PostgreSQL stopped' : 'Problem'}</strong>
        </p>
        <p>{run.failure.message.replace(/^Stopped\. /, '')}</p>
        {run.failure.detail && <p className="error-detail">{run.failure.detail}</p>}
      </div>
    )
  }
  const err = run.outcome?.error
  if (!err) return null
  const fromKrash = err.code === 'KRASH'
  return (
    <div className="error-box" role="alert">
      <p className="error-title">
        <strong>{fromKrash ? 'Not run' : `${err.severity}:`}</strong> <span className="error-message">{err.message}</span>
      </p>
      {run.errorLocation && (
        <p>
          <button type="button" className="link-button" onClick={() => onGoToError(run.errorLocation!.offset)}>
            Line {run.errorLocation.line}, column {run.errorLocation.col}
          </button>
          {run.errorLocation.text && <code className="error-near"> {run.errorLocation.text}</code>}
        </p>
      )}
      {err.detail && <p className="error-detail">DETAIL: {err.detail}</p>}
      {err.hint && <p className="error-detail">HINT: {err.hint}</p>}
      {err.where && <p className="error-detail">CONTEXT: {err.where}</p>}
      {err.internalQuery && (
        <p className="error-detail">
          QUERY: <code>{err.internalQuery}</code>
        </p>
      )}
      {!fromKrash && err.code && <p className="error-code">SQLSTATE {err.code}</p>}
      {run.outcome && <PartialNote outcome={run.outcome} />}
    </div>
  )
}

function PartialNote({ outcome }: { outcome: ExecuteOutcome }) {
  const done = outcome.statementCount
  if (!outcome.error || outcome.error.code === 'KRASH') return null
  return (
    <p className="error-partial">
      {done === 0
        ? 'No statement of this run completed.'
        : `${done} statement${done === 1 ? '' : 's'} completed before statement ${outcome.errorStatementIndex} failed. `}
      {done > 0 &&
        (outcome.txStatus === 'E'
          ? 'You are inside a transaction that is now aborted: run ROLLBACK before continuing.'
          : 'PostgreSQL runs a multi-statement Run as one implicit transaction, so changes made earlier in this Run were rolled back unless the script committed them with an explicit COMMIT.')}
      {done === 0 && outcome.txStatus === 'E' && ' You are inside a transaction that is now aborted: run ROLLBACK before continuing.'}
    </p>
  )
}

function Messages({ run, outcome }: { run: RunRecord; outcome: ExecuteOutcome }) {
  const lines = describeOutcome(run, outcome)
  return (
    <div className="messages" aria-live="off">
      <ol className="message-list">
        {lines.map((l, i) => (
          <li key={i} className={`message message-${l.level}`}>
            <span className="message-level">{l.label}</span>
            <span className="message-text">{l.text}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function StatementView({ result }: { result: StatementResult }) {
  if (result.copyText !== null) {
    return (
      <div className="copy-output">
        <p className="result-summary">{describeStatement(result)}</p>
        <pre>{result.copyText}</pre>
        {result.copyTruncated && <p className="notice">Output truncated for display.</p>}
      </div>
    )
  }
  return <ResultTable result={result} />
}

/** Short values never wrap (dates, numbers); long text wraps within 60ch. */
function cellClass(numeric: boolean, v: string): string | undefined {
  const long = v.length > 40 || v.includes('\n')
  if (numeric) return 'num'
  return long ? 'wrap' : undefined
}

function ResultTable({ result }: { result: StatementResult }) {
  const [shown, setShown] = useState(PAGE)
  const cols = result.columns ?? []
  const rows = result.rows.slice(0, shown)
  const numeric = cols.map((c) => NUMERIC_OIDS.has(c.typeOid))
  return (
    <div className="result-table-wrap">
      <p className="result-summary">
        {describeStatement(result)}
        {result.rowsTruncated && (
          <>
            {' '}
            <strong className="notice-inline">
              Showing the first {result.rows.length.toLocaleString('en')} of {result.totalRows.toLocaleString('en')} rows.
            </strong>
          </>
        )}
        {result.cellsTruncated && <strong className="notice-inline"> Some long values are cut off.</strong>}
      </p>
      <div className="table-scroll" tabIndex={0} role="region" aria-label={`Result table, ${result.rows.length} rows shown`}>
        <table className="result-table">
          <thead>
            <tr>
              <th scope="col" className="rownum">
                <span className="visually-hidden">Row number</span>
              </th>
              {cols.map((c, i) => (
                <th scope="col" key={i} title={c.typeName ?? undefined} className={numeric[i] ? 'num' : undefined}>
                  <span className="col-head">{c.name}</span>
                  {c.typeName && <span className="col-head-type">{c.typeName}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                <th scope="row" className="rownum">
                  {r + 1}
                </th>
                {row.map((v, i) =>
                  v === null ? (
                    <td key={i} className="null">
                      <span aria-label="SQL NULL">NULL</span>
                    </td>
                  ) : (
                    <td key={i} className={cellClass(numeric[i]!, v)}>
                      {v}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {cols.length > 0 && result.rows.length === 0 && <p className="placeholder">No rows.</p>}
      </div>
      {shown < result.rows.length && (
        <button type="button" className="show-more" onClick={() => setShown((s) => s + PAGE)}>
          Show {Math.min(PAGE, result.rows.length - shown)} more rows
        </button>
      )}
    </div>
  )
}
