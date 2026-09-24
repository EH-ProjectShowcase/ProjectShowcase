#!/usr/bin/env node
/**
 * sync.js — Pulls approved rows from a Google Sheet, downloads & compresses
 * screenshots from Google Drive, creates a separate GitHub repo per project
 * in the org with the unzipped source code, commits screenshots and
 * projects.json to the showcase repo, and auto-deploys via GitHub Pages.
 *
 * Environment variables (all required):
 *   GOOGLE_SERVICE_ACCOUNT_JSON — full JSON key for a GCP service account
 *   SHEET_ID                    — the Google Sheets spreadsheet ID
 *   GH_PAT                     — Personal Access Token with repo + org scope
 *   REPO_OWNER                  — GitHub owner  (e.g. "MyCollege-Projects")
 *   REPO_NAME                   — GitHub repo   (e.g. "ProjectShowcase")
 *   ORG_NAME                    — GitHub org where project repos are created
 *                                 (defaults to REPO_OWNER if not set)
 */

import { google } from "googleapis";
import { Octokit } from "@octokit/rest";
import sharp from "sharp";
import AdmZip from "adm-zip";

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

const octokit = new Octokit({ auth: process.env.GH_PAT });
const owner   = process.env.REPO_OWNER;
const repo    = process.env.REPO_NAME;
const orgName = process.env.ORG_NAME || owner;

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

/**
 * Bypass Google Drive's large-file virus-scan warning page.
 * Drive returns an HTML "Download anyway?" page for files it can't scan.
 * The bypass is to pass `confirm=1` (same as the "Download anyway" button),
 * using a fresh OAuth token from the same auth client.
 */
async function downloadDriveFileWithConfirm(fileId) {
  const tokenRes = await auth.getAccessToken();
  const token = tokenRes.token;
  const url = `https://drive.google.com/uc?export=download&confirm=1&id=${fileId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive confirm download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
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

// ── GitHub helpers (commit to the SHOWCASE repo via REST API) ─────────

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

// ── Org repo helpers (create a repo per project, commit unzipped files) ──

/**
 * Create a public repo in the org for a student project.
 * If the repo already exists, returns its URL without re-creating.
 */
async function createProjectRepo(slug, title, summary, studentName, tech) {
  // Check if repo already exists
  try {
    const { data } = await octokit.repos.get({ owner: orgName, repo: slug });
    console.log(`  📁  Repo ${orgName}/${slug} already exists → ${data.html_url}`);
    return data.html_url;
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  // Build a nice description
  const desc = [
    title,
    studentName ? `by ${studentName}` : "",
    tech.length ? `(${tech.join(", ")})` : "",
  ].filter(Boolean).join(" — ").slice(0, 350);

  const { data } = await octokit.repos.createInOrg({
    org: orgName,
    name: slug,
    description: desc,
    homepage: "",
    private: false,
    has_issues: false,
    has_projects: false,
    has_wiki: false,
    auto_init: false,  // we create the initial commit ourselves
  });

  console.log(`  📁  Created repo ${orgName}/${slug} → ${data.html_url}`);
  return data.html_url;
}

/**
 * Unzip a buffer and commit all files to a repo as its initial commit.
 * If the zip has a single root folder (e.g. project-name/), it is stripped
 * so files land at the repo root.
 *
 * Also generates a README.md with project info if one doesn't exist in the zip.
 *
 * Returns the commit SHA, or null if the zip was empty.
 */
async function commitZipToRepo(targetRepo, zipBuffer, { title, studentName, summary, tech }) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  // ── Detect single root folder (very common in zips) ───────────
  const topLevelNames = new Set();
  for (const entry of entries) {
    const first = entry.entryName.split("/")[0];
    if (first) topLevelNames.add(first);
  }
  // Strip prefix only if every entry lives under one folder
  const hasSingleRoot = topLevelNames.size === 1
    && entries.some(e => e.isDirectory && e.entryName === [...topLevelNames][0] + "/");
  const stripPrefix = hasSingleRoot ? [...topLevelNames][0] + "/" : "";
  if (stripPrefix) {
    console.log(`  📂  Stripping zip root folder: "${stripPrefix.slice(0, -1)}/"`);
  }

  // ── Create blobs for every file ───────────────────────────────
  const treeItems = [];
  let hasReadme = false;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    let filePath = entry.entryName;

    // Strip the single root folder prefix
    if (stripPrefix && filePath.startsWith(stripPrefix)) {
      filePath = filePath.slice(stripPrefix.length);
    }
    if (!filePath) continue;

    // Track if zip already contains a README
    if (/^readme\.md$/i.test(filePath)) hasReadme = true;

    // Skip OS junk files
    if (filePath.startsWith("__MACOSX/") || filePath.endsWith(".DS_Store") || filePath === "Thumbs.db") {
      continue;
    }

    const content = entry.getData().toString("base64");
    const { data: blob } = await octokit.git.createBlob({
      owner: orgName,
      repo: targetRepo,
      content,
      encoding: "base64",
    });

    treeItems.push({ path: filePath, mode: "100644", type: "blob", sha: blob.sha });
  }

  if (!treeItems.length) {
    console.warn(`  ⚠  Zip contains no files — skipping repo commit.`);
    return null;
  }

  // ── Auto-generate README.md if zip didn't include one ─────────
  if (!hasReadme) {
    const readme = [
      `# ${title}`,
      "",
      `**Student:** ${studentName}`,
      tech.length ? `**Tech Stack:** ${tech.join(", ")}` : "",
      "",
      summary || "",
      "",
      "---",
      `*This repository was automatically created by the [Project Showcase](https://github.com/${owner}/${repo}) pipeline.*`,
      "",
    ].filter(line => line !== undefined).join("\n");

    const { data: readmeBlob } = await octokit.git.createBlob({
      owner: orgName,
      repo: targetRepo,
      content: Buffer.from(readme).toString("base64"),
      encoding: "base64",
    });
    treeItems.push({ path: "README.md", mode: "100644", type: "blob", sha: readmeBlob.sha });
  }

  console.log(`  📄  ${treeItems.length} file(s) to commit`);

  // ── Create tree → commit → branch ref ─────────────────────────
  // No base_tree because this is the initial commit (empty repo)
  const { data: tree } = await octokit.git.createTree({
    owner: orgName,
    repo: targetRepo,
    tree: treeItems,
  });

  const { data: commit } = await octokit.git.createCommit({
    owner: orgName,
    repo: targetRepo,
    message: `feat: initial commit — ${title}`,
    tree: tree.sha,
    parents: [],   // initial commit has no parents
  });

  // Create the main branch pointing to this commit
  await octokit.git.createRef({
    owner: orgName,
    repo: targetRepo,
    ref: "refs/heads/main",
    sha: commit.sha,
  });

  console.log(`  ✅  Committed ${treeItems.length} files to ${orgName}/${targetRepo} (${commit.sha.slice(0, 7)})`);
  return commit.sha;
}

