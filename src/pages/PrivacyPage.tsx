import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import styled from 'styled-components'
import { POLICY_UPDATED, PRIVACY_CONTACT } from '../../shared/privacy.ts'
import { LanguageSelect } from '../components/LanguageSelect.tsx'
import { Logo } from '../components/Logo.tsx'
import { ThemeSelect } from '../components/ThemeSelect.tsx'
import { FACTS } from '../privacy/facts.ts'
import type { Block, Inline, PolicyDocument } from '../privacy/types.ts'
import { strings, useLocale, type Locale } from '../strings.ts'
import { breakpoint, color, fontSize, space } from '../styles/tokens.ts'
import { Muted, Page, Top } from './accountStyles.tsx'

// /privacy (I6, e11-t07): the privacy policy. The page is a lazy chunk and its text is a further
// lazy module per language (src/privacy/policy.*), so none of it weighs on the home page.
// A module that fails to load reaches LoadFailedBoundary, which shows 「載入失敗」.

const POLICY: Record<Locale, ReturnType<typeof lazy>> = {
  'zh-TW': lazy(() =>
    import('../privacy/policy.zh-TW.ts').then(({ policy }) => ({
      default: () => <Policy doc={policy(FACTS)} />,
    })),
  ),
  en: lazy(() =>
    import('../privacy/policy.en.ts').then(({ policy }) => ({
      default: () => <Policy doc={policy(FACTS)} />,
    })),
  ),
}

export default function PrivacyPage() {
  const Text = POLICY[useLocale()]
  return (
    <Page>
      <PolicyTop>
        <Logo size={28} />
        <Preferences>
          <ThemeSelect />
          <LanguageSelect />
          <Link to="/">{strings.account.back}</Link>
        </Preferences>
      </PolicyTop>
      <Article>
        <Suspense fallback={<p role="status">{strings.privacy.loading}</p>}>
          <Text />
        </Suspense>
      </Article>
    </Page>
  )
}

function Policy({ doc }: { doc: PolicyDocument }) {
  const { hash } = useLocation()

  useEffect(() => {
    document.title = `${doc.title} · ${strings.appName}`
    return () => {
      document.title = strings.appName
    }
  }, [doc.title])
  // The text arrives after the browser looked for /privacy#section
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView()
  }, [hash])

  return (
    <>
      <h1>{doc.title}</h1>
      <Muted>{doc.updated(POLICY_UPDATED)}</Muted>
      <Contents aria-labelledby="privacy-contents">
        <h2 id="privacy-contents">{doc.contentsTitle}</h2>
        <ol>
          {doc.sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{section.title}</a>
            </li>
          ))}
        </ol>
      </Contents>
      {doc.sections.map((section) => (
        <Section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
          <h2 id={`${section.id}-title`}>{section.title}</h2>
          {section.blocks.map((block, index) => (
            <BlockView key={index} block={block} doc={doc} />
          ))}
        </Section>
      ))}
    </>
  )
}

function BlockView({ block, doc }: { block: Block; doc: PolicyDocument }) {
  switch (block.kind) {
    case 'p':
      return <p>{inlines(block.text)}</p>
    case 'list':
      return (
        <ul>
          {block.items.map((item, index) => (
            <li key={index}>{inlines(item)}</li>
          ))}
        </ul>
      )
    case 'table':
      return <PolicyTable block={block} />
    case 'contact':
      return (
        <Contact>
          <ExternalLink href={PRIVACY_CONTACT.url}>{doc.contactLink}</ExternalLink>
          {PRIVACY_CONTACT.isPublic && <p role="note">{doc.contactPublicWarning}</p>}
        </Contact>
      )
  }
}

/**
 * A table that turns into one card per row on a phone. CSS `display` takes a table's meaning away
 * from screen readers, so the roles are written out; `data-label` gives each cell its heading.
 */
function PolicyTable({ block }: { block: Extract<Block, { kind: 'table' }> }) {
  return (
    <Table role="table">
      <caption>{block.caption}</caption>
      <thead role="rowgroup">
        <tr role="row">
          {block.columns.map((column) => (
            <th key={column} role="columnheader" scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody role="rowgroup">
        {block.rows.map((row) => (
          <tr key={row.key} role="row">
            {row.cells.map((cell, index) => (
              <td key={index} role="cell" data-label={block.columns[index]}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

function inlines(parts: readonly Inline[]): ReactNode {
  return parts.map((part, index) => {
    if (typeof part === 'string') return part
    // A file the Worker serves, not a page of this app, so a plain link
    if (part.href.endsWith('.txt')) return <a key={index} href={part.href}>{part.text}</a>
    return part.href.startsWith('/') ? (
      <Link key={index} to={part.href}>
        {part.text}
      </Link>
    ) : (
      <ExternalLink key={index} href={part.href}>
        {part.text}
      </ExternalLink>
    )
  })
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

const PolicyTop = styled(Top)`
  flex-wrap: wrap;
  gap: ${space(2)} ${space(4)};
`

const Preferences = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${space(2)} ${space(4)};
`

const Article = styled.div`
  display: grid;
  gap: ${space(5)};
  max-width: 760px;
  margin: 0 auto;
  padding: 0 ${space(4)} ${space(7)};
  /* Long key names and addresses wrap instead of widening the page on a phone */
  overflow-wrap: anywhere;
  line-height: 1.6;

  h1 {
    margin: 0;
    font-size: ${fontSize.title};
    line-height: 1.25;
  }
  h2 {
    margin: 0;
    font-size: 20px;
    line-height: 1.3;
  }
  p {
    margin: 0;
  }
  ul,
  ol {
    display: grid;
    gap: ${space(2)};
    margin: 0;
    padding-left: ${space(5)};
  }
`

const Contents = styled.nav`
  display: grid;
  gap: ${space(2)};
`

const Section = styled.section`
  display: grid;
  gap: ${space(3)};
  min-width: 0;
  scroll-margin-top: ${space(4)};
`

const Contact = styled.div`
  display: grid;
  gap: ${space(2)};
  font-weight: 600;

  p {
    font-weight: 400;
    color: ${color.muted};
  }
`

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: ${fontSize.small};

  caption {
    text-align: left;
    font-weight: 600;
    padding-bottom: ${space(2)};
  }
  th,
  td {
    padding: ${space(2)} ${space(3)} ${space(2)} 0;
    border-bottom: 1px solid ${color.line};
    text-align: left;
    vertical-align: top;
  }

  @media (max-width: ${breakpoint.phone}) {
    display: block;

    caption,
    tbody,
    tr,
    td {
      display: block;
    }
    /* Only hidden from the eye: the cards label each cell themselves */
    thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    tr {
      padding: ${space(2)} 0;
      border-bottom: 1px solid ${color.line};
    }
    td {
      padding: ${space(1)} 0;
      border-bottom: none;
    }
    td::before {
      content: attr(data-label);
      display: block;
      font-weight: 600;
      color: ${color.muted};
    }
  }
`
