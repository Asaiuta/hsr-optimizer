import { Constants } from 'lib/constants/constants'

/** Match CPU comparisons; one missing bound still leaves the other active. */
export function isCpuFilterDisabled(min: unknown, max: unknown): boolean {
  return (min === 0 && max === Constants.MAX_INT) || (min === undefined && max === undefined)
}
