import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CatalogSkill,
  CatalogSkillFileDetail,
  CatalogSkillListQuery,
  CatalogSkillSource,
} from "@paperclipai/shared";
import { HttpError, conflict, notFound, unprocessable } from "../errors.js";
import { ghFetch, resolveRawGitHubUrl } from "./github-fetch.js";
import { normalizePortablePath } from "./portable-path.js";

interface CatalogManifestFile {
  packageName: string;
  packageVersion: string;
  skills: CatalogSkill[];
}

const serviceDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(serviceDir, "../../..");

// Build candidate list for skills-catalog root resolution.
// In monorepo dev: packages/skills-catalog under repo root.
// In esbuild bundle: services/ dir may be inside bundledServer/dist/,
// so also try ../../skills-catalog (bundledServer/skills-catalog/).
// PAPERCLIP_SKILLS_CATALOG_DIR env var overrides all.
function buildCatalogRootCandidates(): string[] {
  const envDir = process.env.PAPERCLIP_SKILLS_CATALOG_DIR?.trim();
  const candidates = [
    ...(envDir ? [path.resolve(envDir)] : []),
    path.resolve(serviceDir, "..", "..", "skills-catalog"),       // bundle: bundledServer/skills-catalog/
    path.resolve(serviceDir, "..", "..", "..", "packages", "skills-catalog"), // monorepo: packages/skills-catalog
  ];
  return Array.from(new Set(candidates));
}

const catalogRootCandidates = buildCatalogRootCandidates();
let catalogPackageRoot = catalogRootCandidates[0]!;
let catalogManifestPath = path.join(catalogPackageRoot, "generated/catalog.json");
let cachedCatalogManifest: {
  manifest: CatalogManifestFile;
  manifestPath: string;
  mtimeMs: number;
  size: number;
} | null = null;

