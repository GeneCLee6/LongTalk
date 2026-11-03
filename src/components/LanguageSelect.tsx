import { useId } from 'react'
import styled from 'styled-components'
import { LOCALES, isLocale, setLocale, strings, useLocale } from '../strings.ts'
import { color, fontSize, space } from '../styles/tokens.ts'
import { Select } from './Field.tsx'
import { GlobeIcon } from './icons.tsx'

/**
 * The language switch (G1, e4-t15) on the home and pre-join screens: each language named in
 * itself; the choice is remembered (strings.ts). In the room it is 更多 › 語言.
 */
export function LanguageSelect() {
  const locale = useLocale()
  const id = useId()
  return (
    <Preference>
      <GlobeIcon />
      <label htmlFor={id}>{strings.language.label}</label>
      <Select
        id={id}
        value={locale}
        onChange={(event) => {
          if (isLocale(event.target.value)) setLocale(event.target.value)
        }}
      >
        {LOCALES.map((which) => (
          <option key={which} value={which} lang={which === 'zh-TW' ? 'zh-Hant-TW' : 'en'}>
            {strings.language.names[which]}
          </option>
        ))}
      </Select>
    </Preference>
  )
}

/** An icon, a label and a small select in a row: the language and the appearance switches */
export const Preference = styled.div`
  display: flex;
  align-items: center;
  gap: ${space(2)};
  font-size: ${fontSize.small};
  color: ${color.muted};

  svg {
    flex: none;
    width: 18px;
    height: 18px;
  }
  select {
    width: auto;
    min-height: 36px;
    padding: ${space(1)} ${space(2)};
    font-size: ${fontSize.small};
  }
`
