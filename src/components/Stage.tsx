import {
  Children,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import styled from 'styled-components'
import {
  clampPage,
  DEFAULT_GRID_GAP,
  GALLERY_PAGE_SIZE,
  galleryIsPaged,
  gallerySide,
  gridLayout,
  pagedLayout,
  pageRange,
  pagesInView,
  PHONE_PAGE_SIZE,
  shareLayout,
  sideTile,
  speakerLayout,
  tileAspect,
  type PagesInView,
  type StripSide,
} from '../../shared/layout.ts'
import { strings } from '../strings.ts'
import { color, fontSize, media, motion, radius, space } from '../styles/tokens.ts'
import { ChevronLeftIcon, ChevronRightIcon } from './icons.tsx'
import {
  TileSightContext,
  TileVisibleContext,
  useReducedMotion,
  type TileSight,
} from './layoutContext.ts'

/**
 * grid: the gallery (desktop; past 16 tiles in pages of 16, L1); paged: four tiles a page, swiped sideways (a phone held upright);
 * speaker: the speaker (or the pinned or spotlighted member) big and the others in a strip (a
 * phone held sideways; the desktop's 演講者 from G2)
 */
export type StageMode = 'grid' | 'paged' | 'speaker'

export interface StageProps {
  /** One tile per member, keyed */
  children: ReactNode
  mode?: StageMode
  /** The speaker layout's big tile: an index into the children (shared/layout.ts stageFocus) */
  speaker?: number
  /**
   * Who speaks, for a desktop's paged gallery (L1, e10-t02): an index into the children; their tile
   * moves to the column beside it while their page is out of view. Null: nobody has yet
   */
  sideSpeaker?: number | null
  /** Where the speaker layout's strip goes: `bottom` on a desktop (G2), `auto` on phones */
  stripSide?: StripSide
  /**
   * Someone shares the screen (e3-t05, e4-t08): the share tile takes the main area and every
   * child goes in the strip beside it, whatever the mode
   */
  share?: ReactNode
}

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

type Cells = ReturnType<typeof Children.toArray>

const keyOf = (cell: Cells[number], i: number) => (cell as { key?: string | null }).key ?? i

/**
 * The stage (e4-t04, e4-t07; AC-4.3, AC-4.6): one cell per child, laid out by `shared/layout.ts`
 * for the space the stage has, re-laid out on every resize. JS only picks sizes; CSS places the
 * cells and animates the change.
 */
export function Stage({
  children,
  mode = 'grid',
  speaker = 0,
  sideSpeaker = null,
  stripSide = 'auto',
  share,
}: StageProps) {
  const cells = Children.toArray(children)
  if (share) return <ShareStage share={share} cells={cells} />
  if (mode === 'paged') return <PagedStage cells={cells} />
  if (mode === 'speaker' && cells.length > 1) {
    return (
      <SpeakerStage cells={cells} speaker={clampPage(speaker, cells.length)} side={stripSide} />
    )
  }
  if (mode === 'grid' && galleryIsPaged(cells.length)) {
    return <PagedStage cells={cells} pageSize={GALLERY_PAGE_SIZE} sideSpeaker={sideSpeaker} />
  }
  return <GridStage cells={cells} />
}

/**
 * The gallery: 16:9 tiles (square ones when the stage is taller than wide) in a centred,
 * wrapping row of equal cells, so the last row is centred like Zoom's
 */
function GridStage({ cells }: { cells: Cells }) {
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
        data-mode="grid"
        data-cols={grid.cols}
        data-rows={grid.rows}
        style={measured ? { width: grid.width } : undefined}
      >
        {cells.map((cell, i) => (
          <Cell
            key={keyOf(cell, i)}
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

const sameView = (a: PagesInView, b: PagesInView) =>
  a.first === b.first && a.last === b.last && a.current === b.current

/**
 * A phone held upright (e4-t07): pages of four tiles side by side in a scroller that snaps a
 * page at a time, so a swipe turns the page with the browser's own momentum. Dots under it show
 * where you are and turn the page; with a mouse there are previous / next buttons too, and the
 * arrow keys, Page Up / Down, Home and End work once the stage has focus. Tiles on pages out of
 * view show no video (TileVisibleContext); their sound plays on (MemberAudio).
 *
 * A desktop's large room (L1, e10-t02) is the same with 16 tiles a page, no animation when a page
 * is turned (the new page's cameras are asked for at once) and a column on the right: whoever
 * speaks on a page out of view has their tile there. The column stays while the gallery is paged,
 * so the tiles never change size. The pointer on a button to another page subscribes its cameras
 * ahead (TileSightContext `near`, at their lowest layer); there is no other subscribing ahead, or
 * a room of two pages would receive everyone.
 */
function PagedStage({
  cells,
  pageSize = PHONE_PAGE_SIZE,
  sideSpeaker = null,
}: {
  cells: Cells
  pageSize?: number
  sideSpeaker?: number | null
}) {
  const desktop = pageSize === GALLERY_PAGE_SIZE
  const { ref: stageRef, size: stageSize } = useContentSize<HTMLDivElement>()
  const { ref, size } = useContentSize<HTMLElement>()
  const hintId = useId()
  const reducedMotion = useReducedMotion()
  const layout = pagedLayout({
    count: cells.length,
    pageSize,
    ...size,
    aspect: tileAspect(size.width, size.height),
  })
  const { pages } = layout
  const [intent, setIntent] = useState<number | null>(null)
  const [view, setView] = useState<PagesInView>({ first: 0, last: 0, current: 0 })
  const current = clampPage(view.current, pages)
  const page = useRef(current)
  useLayoutEffect(() => {
    page.current = current
  })

  // A new page width (rotation, a resized window) or fewer pages: stay on the same page. Only
  // then: following the scroll is onScroll's job.
  useLayoutEffect(() => {
    const scroller = ref.current
    if (!scroller || size.width === 0) return
    const target = clampPage(page.current, pages)
    scroller.scrollLeft = target * size.width
    const next = { first: target, last: target, current: target }
    setView((was) => (sameView(was, next) ? was : next))
  }, [ref, size.width, pages])

  const onScroll = () => {
    const scroller = ref.current
    if (!scroller) return
    const next = pagesInView(scroller.scrollLeft, scroller.clientWidth, pages)
    setView((was) => (sameView(was, next) ? was : next))
  }

  const goTo = (to: number) => {
    const target = clampPage(to, pages)
    setView({ first: target, last: target, current: target })
    const scroller = ref.current
    if (!scroller) return
    const left = target * scroller.clientWidth
    if (typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({ left, behavior: reducedMotion || desktop ? 'auto' : 'smooth' })
    } else {
      scroller.scrollLeft = left
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (pages < 2 || event.target !== event.currentTarget) return
    const keys: Partial<Record<string, number>> = {
      ArrowRight: current + 1,
      PageDown: current + 1,
      ArrowLeft: current - 1,
      PageUp: current - 1,
      Home: 0,
      End: pages - 1,
    }
    const target = keys[event.key]
    if (target === undefined) return
    event.preventDefault()
    goTo(target)
  }

  const measured = layout.tileWidth > 0
  const paged = pages > 1
  const side = desktop ? gallerySide(stageSize.width, stageSize.height) : null
  const sideIndex = desktop ? sideTile(sideSpeaker, view, cells.length, pageSize) : null
  const sideCell = sideIndex === null ? null : cells[sideIndex]
  const sightOf = (index: number, visible: boolean): TileSight =>
    visible ? 'shown' : index === intent ? 'near' : 'away'
  /** The pointer or the focus on a button to `page`: its cameras are worth having ahead */
  const aheadTo = (page: number) => ({
    onPointerEnter: () => setIntent(page),
    onPointerLeave: () => setIntent(null),
    onFocus: () => setIntent(page),
    onBlur: () => setIntent(null),
  })
  return (
    <PagedArea ref={stageRef}>
      <PagedRow>
        <Pager
          ref={ref}
          aria-label={strings.room.grid}
          aria-roledescription={paged ? strings.stage.pager : undefined}
          aria-describedby={paged ? hintId : undefined}
          data-mode="paged"
          data-cols={layout.cols}
          data-rows={layout.rows}
          data-pages={pages}
          data-page={current}
          tabIndex={paged ? 0 : undefined}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
        >
          {Array.from({ length: Math.max(pages, 1) }, (_, index) => {
            const { start, end } = pageRange(index, cells.length, pageSize)
            const visible = index >= view.first && index <= view.last
            return (
              <PageBox
                key={index}
                role={paged ? 'group' : undefined}
                aria-label={paged ? strings.stage.page(index + 1, pages) : undefined}
                data-visible={visible || undefined}
              >
                <PageGrid style={measured ? { width: layout.width } : undefined}>
                  {cells.slice(start, end).map((cell, i) =>
                    start + i === sideIndex ? null : (
                      <Cell
                        key={keyOf(cell, start + i)}
                        style={
                          measured
                            ? { width: layout.tileWidth, height: layout.tileHeight }
                            : undefined
                        }
                        $measured={measured}
                      >
                        <TileVisibleContext.Provider value={visible}>
                          <TileSightContext.Provider value={sightOf(index, visible)}>
                            {cell}
                          </TileSightContext.Provider>
                        </TileVisibleContext.Provider>
                      </Cell>
                    ),
                  )}
                </PageGrid>
              </PageBox>
            )
          })}
        </Pager>
        {side && (
          <Side
            role="group"
            aria-label={strings.stage.sideSpeaker}
            style={{ width: side.tileWidth }}
          >
            {sideCell && sideIndex !== null && (
              <>
                <SideLabel>{strings.stage.sideSpeaker}</SideLabel>
                <Cell
                  key={keyOf(sideCell, sideIndex)}
                  data-side-speaker=""
                  style={{ width: side.tileWidth, height: side.tileHeight }}
                  $measured
                >
                  {sideCell}
                </Cell>
              </>
            )}
          </Side>
        )}
      </PagedRow>
      {paged && (
        <PagerBar>
          <Hint id={hintId}>{strings.stage.hint}</Hint>
          <Step
            type="button"
            aria-label={strings.stage.previous}
            disabled={current === 0}
            onClick={() => goTo(current - 1)}
            {...aheadTo(current - 1)}
          >
            <ChevronLeftIcon />
          </Step>
          <Dots role="group" aria-label={strings.stage.pages}>
            {Array.from({ length: pages }, (_, index) => (
              <Dot
                key={index}
                type="button"
                aria-label={strings.stage.page(index + 1, pages)}
                aria-current={index === current ? 'true' : undefined}
                onClick={() => goTo(index)}
                {...aheadTo(index)}
              />
            ))}
          </Dots>
          <Step
            type="button"
            aria-label={strings.stage.next}
            disabled={current === pages - 1}
            onClick={() => goTo(current + 1)}
            {...aheadTo(current + 1)}
          >
            <ChevronRightIcon />
          </Step>
        </PagerBar>
      )}
    </PagedArea>
  )
}

/**
 * A phone held sideways (e4-t07, PRD e4 「橫式自動切成演講者」): the speaker's tile as big as
 * fits, everyone else in a strip on the right that scrolls when they do not all fit. On a desktop
 * (G2, e4-t10) the strip is a row under the speaker (`side` bottom).
 */
function SpeakerStage({
  cells,
  speaker,
  side,
}: {
  cells: Cells
  speaker: number
  side: StripSide
}) {
  const { ref, size } = useContentSize<HTMLDivElement>()
  const layout = speakerLayout({ count: cells.length, ...size, side })
  const measured = layout.main.width > 0
  const { strip } = layout
  const bottom = strip?.side === 'bottom'
  const main = cells[speaker]
  return (
    <Area ref={ref}>
      <SpeakerRow aria-label={strings.room.grid} data-mode="speaker" $bottom={bottom}>
        <Cell
          key={keyOf(main, speaker)}
          data-speaker=""
          style={measured ? { ...layout.main } : undefined}
          $measured={measured}
        >
          {main}
        </Cell>
        <Strip role="group" aria-label={strings.stage.strip} $bottom={bottom}>
          <StripInner $bottom={bottom}>
            {cells.map((cell, i) =>
              i === speaker ? null : (
                <Cell
                  key={keyOf(cell, i)}
                  style={
                    measured && strip
                      ? { width: strip.tileWidth, height: strip.tileHeight }
                      : undefined
                  }
                  $measured={measured}
                >
                  {cell}
                </Cell>
              ),
            )}
          </StripInner>
        </Strip>
      </SpeakerRow>
    </Area>
  )
}

/**
 * Someone shares (e3-t05, e4-t08; DESIGN.md §4.3 「有分享」): the share in the main area, about
 * three quarters of a wide stage, everyone in a column on the right; on a tall stage (a phone
 * held upright) the share on top and everyone in a row under it. The strip scrolls when people
 * do not fit.
 */
function ShareStage({ share, cells }: { share: ReactNode; cells: Cells }) {
  const { ref, size } = useContentSize<HTMLDivElement>()
  const layout = shareLayout({ count: cells.length, ...size })
  const measured = layout.main.width > 0
  const { strip } = layout
  const bottom = strip?.side === 'bottom'
  return (
    <Area ref={ref}>
      <SpeakerRow aria-label={strings.room.grid} data-mode="share" $bottom={bottom}>
        <MainCell data-share="" style={measured ? { ...layout.main } : undefined}>
          {share}
        </MainCell>
        {cells.length > 0 && (
          <Strip role="group" aria-label={strings.stage.strip} $bottom={bottom}>
            <StripInner $bottom={bottom}>
              {cells.map((cell, i) => (
                <Cell
                  key={keyOf(cell, i)}
                  style={
                    measured && strip
                      ? { width: strip.tileWidth, height: strip.tileHeight }
                      : undefined
                  }
                  $measured={measured}
                >
                  {cell}
                </Cell>
              ))}
            </StripInner>
          </Strip>
        )}
      </SpeakerRow>
    </Area>
  )
}

/** The share's box: before the first measurement (and in tests) it fills the stage */
const MainCell = styled.div`
  flex: none;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  transition:
    width ${motion.base} ease-out,
    height ${motion.base} ease-out;
`

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

/** One page's tiles: the gallery's centred, wrapping row (not a landmark of its own) */
const PageGrid = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-content: center;
  gap: ${DEFAULT_GRID_GAP}px;
  max-width: 100%;
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

const PagedArea = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
`

/** The pager and, on a desktop's large room, the column beside it */
const PagedRow = styled.div`
  flex: 1;
  min-height: 0;
  display: flex;
  gap: ${DEFAULT_GRID_GAP}px;
`

/** The column beside a large room's pages: the speaker on another page, centred (L1) */
const Side = styled.div`
  flex: none;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: ${space(1)};
`

const SideLabel = styled.span`
  color: ${color.muted};
  font-size: ${fontSize.nameplate};
  text-align: center;
`

/** Pages side by side; one swipe snaps one page (scroll-snap-stop), no scrollbar */
const Pager = styled.section`
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow-x: auto;
  overflow-y: hidden;
  scroll-snap-type: x mandatory;
  overscroll-behavior: contain;
  scrollbar-width: none;
  /* Sideways swipes turn the page; nothing else moves (the room never scrolls) */
  touch-action: pan-x;
  border-radius: ${radius.tile};

  &::-webkit-scrollbar {
    display: none;
  }
`

const PageBox = styled.div`
  flex: 0 0 100%;
  min-width: 0;
  display: grid;
  place-items: center;
  scroll-snap-align: start;
  scroll-snap-stop: always;
`

const PagerBar = styled.div`
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: ${space(1)};
  padding-top: ${space(1)};
`

const Dots = styled.div`
  display: flex;
  align-items: center;
`

/** An 8 px dot in a 24 px target (WCAG 2.5.8); the current page's in the brand colour */
const Dot = styled.button`
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;

  &::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${color.line};
    transition: background ${motion.fast};
  }
  &[aria-current='true']::before {
    background: ${color.primary};
  }
`

/** Previous / next: for a mouse; touch screens swipe (and have the dots) */
const Step = styled.button`
  display: none;
  place-items: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: ${color.fg};
  cursor: pointer;

  svg {
    width: 18px;
    height: 18px;
  }
  &:hover:not(:disabled) {
    background: ${color.hover};
  }
  &:disabled {
    opacity: 0.35;
    cursor: default;
  }

  @media ${media.finePointer} {
    display: inline-grid;
  }
`

const Hint = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`

const SpeakerRow = styled.section<{ $bottom: boolean }>`
  display: flex;
  flex-direction: ${({ $bottom }) => ($bottom ? 'column' : 'row')};
  align-items: center;
  justify-content: center;
  gap: ${DEFAULT_GRID_GAP}px;
  /* The stage's exact box: the strip scrolls within it instead of growing it */
  position: absolute;
  inset: 0;
`

/** Scrolls when everyone does not fit; centred when they do (StripInner's auto margins) */
const Strip = styled.div<{ $bottom: boolean }>`
  display: flex;
  flex-direction: ${({ $bottom }) => ($bottom ? 'row' : 'column')};
  ${({ $bottom }) =>
    $bottom ? 'max-width: 100%; overflow-x: auto;' : 'max-height: 100%; overflow-y: auto;'}
  overscroll-behavior: contain;
  scrollbar-width: none;
  border-radius: ${radius.tile};

  &::-webkit-scrollbar {
    display: none;
  }
`

const StripInner = styled.div<{ $bottom: boolean }>`
  display: flex;
  flex-direction: ${({ $bottom }) => ($bottom ? 'row' : 'column')};
  gap: ${DEFAULT_GRID_GAP}px;
  margin: auto;
`
