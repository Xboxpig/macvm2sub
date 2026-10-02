import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import '../src/vendor/cpamp/i18n'
const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, String(value)), removeItem: (key: string) => storage.delete(key), clear: () => storage.clear() } })
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
window.matchMedia = () => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
window.scrollTo = () => {}
Element.prototype.scrollIntoView = () => {}
Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) })
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
