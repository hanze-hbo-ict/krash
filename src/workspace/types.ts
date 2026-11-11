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
  /** The text in the editor. */
  sql: string
  ui: UiPrefs
}
