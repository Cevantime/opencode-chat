import { build } from "esbuild";

await build({
  entryPoints: ["test/snapshot.test.ts", "test/integration.test.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  packages: "external",
  format: "esm",
  outdir: "dist-test",
  outExtension: { ".js": ".test.mjs" },
  sourcemap: false,
  logLevel: "info",
});
