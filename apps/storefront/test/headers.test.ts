import { describe, it, expect } from 'vitest'
import { securityHeaders } from '../vite.config.js'

describe("the site's security headers", () => {
  const headers = securityHeaders('https://api-shop.example.in/', 'https://shop.example.in/data')
  const csp = /Content-Security-Policy: (.*)/.exec(headers)?.[1] ?? ''
  const directive = (name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? ''

  it('apply to every page', () => {
    expect(headers.split('\n')[0]).toBe('/*')
  })

  it("run only this site's scripts and Google's sign-in", () => {
    expect(directive('script-src')).toBe("script-src 'self' https://accounts.google.com/gsi/client")
    expect(directive('object-src')).toBe("object-src 'none'")
  })

  it('talk only to the till, the uploaded copy and Google', () => {
    expect(directive('connect-src')).toBe(
      "connect-src 'self' https://api-shop.example.in https://shop.example.in https://accounts.google.com/gsi/")
  })

  it('show photos from the till and the uploaded copy', () => {
    expect(directive('img-src')).toContain('https://api-shop.example.in')
    expect(directive('img-src')).toContain('https://shop.example.in')
  })
})
