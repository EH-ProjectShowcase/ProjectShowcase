#!/usr/bin/env node
/**
 * sync.js — Pulls approved rows from a Google Sheet, downloads & compresses
 * screenshots from Google Drive, uploads implementation zips to GitHub Releases,
 * commits everything to the repo, and writes an updated projects.json that the
 * static site consumes.
 *
 * Environment variables (all required):
 *   GOOGLE_SERVICE_ACCOUNT_JSON — full JSON key for a GCP service account
 *   SHEET_ID                    — the Google Sheets spreadsheet ID
 *   GITHUB_TOKEN                — a token with repo write access (commits + releases)
 *   REPO_OWNER                  — GitHub owner  (e.g. "rahul12043")
 *   REPO_NAME                   — GitHub repo   (e.g. "ProjectShowcase")
 */

import { google } from "googleapis";
import { Octokit } from "@octokit/rest";
import sharp from "sharp";

// ── Config ────────────────────────────────────────────────────────────
const SHEET_RANGE   = "Form Responses 1!A1:Z";
const IMG_DIR       = "site/images";
const DATA_FILE     = "site/data/projects.json";
const MAX_WIDTH     = 1280;
const JPEG_QUALITY  = 80;
const MAX_ZIP_BYTES = 50 * 1024 * 1024; // 50 MB hard cap

// ── Bootstrap clients ─────────────────────────────────────────────────
const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const auth  = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive",          // needed to delete files
  ],
});
const sheets = google.sheets({ version: "v4", auth });
const drive  = google.drive({ version: "v3", auth });

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const owner   = process.env.REPO_OWNER;
const repo    = process.env.REPO_NAME;

// ── Helpers ───────────────────────────────────────────────────────────

/** Turn any string into a filesystem-safe slug. */
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "-");
}

/** Extract a Google Drive file ID from a Drive URL. */
function extractDriveId(url) {
  if (!url) return null;
  const m = url.match(/[-\w]{25,}/);
  return m ? m[0] : null;
}

/** Download a file from Google Drive into a Buffer. */
async function downloadDriveFile(fileId) {
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

/** Compress an image buffer: resize to MAX_WIDTH, output JPEG. */
async function compressImage(buf) {
  return sharp(buf)
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}

/** Delete a file from Google Drive. */
async function deleteDriveFile(fileId) {
  try {
    await drive.files.delete({ fileId });
    console.log(`  🗑  Deleted Drive file ${fileId}`);
  } catch (err) {
    // If the service account doesn't own the file, this will 403 —
    // not fatal; the purge-after-commit step just couldn't clean up.
    console.warn(`  ⚠  Could not delete Drive file ${fileId}: ${err.message}`);
  }
}

// ── GitHub helpers (commit via REST API, no local git needed) ─────────

async function getRef(branch = "main") {
  const { data } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  return data.object.sha;
}

async function createBlob(content, encoding = "base64") {
  const { data } = await octokit.git.createBlob({ owner, repo, content, encoding });
  return data.sha;
}

async function createTree(baseTreeSha, items) {
  const { data } = await octokit.git.createTree({ owner, repo, base_tree: baseTreeSha, tree: items });
  return data.sha;
}

async function createCommit(message, treeSha, parentSha) {
  const { data } = await octokit.git.createCommit({
    owner, repo, message, tree: treeSha, parents: [parentSha],
  });
  return data.sha;
}

async function updateRef(sha, branch = "main") {
  await octokit.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha });
}

// ── GitHub Release helpers ────────────────────────────────────────────

/**
 * Get or create a GitHub Release for a given tag.
 * Returns the release ID.
 */
