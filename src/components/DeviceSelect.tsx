import type { DeviceOption } from '../media/devices.ts'
import { strings } from '../strings.ts'
import { SelectField } from './Field.tsx'

export type DeviceChoice = 'mic' | 'cam' | 'speaker'

// A function, not a constant: the text follows the language chosen now (strings.ts)
const deviceKindName = (choice: DeviceChoice): string =>
  choice === 'mic'
    ? strings.prejoin.micLabel
    : choice === 'cam'
      ? strings.prejoin.camLabel
      : strings.prejoin.speakerLabel

/**
 * A labelled device picker (e4-t03): the pre-join screen's three, and the settings panel's (H3).
 * Devices without a label (no permission yet) get a numbered name.
 */
export function DeviceSelect({
  choice,
  options,
  value,
  onSelect,
}: {
  choice: DeviceChoice
  options: DeviceOption[]
  value: string | null
  onSelect: (choice: DeviceChoice, deviceId: string) => void
}) {
  return (
    <SelectField
      label={deviceKindName(choice)}
      value={options.length === 0 ? '' : (value ?? options[0].deviceId)}
      disabled={options.length === 0}
      onChange={(event) => onSelect(choice, event.target.value)}
    >
      {options.length === 0 ? (
        <option value="">{strings.prejoin.noDevices}</option>
      ) : (
        options.map((option, i) => (
          <option key={option.deviceId} value={option.deviceId}>
            {option.label || strings.prejoin.deviceFallback(deviceKindName(choice), i + 1)}
          </option>
        ))
      )}
    </SelectField>
  )
}
