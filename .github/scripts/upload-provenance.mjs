// @ts-check

// Attaches SLSA provenance to the GitHub Release of each package in
// PUBLISHED_PACKAGES that doesn't have it yet, as an `*.intoto.jsonl` asset,
// like the Vercel AI SDK does.
//
// npm already hosts the Sigstore bundle for every version published with
// provenance. The OSSF Scorecard "Signed-Releases" check only reads GitHub
// Release assets, so this copies the attestations npm generated onto the
// matching release.
//
// This is best effort: a failure never fails the release, it only logs a
// warning.

const ATTESTATION_TIMEOUT_MS = 5 * 60 * 1000;
const RELEASE_TIMEOUT_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const publishedPackages = JSON.parse(process.env.PUBLISHED_PACKAGES || "[]");

const github = (path, init = {}) =>
  fetch(path.startsWith("https://") ? path : `https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });

/** Returns the in-toto JSON Lines for a version, or null on timeout. */
const fetchProvenance = async (name, version) => {
  const url = `https://registry.npmjs.org/-/npm/v1/attestations/${name.replace("/", "%2f")}@${version}`;
  const deadline = Date.now() + ATTESTATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    if (response.ok) {
      const { attestations = [] } = await response.json();
      const envelopes = attestations
        .map((attestation) => attestation?.bundle?.dsseEnvelope)
        .filter(Boolean);
      if (envelopes.length > 0) {
        return envelopes.map((envelope) => JSON.stringify(envelope)).join("\n");
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
};

/** Changesets tags workspace packages as `name@version`. */
const findRelease = async (tag) => {
  const deadline = Date.now() + RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await github(
      `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`
    );
    if (response.ok) {
      return response.json();
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
};

let failures = 0;
for (const { name, version } of publishedPackages) {
  const tag = `${name}@${version}`;
  try {
    const release = await findRelease(tag);
    if (!release) {
      throw new Error("no GitHub release found for this tag");
    }
    const assetName = `${name.replace("@", "").replace("/", "-")}-${version}.intoto.jsonl`;
    if (release.assets?.some((asset) => asset.name === assetName)) {
      console.log(`${tag} already has ${assetName}`);
      continue;
    }
    const provenance = await fetchProvenance(name, version);
    if (!provenance) {
      throw new Error("npm has no provenance for this version");
    }
    const uploadUrl = release.upload_url.replace(
      "{?name,label}",
      `?name=${encodeURIComponent(assetName)}`
    );
    const response = await github(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/jsonl" },
      body: provenance,
    });
    if (!response.ok) {
      throw new Error(
        `upload failed: ${response.status} ${await response.text()}`
      );
    }
    console.log(`Attached ${assetName} to ${tag}`);
  } catch (error) {
    failures++;
    console.log(`::warning::Could not attach provenance to ${tag}: ${error}`);
  }
}

if (failures > 0) {
  console.log(`${failures} package(s) without provenance on their release`);
}
