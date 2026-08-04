import { readAssetConfig } from "../lib/assetConfig.mjs";
import { buildAssets } from "../lib/buildAssets.mjs";
import { validateAssets } from "../lib/validateAssets.mjs";

export async function runBuildAndValidate(projectDir, precomputed) {
  const config = readAssetConfig(projectDir);
  const built = await buildAssets(config, projectDir, precomputed);
  await validateAssets(config, projectDir, precomputed);
  return built;
}
