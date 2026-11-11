export interface AnswerDoc {
  id: string
  name: string
  sql: string
}

export type ThemeChoice = 'system' | 'light' | 'dark'

export interface UiPrefs {
  sidebarCollapsed: boolean
  /** Fraction of the main column given to the editor (0.2 .. 0.8). */
  editorFraction: number
  theme: ThemeChoice
}

export interface Workspace {
  /** Format version of this persisted structure. */
  version: 1
  sessionId: string
  /** Current PGlite database (generation) for this session; null = memory only. */
  dbName: string | null
  generation: number
  docs: AnswerDoc[]
  activeId: string
  ui: UiPrefs
  /** ISO time of the last successful answer export, if any. */
  lastExportAt: string | null
}