function statCatalogManifest(): { manifestPath: string; mtimeMs: number; size: number } {
  for (const candidateRoot of catalogRootCandidates) {
    const candidatePath = path.join(candidateRoot, "generated/catalog.json");
    try {
      const stats = statSync(candidatePath);
      catalogPackageRoot = candidateRoot;
      catalogManifestPath = candidatePath;
      return { manifestPath: candidatePath, mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      // Try next candidate
    }
  }
  throw new Error(
    `Skills catalog manifest not found. Checked: ${catalogRootCandidates.map((r) => path.join(r, "generated/catalog.json")).join(", ")}. Run pnpm --filter @paperclipai/skills-catalog build:manifest or set PAPERCLIP_SKILLS_CATALOG_DIR.`,
  );
}

function loadCatalogManifest(): CatalogManifestFile {
  const { manifestPath } = statCatalogManifest();
  return JSON.parse(readFileSync(manifestPath, "utf8")) as CatalogManifestFile;
}

function getCatalogManifest() {
  const { manifestPath, mtimeMs, size } = statCatalogManifest();
  if (
    cachedCatalogManifest &&
    cachedCatalogManifest.manifestPath === manifestPath &&
    cachedCatalogManifest.mtimeMs === mtimeMs &&
    cachedCatalogManifest.size === size
  ) {
    return cachedCatalogManifest.manifest;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CatalogManifestFile;
  cachedCatalogManifest = {
    manifest,
    manifestPath,
    mtimeMs,
    size,
  };
  return manifest;
}

function getCatalogSkills() {
  const catalogManifest = getCatalogManifest();
  return catalogManifest.skills.map((skill) => ({
    ...skill,
    packageName: catalogManifest.packageName,
    packageVersion: catalogManifest.packageVersion,
  }));
}

function isMarkdownPath(filePath: string) {
  const fileName = path.posix.basename(filePath).toLowerCase();
  return fileName === "skill.md" || fileName.endsWith(".md");
}

function inferLanguageFromPath(filePath: string) {
  const fileName = path.posix.basename(filePath).toLowerCase();
  if (fileName === "skill.md" || fileName.endsWith(".md")) return "markdown";
  if (fileName.endsWith(".ts")) return "typescript";
  if (fileName.endsWith(".tsx")) return "tsx";
  if (fileName.endsWith(".js")) return "javascript";
  if (fileName.endsWith(".jsx")) return "jsx";
  if (fileName.endsWith(".json")) return "json";
  if (fileName.endsWith(".yml") || fileName.endsWith(".yaml")) return "yaml";
  if (fileName.endsWith(".sh")) return "bash";
  if (fileName.endsWith(".py")) return "python";
  if (fileName.endsWith(".html")) return "html";
  if (fileName.endsWith(".css")) return "css";
  return null;
}

function resolveCatalogPackageRoot() {
  return catalogPackageRoot;
}

function sourceRootPath(source: CatalogSkillSource) {
  return source.path ? normalizePortablePath(source.path) : "";
}

function resolveCatalogSourcePath(source: CatalogSkillSource, relativePath: string) {
  const sourceRoot = sourceRootPath(source);
  return sourceRoot ? `${sourceRoot}/${relativePath}` : relativePath;
}

async function fetchCatalogSourceFile(
  skill: CatalogSkill,
  relativePath: string,
): Promise<Buffer> {
  const source = skill.source;
  if (!source) {
    const packageRoot = resolveCatalogPackageRoot();
    const absolutePath = path.resolve(packageRoot, skill.path, relativePath);
    const skillRoot = path.resolve(packageRoot, skill.path);
    if (absolutePath !== skillRoot && !absolutePath.startsWith(`${skillRoot}${path.sep}`)) {
      throw notFound("Catalog skill file not found");
    }
    return fs.readFile(absolutePath);
  }

  if (source.type !== "github") {
    throw unprocessable(`Unsupported catalog source type: ${(source as { type: string }).type}`);
  }

  const sourcePath = resolveCatalogSourcePath(source, relativePath);
  const url = resolveRawGitHubUrl(source.hostname, source.owner, source.repo, source.commit, sourcePath);
  const response = await ghFetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch pinned catalog file ${sourcePath} from ${source.owner}/${source.repo}@${source.commit}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function readCatalogFileBytes(
  skill: CatalogSkill,
  relativePath: string,
): Promise<Buffer> {
  const fileEntry = skill.files.find((entry) => entry.path === relativePath);
  if (!fileEntry) {
    throw notFound("Catalog skill file not found");
  }

  const bytes = await fetchCatalogSourceFile(skill, relativePath);
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (actualSha !== fileEntry.sha256) {
    throw unprocessable(`Pinned catalog file hash mismatch for ${skill.id}:${relativePath}.`);
  }
  return bytes;
}

function searchText(skill: CatalogSkill) {
  return [
    skill.id,
    skill.key,
    skill.slug,
    skill.name,
    skill.description,
    skill.category,
    skill.kind,
    ...skill.recommendedForRoles,
    ...skill.tags,
  ].join("\n").toLowerCase();
}

export function listCatalogSkills(query: CatalogSkillListQuery = {}): CatalogSkill[] {
  const normalizedQuery = query.q?.trim().toLowerCase() ?? "";
  return getCatalogSkills()
    .filter((skill) => !query.kind || skill.kind === query.kind)
    .filter((skill) => !query.category || skill.category === query.category)
    .filter((skill) => !normalizedQuery || searchText(skill).includes(normalizedQuery))
    .sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
}

export function resolveCatalogSkillReference(reference: string): { skill: CatalogSkill | null; ambiguous: boolean } {
  const trimmed = reference.trim();
  if (!trimmed) return { skill: null, ambiguous: false };
  const catalogSkills = getCatalogSkills();

  const exact = catalogSkills.find((skill) => skill.id === trimmed || skill.key === trimmed);
  if (exact) return { skill: exact, ambiguous: false };

  const slugMatches = catalogSkills.filter((skill) => skill.slug === trimmed);
  if (slugMatches.length === 1) return { skill: slugMatches[0]!, ambiguous: false };
  if (slugMatches.length > 1) return { skill: null, ambiguous: true };
  return { skill: null, ambiguous: false };
}

export function getCatalogSkillOrThrow(reference: string): CatalogSkill {
  const result = resolveCatalogSkillReference(reference);
  if (result.ambiguous) {
    throw conflict(`Catalog skill slug "${reference}" is ambiguous. Use an id or key.`);
  }
  if (!result.skill) {
    throw notFound("Catalog skill not found");
  }
  return result.skill;
}

export async function readCatalogSkillFile(
  reference: string,
  relativePath = "SKILL.md",
): Promise<CatalogSkillFileDetail> {
  const skill = getCatalogSkillOrThrow(reference);
  const normalizedPath = normalizePortablePath(relativePath || "SKILL.md");
  const fileEntry = skill.files.find((entry) => entry.path === normalizedPath);
  if (!fileEntry) {
    throw notFound("Catalog skill file not found");
  }

  if (fileEntry.kind === "asset") {
    throw new HttpError(415, "Catalog asset previews are not supported.");
  }

  const content = (await readCatalogFileBytes(skill, normalizedPath)).toString("utf8");
  return {
    catalogSkillId: skill.id,
    path: normalizedPath,
    kind: fileEntry.kind,
    content,
    language: inferLanguageFromPath(normalizedPath),
    markdown: isMarkdownPath(normalizedPath),
  };
}

export async function copyCatalogSkillFile(reference: string, relativePath: string, targetPath: string): Promise<void> {
  const skill = getCatalogSkillOrThrow(reference);
  const normalizedPath = normalizePortablePath(relativePath || "SKILL.md");
  const fileEntry = skill.files.find((entry) => entry.path === normalizedPath);
  if (!fileEntry) {
    throw notFound("Catalog skill file not found");
  }

  await fs.writeFile(targetPath, await readCatalogFileBytes(skill, normalizedPath));
}

export function getCatalogPackageMetadata() {
  const catalogManifest = getCatalogManifest();
  return {
    packageName: catalogManifest.packageName,
    packageVersion: catalogManifest.packageVersion,
  };
}