/**
 * Commit a minimal README.md to a newly-created but otherwise empty repo.
 * Used as a fallback when a student's zip file is empty or unreadable.
 */
async function commitFallbackReadme(targetRepo, { title, studentName, summary, tech }) {
  const readme = [
    `# ${title}`,
    "",
    `**Student:** ${studentName}`,
    tech.length ? `**Tech Stack:** ${tech.join(", ")}` : "",
    "",
    summary || "_No description provided._",
    "",
    "---",
    `*This repository was automatically created by the [Project Showcase](https://github.com/${owner}/${repo}) pipeline.*`,
    "",
  ].filter(line => line !== undefined).join("\n");

  const { data: blob } = await octokit.git.createBlob({
    owner: orgName,
    repo: targetRepo,
    content: Buffer.from(readme).toString("base64"),
    encoding: "base64",
  });

  const { data: tree } = await octokit.git.createTree({
    owner: orgName,
    repo: targetRepo,
    tree: [{ path: "README.md", mode: "100644", type: "blob", sha: blob.sha }],
  });

  const { data: commit } = await octokit.git.createCommit({
    owner: orgName,
    repo: targetRepo,
    message: `chore: add fallback README — ${title}`,
    tree: tree.sha,
    parents: [],
  });

  await octokit.git.createRef({
    owner: orgName,
    repo: targetRepo,
    ref: "refs/heads/main",
    sha: commit.sha,
  });

  console.log(`  📄  Fallback README committed to ${orgName}/${targetRepo}`);
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
  const newBlobs = [];          // { path, sha, mode, type } — files to commit to showcase repo
  const driveIdsToDelete = [];  // Drive file IDs to purge after commit
  const newProjects = [];       // project objects for projects.json

  for (const row of approved) {
    const name       = (row[col["Student Full Name"]]                  || "").trim();
    const email      = (row[col["Student Email Address"]]              || "").trim();
    const title      = (row[col["Project Title"]]                      || "").trim();
    const domain     = (row[col["Project Domain"]]                     || "").trim();
    const summary    = (row[col["Project Description"]]                || "").trim();
    const githubUrl  = (row[col["GitHub / Source Code URL"]]           || "").trim();
    const demoUrl    = (row[col["Live / Demo URL"]]                    || "").trim();
    const imageUrl   = (row[col["Upload Project Screenshots or Images"]] || "").trim();
    const zipUrl     = (row[col["Upload Project Source Code (Zip file)"]] || "").trim();

    // ── FIX: Skip rows with no project title ─────────────────────
    if (!title) {
      console.warn(`\n⚠  Skipping row for "${name}" — Project Title is blank. Fix it in the sheet.`);
      continue;
    }

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
        console.warn(`  ⚠  Failed to download screenshot (Drive ID: ${imgDriveId}): ${err.message}`);
        console.warn(`      Falling back to default image.`);
        console.warn(`      💡 Ensure the Form's Drive upload folder is shared with the service account.`);
      }
    }

    // ── Zip → Create org repo with unzipped source code ──────────
    let projectRepoUrl = githubUrl;   // default to manually-provided URL
    const zipDriveId = extractDriveId(zipUrl);
    if (zipDriveId) {
      try {
        console.log(`  📥  Downloading zip from Drive…`);
        let zipBuffer = await downloadDriveFile(zipDriveId);

        // Google Drive returns an HTML "virus scan warning" page for large files.
        // Detect and bypass it.
        const prefix = zipBuffer.slice(0, 5).toString("utf8");
        if (prefix.startsWith("<!DOC") || prefix.startsWith("<html")) {
          console.log(`  🔄  Drive returned HTML (large-file warning) — retrying with confirm bypass…`);
          zipBuffer = await downloadDriveFileWithConfirm(zipDriveId);
        }

        // Size gate
        if (zipBuffer.length > MAX_ZIP_BYTES) {
          const sizeMB = (zipBuffer.length / 1024 / 1024).toFixed(1);
          console.warn(`  ⚠  Zip is ${sizeMB} MB — exceeds ${MAX_ZIP_BYTES / 1024 / 1024} MB cap. Skipping.`);
          // Size exceeded — do NOT add to projects.json; retry if student re-uploads smaller zip
          continue;
        }

        const sizeMB = (zipBuffer.length / 1024 / 1024).toFixed(1);
        console.log(`  📦  Zip downloaded (${sizeMB} MB).`);

        // ── Validate the zip BEFORE creating the repo ──────────
        // This ensures we never create a blank repo: if the zip is
        // unreadable or empty, we log and continue (retry next run).
        let zipValid = false;
        try {
          const testZip = new AdmZip(zipBuffer);
          const testEntries = testZip.getEntries().filter(e => !e.isDirectory);
          if (testEntries.length === 0) {
            console.warn(`  ⚠  Zip appears empty (no files found).`);
          } else {
            zipValid = true;
            console.log(`  ✅  Zip looks valid (${testEntries.length} file(s)) — creating org repo…`);
          }
        } catch (zipErr) {
          console.warn(`  ⚠  Zip is invalid or corrupted: ${zipErr.message}`);
        }

        if (!zipValid) {
          // ── FIX: do NOT add to projects.json — retry next sync ──
          console.warn(`  ⏭  NOT adding to projects.json — will retry on next sync run.`);
          continue;
        }

        // Zip is good — create the repo and commit files
        projectRepoUrl = await createProjectRepo(slug, title, summary, name, tech);

        const commitSha = await commitZipToRepo(slug, zipBuffer, {
          title, studentName: name, summary, tech,
        });

        if (commitSha) {
          driveIdsToDelete.push(zipDriveId);
          console.log(`  🎉  Source code live at ${projectRepoUrl}`);
        } else {
          // commitZipToRepo returned null (empty zip slipped through) — safety fallback
          console.warn(`  ⚠  Commit returned null — writing fallback README.`);
          await commitFallbackReadme(slug, { title, studentName: name, summary, tech });
        }

      } catch (err) {
        // ── FIX: do NOT add to projects.json on any error — retries next run ──
        console.warn(`  ❌  Failed processing zip for "${title}": ${err.message}`);
        console.warn(`      💡 Most likely cause: the Drive upload folder is NOT shared with`);
        console.warn(`         your service account. Share the folder and it will work next run.`);
        console.warn(`      ⏭  NOT adding to projects.json — will retry on next sync run.`);
        continue;
      }
    }

    // Build project object
    const project = {
      id: slug,
      title,
      student: name,
      email,
      domain: tech,
      summary,
      image: imagePath,
    };

    // Only add optional URL fields if they have values
    if (projectRepoUrl)  project.github = projectRepoUrl;
    if (demoUrl)         project.demo   = demoUrl;

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

  // 6. Commit everything to the showcase repo in one atomic commit
  const headSha   = await getRef();
  const treeSha   = await createTree(headSha, newBlobs);
  const commitMsg = `feat: add ${newProjects.map(p => p.title).join(", ")}`;
  const commitSha = await createCommit(commitMsg, treeSha, headSha);
  await updateRef(commitSha);
  console.log(`\n✅  Showcase repo updated: ${commitSha}`);

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
