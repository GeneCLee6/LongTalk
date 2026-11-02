import { Children, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import styled from 'styled-components'
import { DEFAULT_GRID_GAP, gridLayout, tileAspect } from '../../shared/layout.ts'
import { strings } from '../strings.ts'
import { motion } from '../styles/tokens.ts'

interface Size {
  width: number
  height: number
}

/** The element's content box, kept current by a ResizeObserver (none in jsdom: 0 × 0) */
function useContentSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const update = (width: number, height: number) =>
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      )
    update(element.clientWidth, element.clientHeight)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect
      update(Math.floor(box.width), Math.floor(box.height))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, size }
}

/**
 * The gallery (e4-t04, AC-4.3): one cell per child, sized by `gridLayout` for the space the
 * stage has (16:9 tiles, square ones when the stage is taller than wide), re-laid out on every
 * resize. CSS places the cells (a centred, wrapping row of equal
 * cells, so the last row is centred like Zoom's) and animates the size change; JS only picks the
 * size.
 */
export function Stage({ children }: { children: ReactNode }) {
  const cells = Children.toArray(children)
  const { ref, size } = useContentSize<HTMLDivElement>()
  const grid = gridLayout({
    count: cells.length,
    ...size,
    aspect: tileAspect(size.width, size.height),
  })
  const measured = grid.tileWidth > 0
  return (
    <Area ref={ref}>
      <Grid
        aria-label={strings.room.grid}
        data-cols={grid.cols}
        data-rows={grid.rows}
        style={measured ? { width: grid.width } : undefined}
      >
        {cells.map((cell, i) => (
          <Cell
            key={(cell as { key?: string | null }).key ?? i}
            style={measured ? { width: grid.tileWidth, height: grid.tileHeight } : undefined}
            $measured={measured}
          >
            {cell}
          </Cell>
        ))}
      </Grid>
    </Area>
  )
}

const Area = styled.div`
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
`

const Grid = styled.section`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-content: center;
  gap: ${DEFAULT_GRID_GAP}px;
  max-width: 100%;
  /* With the cells: while the column count stays, the row width and the cells move together */
  transition: width ${motion.base} ease-out;
`

const Cell = styled.div<{ $measured: boolean }>`
  flex: none;
  transition:
    width ${motion.base} ease-out,
    height ${motion.base} ease-out;

  /* Before the first measurement (and in tests): a plain 16:9 cell */
  ${({ $measured }) => ($measured ? '' : 'width: 240px; aspect-ratio: 16 / 9;')}
`
