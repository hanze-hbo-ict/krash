import { describe, expect, it } from 'vitest'
import { MAX_NAME_LENGTH, nextQuestionName, safeFileName, sanitizeName, uniqueName } from '../../src/workspace/names'

describe('names', () => {
  it('removes control and bidi characters and collapses whitespace', () => {
    expect(sanitizeName('  a\tb\n‮c\u0000 ')).toBe('a b c')
  })
  it('limits length by code points', () => {
    expect(Array.from(sanitizeName('😀'.repeat(100))).length).toBe(MAX_NAME_LENGTH)
  })
  it('makes names unique case-insensitively', () => {
    expect(uniqueName('Question 1', ['question 1'])).toBe('Question 1 (2)')
    expect(uniqueName('   ', [], 'Answer')).toBe('Answer')
  })
  it('suggests the next question number', () => {
    expect(nextQuestionName(['Question 1', 'Question 3'])).toBe('Question 2')
  })
  it('produces safe file names', () => {
    expect(safeFileName('../Zoë: exam/1?')).toBe('Zoe-exam-1')
    expect(safeFileName('...')).toBe('krash-answers')
  })
})
