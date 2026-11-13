// The privacy page's two settings (I6, e11-t07), one file so the owner changes them in one place.
//
// PRIVACY_CONTACT is where people send a deletion request or a question. Until the owner picks a
// private address it is the repository's GitHub Issues, which anyone can read, so the page warns
// against posting personal details (`isPublic`). To change it: set `url` (https: or mailto:) and
// `isPublic: false`; nothing else needs touching. DEPLOY.md §13 has the procedure behind it.

export type PrivacyContact = {
  url: string
  /** Whatever is sent there can be read by anyone: the page says not to post personal details */
  isPublic: boolean
}

/** The public repository: the source the policy can be checked against */
export const SOURCE_URL = 'https://github.com/GeneCLee6/LongTalk'

export const PRIVACY_CONTACT: PrivacyContact = { url: `${SOURCE_URL}/issues`, isPublic: true }

/** Shown as the policy's date: change it whenever the policy's text changes */
export const POLICY_UPDATED = '2026-11-13'
