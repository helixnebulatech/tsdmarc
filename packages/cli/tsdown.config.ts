import { packageConfig } from '@tsdmarc/tsdown-config';
import type { UserConfig } from 'tsdown';

const config: UserConfig = packageConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
});

export default config;
