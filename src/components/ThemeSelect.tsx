import { useId } from 'react'
import { strings } from '../strings.ts'
import { THEME_CHOICES, isThemeChoice, setTheme, useTheme } from '../styles/theme.ts'
import { Select } from './Field.tsx'
import { ThemeIcon } from './icons.tsx'
import { Preference } from './LanguageSelect.tsx'

/**
 * Light, dark or the system's (G5, AC-4.8), next to the language on the home and pre-join
 * screens; remembered (styles/theme.ts). The room is dark whatever is chosen.
 */
export function ThemeSelect() {
  const theme = useTheme()
  const id = useId()
  return (
    <Preference>
      <ThemeIcon />
      <label htmlFor={id}>{strings.theme.label}</label>
      <Select
        id={id}
        value={theme}
        onChange={(event) => {
          if (isThemeChoice(event.target.value)) setTheme(event.target.value)
        }}
      >
        {THEME_CHOICES.map((which) => (
          <option key={which} value={which}>
            {strings.theme.names[which]}
          </option>
        ))}
      </Select>
    </Preference>
  )
}
