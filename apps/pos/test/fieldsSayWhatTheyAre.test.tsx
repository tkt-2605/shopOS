import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Field, Alert } from '../src/ui/components'

/**
 * What a screen reader, and a click on the words, can find.
 *
 * `Field` drew a `<label>` beside its control and tied it to nothing, so every
 * form in the app read as a row of unnamed boxes, and `Alert` put an error on
 * the screen without anything to announce it.
 */

afterEach(cleanup)

describe('a field', () => {
  it('names the box it holds', () => {
    render(<Field label="Opening cash" hint="What is in the drawer now"><input /></Field>)
    const box = screen.getByLabelText('Opening cash')
    expect(box.tagName).toBe('INPUT')
    expect(box.getAttribute('aria-describedby')).toBe(screen.getByText('What is in the drawer now').id)
  })

  it('keeps an id the box already had', () => {
    render(<Field label="Phone"><input id="phone-box" /></Field>)
    expect(screen.getByLabelText('Phone').id).toBe('phone-box')
  })

  it('leaves a button standing in for a picker alone', () => {
    render(<Field label="Customer"><button type="button">Walk-in</button></Field>)
    expect(screen.getByText('Customer').getAttribute('for')).toBeNull()
  })
})

describe('an alert', () => {
  it('is announced as an error when something went wrong, and politely otherwise', () => {
    render(<><Alert>Over the credit limit</Alert><Alert kind="ok">Saved</Alert></>)
    expect(screen.getByRole('alert').textContent).toBe('Over the credit limit')
    expect(screen.getByRole('status').textContent).toBe('Saved')
  })
})