async function getOrCreateRelease(tag, projectTitle) {
  // Try to find existing release by tag
  try {
    const { data } = await octokit.repos.getReleaseByTag({ owner, repo, tag });
    console.log(`  📦  Found existing release for tag "${tag}" (id: ${data.id})`);
    return data.id;
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  // Create the tag reference first (pointing at HEAD)
  const headSha = await getRef();
  try {
    await octokit.git.createRef({ owner, repo, ref: `refs/tags/${tag}`, sha: headSha });
  } catch (err) {
    // Tag might already exist from a previous partial run
    if (err.status !== 422) throw err;
  }

  // Create the release
  const { data } = await octokit.repos.createRelease({
    owner,
    repo,
    tag_name: tag,
    name: `${projectTitle} — Implementation`,
    body: `Implementation zip for "${projectTitle}". Uploaded automatically by the sync pipeline.`,
    draft: false,
    prerelease: false,
  });
  console.log(`  📦  Created new release for tag "${tag}" (id: ${data.id})`);
  return data.id;
}

/**
 * Upload a zip buffer as a release asset.
 * Returns the browser_download_url for the asset.
 */
async function uploadReleaseAsset(releaseId, filename, zipBuffer) {
  // Delete any pre-existing asset with the same name (idempotent re-runs)
  try {
    const { data: assets } = await octokit.repos.listReleaseAssets({
      owner, repo, release_id: releaseId, per_page: 50,
    });
    const existing = assets.find(a => a.name === filename);
    if (existing) {
      await octokit.repos.deleteReleaseAsset({ owner, repo, asset_id: existing.id });
      console.log(`  🔄  Replaced existing asset "${filename}"`);
    }
  } catch { /* no assets yet — fine */ }

  const { data } = await octokit.repos.uploadReleaseAsset({
    owner,
    repo,
    release_id: releaseId,
    name: filename,
    data: zipBuffer,
    headers: {
      "content-type": "application/zip",
      "content-length": zipBuffer.length,
    },
  });
  return data.browser_download_url;
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  // 1. Fetch sheet data
  console.log("📋  Fetching sheet data…");
  const { data: sheetData } = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: SHEET_RANGE,
  });

  if (!sheetData.values || sheetData.values.length < 2) {
    console.log("No data in sheet.");
    return;
  }

  const [header, ...rows] = sheetData.values;
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));

  // Validate required columns exist
  const requiredCols = ["Approved", "Student Full Name", "Project Title"];
  for (const c of requiredCols) {
    if (!(c in col)) {
      console.error(`❌  Missing required column "${c}" in sheet header.`);
      console.error(`   Found columns: ${header.join(", ")}`);
      process.exit(1);
    }
  }

  // 2. Filter to approved rows
  const approved = rows.filter(r => (r[col["Approved"]] || "").toUpperCase() === "TRUE");
  if (!approved.length) {
    console.log("No approved rows.");
    return;
  }
  console.log(`Found ${approved.length} approved row(s).`);

  // 3. Load existing projects.json from the repo (if any)
  let existing = [];
  try {
    const { data: fileData } = await octokit.repos.getContent({ owner, repo, path: DATA_FILE });
    existing = JSON.parse(Buffer.from(fileData.content, "base64").toString());
  } catch { /* first run — file doesn't exist yet */ }
  const existingIds = new Set(existing.map(p => p.id));

  // 4. Process each approved row
  const newBlobs = [];          // { path, sha, mode, type } — files to commit
  const driveIdsToDelete = [];  // Drive file IDs to purge after commit
  const newProjects = [];       // project objects for projects.json

  for (const row of approved) {
    const name       = (row[col["Student Full Name"]]                  || "").trim();
    const email      = (row[col["Student Email Address"]]              || "").trim();
    const title      = (row[col["Project Title"]]                      || "").trim();
    const domain     = (row[col["Project Domain"]]                     || "").trim();
    const summary    = (row[col["Project Description"]]                || "").trim();
    const imageUrl   = (row[col["Upload Project Screenshots or Images"]] || "").trim();
    const zipUrl     = (row[col["Upload Project Source Code (Zip file)"]] || "").trim();

    const slug = slugify(`${name}-${title}`);
    if (existingIds.has(slug)) {
      console.log(`⏭  "${title}" (${slug}) already exists — skipping.`);
      continue;
    }

    console.log(`\n🔄  Processing "${title}" by ${name}…`);

    // Parse domain/tech — accept comma-separated or JSON array
    let tech = [];
    if (domain) {
      try {
        tech = JSON.parse(domain);
      } catch {
        tech = domain.split(",").map(s => s.trim()).filter(Boolean);
      }
    }

    // ── Screenshot ────────────────────────────────────────────────
    let imagePath = "images/default.webp";
    const imgDriveId = extractDriveId(imageUrl);
    if (imgDriveId) {
      try {
        const raw  = await downloadDriveFile(imgDriveId);
        const jpeg = await compressImage(raw);
        imagePath  = `images/${slug}.jpg`;
        const sha  = await createBlob(jpeg.toString("base64"), "base64");
        newBlobs.push({ path: `${IMG_DIR}/${slug}.jpg`, sha, mode: "100644", type: "blob" });
        driveIdsToDelete.push(imgDriveId);
        console.log(`  📸  Screenshot compressed → ${imagePath}`);
      } catch (err) {
        console.warn(`  ⚠  Failed to download screenshot: ${err.message}`);
        console.warn(`      Falling back to default image.`);
      }
    }

    // ── Zip (Implementation) → GitHub Release ────────────────────
    let zipDownloadUrl = "";
    const zipDriveId = extractDriveId(zipUrl);
    if (zipDriveId) {
      try {
        console.log(`  📥  Downloading zip from Drive…`);
        const zipBuffer = await downloadDriveFile(zipDriveId);

        // Size gate
        if (zipBuffer.length > MAX_ZIP_BYTES) {
          const sizeMB = (zipBuffer.length / 1024 / 1024).toFixed(1);
          console.warn(`  ⚠  Zip is ${sizeMB} MB — exceeds ${MAX_ZIP_BYTES / 1024 / 1024} MB cap. Skipping upload.`);
        } else {
          const tag = `project-${slug}`;
          const releaseId = await getOrCreateRelease(tag, title);
          const assetName = `${slug}.zip`;
          zipDownloadUrl = await uploadReleaseAsset(releaseId, assetName, zipBuffer);
          driveIdsToDelete.push(zipDriveId);
          const sizeMB = (zipBuffer.length / 1024 / 1024).toFixed(1);
          console.log(`  📦  Zip uploaded to release (${sizeMB} MB) → ${zipDownloadUrl}`);
        }
      } catch (err) {
        console.warn(`  ⚠  Failed to process zip: ${err.message}`);
      }
    }

    // Build project object matching the existing schema
    const project = {
      id: slug,
      title,
      student: name,
      email,
      domain: tech,
      summary,
      image: imagePath,
    };

    // Only add zipUrl if we actually uploaded one
    if (zipDownloadUrl) {
      project.zipUrl = zipDownloadUrl;
    }

    newProjects.push(project);
    existingIds.add(slug);
  }

  if (!newProjects.length) {
    console.log("\nNothing new to commit.");
    return;
  }

  // 5. Merge and write projects.json
  const merged = [...existing, ...newProjects];
  const jsonSha = await createBlob(
    Buffer.from(JSON.stringify(merged, null, 2)).toString("base64"),
    "base64"
  );
  newBlobs.push({ path: DATA_FILE, sha: jsonSha, mode: "100644", type: "blob" });

  // 6. Commit everything in one atomic commit
  const headSha   = await getRef();
  const treeSha   = await createTree(headSha, newBlobs);
  const commitMsg = `feat: add ${newProjects.map(p => p.title).join(", ")}`;
  const commitSha = await createCommit(commitMsg, treeSha, headSha);
  await updateRef(commitSha);
  console.log(`\n✅  Committed ${newProjects.length} project(s): ${commitSha}`);

  // 7. Purge Drive originals
  for (const id of driveIdsToDelete) {
    await deleteDriveFile(id);
  }
  console.log("🧹  Drive cleanup done.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
