import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tagName =
  process.argv[2] ?? process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
const versionMatch = tagName?.match(
  /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/,
);

if (!tagName || !versionMatch) {
  console.error(
    "Expected a release tag like v5.2.0 from argv, RELEASE_TAG, or GITHUB_REF_NAME.",
  );
  process.exitCode = 1;
} else {
  const version = versionMatch[1];
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  const packageJsonPath = resolve(repoRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  packageJson.version = version;
  writeFileSync(
    packageJsonPath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );

  const versionFilePath = resolve(repoRoot, "src", "version.ts");
  const versionFile = readFileSync(versionFilePath, "utf8");
  const nextVersionFile = versionFile.replace(
    /export const APP_VERSION = ".*";/,
    `export const APP_VERSION = ${JSON.stringify(version)};`,
  );

  if (nextVersionFile === versionFile) {
    console.error("Could not find APP_VERSION export in src/version.ts.");
    process.exitCode = 1;
  } else {
    writeFileSync(versionFilePath, nextVersionFile, "utf8");
    console.log(`Synced release version files to ${version} from ${tagName}.`);
  }
}
