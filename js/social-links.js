// Darwesh Group -- Social Links Registry (single source of truth).
//
// AUDIT (done before writing this file): grepped the entire repo for any
// existing official Darwesh social URL. Real, live profiles were found in
// about.html's "Follow Us" section -- these are copied verbatim below,
// never re-typed or "cleaned up," so this registry can never drift from
// the one place those URLs were actually verified:
//   Facebook   https://www.facebook.com/share/1DXgmDgqMj/?mibextid=wwXIfr
//   Instagram  https://www.instagram.com/darwesh.group?igsi=ZGZ2MHVkdjFxbWYx&utm_source=qr
//   TikTok     https://www.tiktok.com/@darwesh.group1?_r=1&_t=ZS-997ylcT8S0K
// (about.html also links a Threads profile. Threads is not one of the six
// platforms this registry's consumers were asked to support, so it is
// deliberately left out here -- adding it later is a one-line addition,
// not a redesign.)
//
// No official YouTube, LinkedIn, or X (Twitter) profile exists anywhere
// in this codebase. Their entries below carry url: null on purpose --
// this registry's shape must not change the day one of those launches.
// Never invent a URL, a handle, or a follower/engagement number here.
// Any UI reading this file MUST treat url: null as "not a real,
// navigable destination" -- never render it as a clickable/focusable
// platform, never synthesize a fallback link for it.
export const SOCIAL_LINKS = [
  {
    key: 'instagram',
    label: 'Instagram',
    handle: '@darwesh.group',
    url: 'https://www.instagram.com/darwesh.group?igsi=ZGZ2MHVkdjFxbWYx&utm_source=qr',
  },
  {
    key: 'tiktok',
    label: 'TikTok',
    handle: '@darwesh.group1',
    url: 'https://www.tiktok.com/@darwesh.group1?_r=1&_t=ZS-997ylcT8S0K',
  },
  {
    key: 'facebook',
    label: 'Facebook',
    handle: null,
    url: 'https://www.facebook.com/share/1DXgmDgqMj/?mibextid=wwXIfr',
  },
  { key: 'youtube', label: 'YouTube', handle: null, url: null },
  { key: 'linkedin', label: 'LinkedIn', handle: null, url: null },
  { key: 'x', label: 'X', handle: null, url: null },
];

// The only list any orbital/interactive UI should ever iterate over --
// platforms with no real configured URL are excluded here, at the single
// source-of-truth level, so no consumer can accidentally render one as
// if it were real.
export function getConfiguredSocialLinks() {
  return SOCIAL_LINKS.filter((s) => !!s.url);
}
