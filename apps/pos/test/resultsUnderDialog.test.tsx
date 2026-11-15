import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { useRef } from 'react'
import { Results } from '../src/ui/PickList'
import { Modal } from '../src/ui/components'
import { resetModalStack } from '../src/core/modalStack'

/**
 * A search list, and the dialog a pick from it opens.
 *
 * Found at the counter: picking a family from the bill's search opened its
 * "which one?" box, and the search list stayed drawn over the box -- it is
 * put on the body so no card clips it, which also put it above every dialog.
 */

afterEach(() => { cleanup(); resetModalStack() })

function Page({ asking }: { asking: boolean }) {
  const box = useRef<HTMLInputElement>(null)
  return (
    <>
      <input ref={box} aria-label="Search" />
      <Results anchor={box} open><div>Ball Pen Black</div></Results>
      {asking && <Modal title="Which one?" onClose={() => undefined}><DialogSearch /></Modal>}
    </>
  )
}

/** A search inside the dialog: its list hangs from the dialog's own box. */
function DialogSearch() {
  const box = useRef<HTMLInputElement>(null)
  return (
    <>
      <input ref={box} aria-label="Search in the dialog" />
      <Results anchor={box} open><div>In the dialog</div></Results>
    </>
  )
}

describe('a search list under a dialog it opened', () => {
  it('steps aside while the dialog is open, and comes back after', () => {
    const { rerender } = render(<Page asking={false} />)
    expect(screen.getByText('Ball Pen Black')).toBeTruthy()
    rerender(<Page asking />)
    expect(screen.queryByText('Ball Pen Black')).toBeNull()
    // A list drawn inside the dialog is the dialog's own and stays.
    expect(screen.getByText('In the dialog')).toBeTruthy()
    rerender(<Page asking={false} />)
    expect(screen.getByText('Ball Pen Black')).toBeTruthy()
  })
})
