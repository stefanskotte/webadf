/**
 * The wall clock in epoch milliseconds, for server pages and layouts that
 * read "now" once per request. Calling `Date.now()` inline in a component body
 * trips react-hooks/purity; a server component renders once per request, so
 * one read there is correct, and going through this function says so.
 */
export function nowMs(): number {
  return Date.now();
}
