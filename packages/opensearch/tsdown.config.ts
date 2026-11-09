import { packageConfig } from '@tsdmarc/tsdown-config';
import type { UserConfig } from 'tsdown';

// @tsdmarc/search-common is private (never published): it must be bundled
// into dist/, JavaScript and declarations alike.
const config: UserConfig = packageConfig({
  deps: {
    alwaysBundle: [/^@tsdmarc\/search-common(?:\/|$)/u],
    dts: { alwaysBundle: [/^@tsdmarc\/search-common(?:\/|$)/u] },
  },
});

export default config;
