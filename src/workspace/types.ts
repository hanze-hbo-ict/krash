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
  /** The PostgreSQL database this session is connected to. */
  database: string
  /** The PostgreSQL user (session_user) this session is connected as. */
  user: string
  /**
   * Databases shown in the Database pane: those the base script touched, plus
   * those created from the editor. Switching is possible between these.
   */
  databases: string[]
  ui: UiPrefs
}
