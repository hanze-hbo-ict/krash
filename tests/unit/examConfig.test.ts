import { describe, expect, it } from 'vitest'
import { examConfig, validateExamConfig } from '../../src/exam/examConfig'

describe('exam config', () => {
  it('ships a valid default configuration', () => {
    expect(validateExamConfig(examConfig)).toEqual([])
  })
  it('flags invalid values', () => {
    const bad = { ...examConfig, examId: 'has space', maxRows: 0, initialTabs: [] }
    expect(validateExamConfig(bad)).toHaveLength(3)
  })
  it('keeps optional assistance-like features off by default', () => {
    expect(examConfig.features.tablePreview).toBe(false)
  })
})
