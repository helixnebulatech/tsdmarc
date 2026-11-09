// Shared tsdown setup for every published package: ESM only, declarations
// generated with oxc (isolatedDeclarations), no tsc involved.
import { defineConfig } from "tsdown";

/**
 * @param {import("tsdown").UserConfig} [overrides]
 */
export function packageConfig(overrides = {}) {
  return defineConfig({
    entry: ["src/index.ts"],
    format: "esm",
    platform: "node",
    target: "node24",
    dts: { generator: "oxc" },
    sourcemap: true,
    clean: true,
    fixedExtension: false,
    unbundle: false,
    ...overrides,
  });
}
