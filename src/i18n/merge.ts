/**
 * A language's two parts as one dictionary (J4, src/strings.ts): sections that are in both (a few
 * keys of `account` and `record` are on the home page) become one, and the rest is side by side.
 */
export function mergeDictionaries<H extends object, R extends object>(home: H, rest: R): H & R {
  const merged = { ...home } as Record<string, unknown>
  for (const [key, value] of Object.entries(rest)) {
    const first = merged[key]
    merged[key] =
      typeof first === 'object' && first !== null && typeof value === 'object' && value !== null
        ? { ...first, ...value }
        : value
  }
  return merged as H & R
}
